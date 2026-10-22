//! The wire protocol between the desktop app and this process: one JSON object per line.
//!
//! The app writes requests to stdin (`{"id": 7, "method": "add", "params": {…}}`). This process
//! answers each one exactly once on stdout (`{"type": "response", "id": 7, "ok": true, "result": …}`)
//! and, independently, pushes events (`{"type": "event", "name": "snapshot", "data": …}`).

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::Write;

// ---------- Incoming ---------- //

/// One request from the app. `params` is decoded per method by the daemon.
#[derive(Debug, Deserialize)]
pub struct Request {
    pub id: u64,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

/// Where a torrent comes from when inspecting or adding it.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TorrentSource {
    /// A `.torrent` file on disk.
    File { path: String },
    /// A `.torrent` file's bytes, base64-encoded (dropped onto the window, for example).
    Bytes { base64: String },
    Magnet { uri: String },
}

// ---------- Outgoing ---------- //

/// Everything this process writes to stdout.
#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Outgoing<'a> {
    Response {
        id: u64,
        ok: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        result: Option<Value>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    Event { name: &'a str, data: Value },
}

/// Writes protocol messages to stdout, one line each, flushed immediately so the app sees them
/// without delay. Only the daemon's main thread writes, so no locking beyond stdout's own.
pub struct Writer {
    out: std::io::Stdout,
}

impl Writer {
    /// A writer on this process's stdout.
    pub fn new() -> Writer {
        Writer { out: std::io::stdout() }
    }

    /// Answers request `id` with a result or an error message.
    pub fn respond(&self, id: u64, result: Result<Value, String>) {
        let msg = match result {
            Ok(v) => Outgoing::Response { id, ok: true, result: Some(v), error: None },
            Err(e) => Outgoing::Response { id, ok: false, result: None, error: Some(e) },
        };
        self.write(&msg);
    }

    /// Pushes an unsolicited event.
    pub fn event(&self, name: &str, data: Value) {
        self.write(&Outgoing::Event { name, data });
    }

    /// Serializes one message as a line. A closed stdout means the app is gone, so writes that
    /// fail are dropped; the stdin reader notices the same thing and ends the process.
    fn write(&self, msg: &Outgoing) {
        let mut out = self.out.lock();
        if serde_json::to_writer(&mut out, msg).is_ok() {
            let _ = out.write_all(b"\n");
            let _ = out.flush();
        }
    }
}
