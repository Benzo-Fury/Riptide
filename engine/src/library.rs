//! The library: which torrents the user has added and how, persisted so they come back after a
//! restart. Undercurrent's resume state records verified pieces; the library records everything else
//! (the `.torrent` bytes, the save folder, the selection, whether it was paused).
//!
//! Layout inside the state directory:
//! - `library.json`: the entries
//! - `torrents/<hash>.torrent`: each torrent's metainfo (written from fetched metadata for magnets)
//! - `resume/<hash>.resume`: Undercurrent's own resume files

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

// ---------- Entries ---------- //

/// One torrent the user added.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    /// Lowercase hex info hash; also the key.
    pub hash: String,
    pub name: String,
    /// The save folder.
    pub dir: String,
    /// Unix milliseconds.
    pub added_at: u64,
    #[serde(default)]
    pub completed_at: Option<u64>,
    /// Paused by the user. Survives restarts.
    #[serde(default)]
    pub paused: bool,
    /// Paused by the download queue rather than the user; resumed when a slot frees.
    #[serde(default)]
    pub queued: bool,
    /// Selected file indexes; `None` means all.
    #[serde(default)]
    pub files: Option<Vec<usize>>,
    /// Waiting for the user to pick files once metadata arrives.
    #[serde(default)]
    pub metadata_only: bool,
    /// The magnet link it was added from, if any; used until metadata is saved.
    #[serde(default)]
    pub magnet: Option<String>,
    /// Trackers beyond those in the metainfo (a magnet's `tr=` list), re-added on restore.
    #[serde(default)]
    pub trackers: Vec<String>,
    /// Per-torrent limits in bytes per second; 0 is unlimited.
    #[serde(default)]
    pub download_limit: u64,
    #[serde(default)]
    pub upload_limit: u64,
    /// Added in seed mode (files trusted, checked as uploaded).
    #[serde(default)]
    pub seed_mode: bool,
}

// ---------- Library ---------- //

/// The persisted set of entries, keyed by hash. Changes mark it dirty; `save_if_dirty` writes
/// it at most once per daemon tick.
pub struct Library {
    dir: PathBuf,
    entries: BTreeMap<String, Entry>,
    dirty: bool,
}

impl Library {
    /// Opens the library in `dir`, creating its folders. A missing or unreadable `library.json`
    /// is an empty library.
    pub fn open(dir: &Path) -> std::io::Result<Library> {
        // Make sure the folders exist
        std::fs::create_dir_all(dir.join("torrents"))?;
        std::fs::create_dir_all(dir.join("resume"))?;

        // Read whatever entries were saved
        let entries: Vec<Entry> = std::fs::read(dir.join("library.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        Ok(Library { dir: dir.to_path_buf(), entries: entries.into_iter().map(|e| (e.hash.clone(), e)).collect(), dirty: false })
    }

    /// Entries in the order they were added.
    pub fn entries(&self) -> Vec<Entry> {
        let mut v: Vec<Entry> = self.entries.values().cloned().collect();
        v.sort_by_key(|e| e.added_at);
        v
    }

    pub fn get(&self, hash: &str) -> Option<&Entry> {
        self.entries.get(hash)
    }

    /// Changes an entry in place and marks the library dirty. Returns false when there's no
    /// such entry.
    pub fn update(&mut self, hash: &str, change: impl FnOnce(&mut Entry)) -> bool {
        match self.entries.get_mut(hash) {
            Some(e) => {
                change(e);
                self.dirty = true;
                true
            }
            None => false,
        }
    }

    /// Adds or replaces an entry.
    pub fn insert(&mut self, entry: Entry) {
        self.entries.insert(entry.hash.clone(), entry);
        self.dirty = true;
    }

    /// Forgets an entry and its saved metainfo and resume state.
    pub fn remove(&mut self, hash: &str) {
        if self.entries.remove(hash).is_some() {
            self.dirty = true;
        }
        let _ = std::fs::remove_file(self.torrent_path(hash));
        let _ = std::fs::remove_file(self.resume_dir().join(format!("{hash}.resume")));
    }

    /// The saved `.torrent` for a hash, if there is one.
    pub fn torrent_bytes(&self, hash: &str) -> Option<Vec<u8>> {
        std::fs::read(self.torrent_path(hash)).ok()
    }

    /// Saves a torrent's metainfo. Called on add for `.torrent` sources and when a magnet's
    /// metadata arrives.
    pub fn save_torrent(&self, hash: &str, bytes: &[u8]) -> std::io::Result<()> {
        let tmp = self.dir.join("torrents").join(format!("{hash}.tmp"));
        std::fs::write(&tmp, bytes)?;
        std::fs::rename(tmp, self.torrent_path(hash))
    }

    pub fn has_torrent(&self, hash: &str) -> bool {
        self.torrent_path(hash).exists()
    }

    pub fn torrent_path(&self, hash: &str) -> PathBuf {
        self.dir.join("torrents").join(format!("{hash}.torrent"))
    }

    pub fn resume_dir(&self) -> PathBuf {
        self.dir.join("resume")
    }

    /// Writes `library.json` atomically when something changed since the last write.
    pub fn save_if_dirty(&mut self) -> std::io::Result<()> {
        if !self.dirty {
            return Ok(());
        }
        let tmp = self.dir.join("library.json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(&self.entries())?)?;
        std::fs::rename(tmp, self.dir.join("library.json"))?;
        self.dirty = false;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(hash: &str, added_at: u64) -> Entry {
        Entry {
            hash: hash.into(),
            name: hash.into(),
            dir: "/tmp".into(),
            added_at,
            completed_at: None,
            paused: false,
            queued: false,
            files: None,
            metadata_only: false,
            magnet: None,
            trackers: vec![],
            download_limit: 0,
            upload_limit: 0,
            seed_mode: false,
        }
    }

    #[test]
    fn entries_survive_a_reopen_in_added_order() {
        let dir = tempfile::tempdir().unwrap();
        let mut lib = Library::open(dir.path()).unwrap();
        lib.insert(entry("bb", 2));
        lib.insert(entry("aa", 3));
        lib.insert(entry("cc", 1));
        lib.update("bb", |e| e.paused = true);
        lib.save_if_dirty().unwrap();
        let back = Library::open(dir.path()).unwrap();
        let hashes: Vec<String> = back.entries().into_iter().map(|e| e.hash).collect();
        assert_eq!(hashes, ["cc", "bb", "aa"]);
        assert!(back.get("bb").unwrap().paused);
    }

    #[test]
    fn remove_deletes_saved_files() {
        let dir = tempfile::tempdir().unwrap();
        let mut lib = Library::open(dir.path()).unwrap();
        lib.insert(entry("aa", 1));
        lib.save_torrent("aa", b"d4:infodee").unwrap();
        std::fs::write(lib.resume_dir().join("aa.resume"), b"x").unwrap();
        lib.remove("aa");
        assert!(!lib.has_torrent("aa"));
        assert!(!lib.resume_dir().join("aa.resume").exists());
        assert!(lib.get("aa").is_none());
    }
}
