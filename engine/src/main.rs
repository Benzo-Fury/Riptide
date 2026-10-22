//! `undercurrentd`: Riptide's engine process.
//!
//!   undercurrentd --state-dir <DIR>
//!
//! Runs the Undercurrent engine and speaks the JSON-lines protocol in `protocol.rs` on stdin and
//! stdout. The desktop app starts it, and it exits when stdin closes (the app quit or crashed),
//! so it never outlives the app. Diagnostics go to stderr.

mod awake;
mod daemon;
mod library;
mod network;
mod pieces;
mod protocol;
mod settings;
mod tide;

use daemon::{Daemon, Input};
use std::io::BufRead;
use std::path::PathBuf;
use std::process::ExitCode;

fn main() -> ExitCode {
    // Find the state directory
    let args: Vec<String> = std::env::args().collect();
    let Some(dir) = args.iter().position(|a| a == "--state-dir").and_then(|i| args.get(i + 1)).map(PathBuf::from) else {
        eprintln!("usage: undercurrentd --state-dir <DIR>");
        return ExitCode::from(2);
    };

    // Read requests on their own thread, into the daemon's channel
    let (tx, rx) = std::sync::mpsc::channel();
    let stdin_tx = tx.clone();
    std::thread::Builder::new()
        .name("undercurrentd-stdin".into())
        .spawn(move || {
            for line in std::io::stdin().lock().lines() {
                let Ok(line) = line else { break };
                if line.trim().is_empty() {
                    continue;
                }
                match serde_json::from_str(&line) {
                    Ok(request) => {
                        if stdin_tx.send(Input::Request(request)).is_err() {
                            return;
                        }
                    }
                    Err(e) => eprintln!("undercurrentd: ignoring malformed request: {e}"),
                }
            }
            let _ = stdin_tx.send(Input::Closed);
        })
        .expect("spawn stdin thread");

    // Run until the app goes away
    match Daemon::open(&dir, tx) {
        Ok(daemon) => {
            daemon.run(rx);
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("undercurrentd: can't open {}: {e}", dir.display());
            ExitCode::FAILURE
        }
    }
}
