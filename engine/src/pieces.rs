//! The piece map shown in the app's Pieces tab.
//!
//! Undercurrent keeps its verified-piece bitfield private, so the daemon rebuilds it from what is
//! public: the bitfield in the torrent's resume file at startup, files that are fully verified,
//! and a `Piece` event for every piece verified since. Bits are only ever set from evidence, so
//! the map can under-report a piece (never over-report one) until the next resume save.

use undercurrent::{FileStatus, Info};
use std::path::Path;

/// A bitset of verified pieces in BitTorrent wire order (piece 0 is the high bit of byte 0).
#[derive(Debug, Clone, PartialEq)]
pub struct PieceMap {
    bits: Vec<u8>,
    count: u32,
}

impl PieceMap {
    /// An empty map for `count` pieces.
    pub fn new(count: u32) -> PieceMap {
        PieceMap { bits: vec![0; count.div_ceil(8) as usize], count }
    }

    pub fn count(&self) -> u32 {
        self.count
    }

    /// Marks one verified piece. Out-of-range indexes are ignored.
    pub fn set(&mut self, i: u32) {
        if i < self.count {
            self.bits[(i / 8) as usize] |= 0x80 >> (i % 8);
        }
    }

    pub fn has(&self, i: u32) -> bool {
        i < self.count && self.bits[(i / 8) as usize] & (0x80 >> (i % 8)) != 0
    }

    /// Marks every piece, for a torrent known to be complete.
    pub fn set_all(&mut self) {
        for i in 0..self.count {
            self.set(i);
        }
    }

    pub fn set_count(&self) -> u32 {
        (0..self.count).filter(|&i| self.has(i)).count() as u32
    }

    /// Ors in the bitfield from an Undercurrent resume file, when there is one of the right size.
    pub fn merge_resume(&mut self, path: &Path) {
        let Some(bitfield) = std::fs::read(path).ok().and_then(|b| resume_bitfield(&b)) else { return };
        if bitfield.len() == self.bits.len() {
            for (mine, theirs) in self.bits.iter_mut().zip(bitfield) {
                *mine |= theirs;
            }
        }
    }

    /// Marks every piece whose bytes all belong to fully verified files. Pieces that touch a
    /// file still missing data stay as they are.
    pub fn merge_complete_files(&mut self, info: &Info, files: &[FileStatus]) {
        // Pieces touching any incomplete file can't be inferred
        let mut unknown = vec![false; self.count as usize];
        for (entry, status) in info.files.iter().zip(files) {
            if status.downloaded < status.length && entry.length > 0 {
                let first = (entry.offset / info.piece_length) as usize;
                let last = ((entry.offset + entry.length - 1) / info.piece_length) as usize;
                for u in unknown.iter_mut().take(last + 1).skip(first) {
                    *u = true;
                }
            }
        }

        // Everything else is covered by complete files (or padding)
        for (i, u) in unknown.iter().enumerate() {
            if !u {
                self.set(i as u32);
            }
        }
    }

    pub fn as_bytes(&self) -> &[u8] {
        &self.bits
    }
}

// ---------- Resume file ---------- //

/// The `bitfield` value of an Undercurrent resume file: a bencoded dictionary at the top level. Only
/// enough bencode is decoded to walk the dictionary; anything malformed gives `None`.
fn resume_bitfield(buf: &[u8]) -> Option<Vec<u8>> {
    if buf.first() != Some(&b'd') {
        return None;
    }
    let mut pos = 1;
    while buf.get(pos)? != &b'e' {
        // Each key is a byte string, followed by its value
        let (key, after_key) = byte_string(buf, pos)?;
        if key == b"bitfield" {
            return byte_string(buf, after_key).map(|(v, _)| v.to_vec());
        }
        pos = skip_value(buf, after_key)?;
    }
    None
}

/// A `<len>:<bytes>` string at `pos`, and the position after it.
fn byte_string(buf: &[u8], pos: usize) -> Option<(&[u8], usize)> {
    let colon = pos + buf.get(pos..)?.iter().position(|&b| b == b':')?;
    let len: usize = std::str::from_utf8(&buf[pos..colon]).ok()?.parse().ok()?;
    let start = colon + 1;
    let end = start.checked_add(len)?;
    Some((buf.get(start..end)?, end))
}

/// The position after the bencoded value at `pos`.
fn skip_value(buf: &[u8], pos: usize) -> Option<usize> {
    match buf.get(pos)? {
        // Integer: i<digits>e
        b'i' => Some(pos + buf.get(pos..)?.iter().position(|&b| b == b'e')? + 1),
        // List or dictionary: values until the closing e
        b'l' | b'd' => {
            let mut p = pos + 1;
            while buf.get(p)? != &b'e' {
                p = skip_value(buf, p)?;
            }
            Some(p + 1)
        }
        // Byte string
        _ => byte_string(buf, pos).map(|(_, end)| end),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bits_are_in_wire_order() {
        let mut m = PieceMap::new(10);
        m.set(0);
        m.set(9);
        m.set(10);
        assert_eq!(m.as_bytes(), &[0x80, 0x40]);
        assert_eq!(m.set_count(), 2);
        m.set_all();
        assert_eq!(m.set_count(), 10);
    }

    #[test]
    fn reads_the_bitfield_from_a_resume_file() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("x.resume");
        // Keys in sorted order, as Undercurrent writes them, with a list and ints before the bitfield
        std::fs::write(&p, b"d8:bitfield2:\xf0\x01e").unwrap();
        let mut m = PieceMap::new(16);
        m.merge_resume(&p);
        assert!(m.has(0) && m.has(3) && !m.has(4) && m.has(15));
        std::fs::write(&p, b"d1:ali1ei2ee8:bitfield1:\x80e").unwrap();
        let mut m = PieceMap::new(8);
        m.merge_resume(&p);
        assert!(m.has(0) && !m.has(1));
    }

    #[test]
    fn rejects_malformed_resume_data() {
        assert_eq!(resume_bitfield(b"garbage"), None);
        assert_eq!(resume_bitfield(b"d8:bitfield99:abc"), None);
        assert_eq!(resume_bitfield(b"d3:fooi1e"), None);
    }
}
