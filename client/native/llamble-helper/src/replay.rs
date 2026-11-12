//! Instant replay: the encoder writes a fragmented MP4 into memory (this byte stream), we keep
//! the last N seconds of it, and save a clip of the last few seconds on request.
//!
//! A fragmented MP4 is: a header (ftyp + moov) once, then fragments (moof + mdat), roughly one
//! per key frame. The encoder is asked for a key frame every second, so a clip can start
//! within about a second of where you asked. Saved clips get their times shifted to start at
//! zero so every player treats them as an ordinary file.

#![cfg(windows)]

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use windows::core::{implement, Result};
use windows::Win32::Foundation::BOOL;
use windows::Win32::Media::MediaFoundation::*;

struct Inner {
    /// bytes not yet sorted into boxes, starting at stream position `pend_at`
    pending: Vec<u8>,
    pend_at: u64,
    pos: u64,
    /// ftyp + moov (and anything before the first fragment)
    init: Vec<u8>,
    /// (when it was finished, where it sat in the stream, moof + mdat)
    frags: VecDeque<(Instant, u64, Vec<u8>)>,
    cur: Vec<u8>,
    cur_at: u64,
    keep: Duration,
    last_written: u32,
}

#[derive(Clone)]
pub struct Buffer(Arc<Mutex<Inner>>);

impl Buffer {
    pub fn new(keep_secs: u64) -> Self {
        Buffer(Arc::new(Mutex::new(Inner {
            pending: Vec::new(),
            pend_at: 0,
            pos: 0,
            init: Vec::new(),
            frags: VecDeque::new(),
            cur: Vec::new(),
            cur_at: 0,
            keep: Duration::from_secs(keep_secs.clamp(5, 600)),
            last_written: 0,
        })))
    }

    /// The byte stream the encoder writes into.
    pub fn stream(&self) -> IMFByteStream {
        Stream(self.clone()).into()
    }

    /// How much is held: (seconds, bytes).
    pub fn held(&self) -> (u64, usize) {
        let g = self.0.lock().unwrap();
        let secs = g.frags.front().map(|(t, _, _)| t.elapsed().as_secs()).unwrap_or(0);
        (secs, g.init.len() + g.frags.iter().map(|(_, _, f)| f.len()).sum::<usize>())
    }

    /// Write the last `secs` seconds to `path` as a normal MP4. Returns the seconds saved.
    pub fn save(&self, path: &str, secs: u64) -> std::io::Result<u64> {
        let (init, frags) = {
            let g = self.0.lock().unwrap();
            let since = Instant::now().checked_sub(Duration::from_secs(secs)).unwrap_or_else(Instant::now);
            let take: Vec<(u64, Vec<u8>)> = g.frags.iter().filter(|(t, _, _)| *t >= since).map(|(_, at, f)| (*at, f.clone())).collect();
            let first = g.frags.iter().find(|(t, _, _)| *t >= since).map(|(t, _, _)| t.elapsed().as_secs()).unwrap_or(0);
            if g.init.is_empty() || take.is_empty() {
                return Err(std::io::Error::new(std::io::ErrorKind::Other, "nothing recorded yet"));
            }
            (g.init.clone(), (take, first))
        };
        let (mut take, got) = frags;
        // start the clip's clock at zero: shift every track's decode times by its first value
        let mut base: Vec<(u32, u64)> = Vec::new();
        let mut out = init;
        for (old_at, f) in &mut take {
            // where this fragment lands in the clip (absolute data offsets must follow it)
            let shift = out.len() as i64 - *old_at as i64;
            rebase(f, &mut base, shift);
            out.extend_from_slice(f);
        }
        std::fs::write(path, out)?;
        Ok(got)
    }

    fn write_at(&self, at: u64, data: &[u8]) {
        let mut g = self.0.lock().unwrap();
        if at < g.pend_at {
            // a rewrite of something already handed on: can't take it back (doesn't happen with fragments)
            return;
        }
        let off = (at - g.pend_at) as usize;
        if g.pending.len() < off + data.len() {
            g.pending.resize(off + data.len(), 0);
        }
        g.pending[off..off + data.len()].copy_from_slice(data);
        g.pos = at + data.len() as u64;
        g.sort();
    }
}

impl Inner {
    /// Hand on every top-level box that's surely finished: the next box has already begun
    /// (the writer may go back and fill in a box's size until then).
    fn sort(&mut self) {
        let mut used = 0usize;
        loop {
            let rest = &self.pending[used..];
            if rest.len() < 8 {
                break;
            }
            let size = u32::from_be_bytes(rest[0..4].try_into().unwrap()) as usize;
            let size = if size == 1 && rest.len() >= 16 { u64::from_be_bytes(rest[8..16].try_into().unwrap()) as usize } else { size };
            if size < 8 || rest.len() < size + 8 {
                break;
            }
            let kind = &rest[4..8];
            let bx = rest[..size].to_vec();
            match kind {
                b"moof" => {
                    if !self.cur.is_empty() {
                        let done = std::mem::take(&mut self.cur);
                        self.frags.push_back((Instant::now(), self.cur_at, done));
                    }
                    self.cur = bx;
                    self.cur_at = self.pend_at + used as u64;
                }
                b"mdat" if !self.cur.is_empty() => self.cur.extend_from_slice(&bx),
                _ if self.frags.is_empty() && self.cur.is_empty() => self.init.extend_from_slice(&bx),
                _ => {}
            }
            used += size;
        }
        if used > 0 {
            self.pending.drain(..used);
            self.pend_at += used as u64;
        }
        // forget what's older than we keep
        while let Some((t, _, _)) = self.frags.front() {
            if t.elapsed() > self.keep {
                self.frags.pop_front();
            } else {
                break;
            }
        }
    }
}

/// Shift the decode time (tfdt) of each track in this fragment so the first fragment starts at
/// 0, and move absolute data offsets (tfhd base-data-offset) by `shift` bytes.
fn rebase(frag: &mut [u8], base: &mut Vec<(u32, u64)>, shift: i64) {
    // moof is first; walk its trafs
    let moof_len = u32::from_be_bytes(frag[0..4].try_into().unwrap()) as usize;
    let mut i = 8;
    while i + 8 <= moof_len {
        let len = u32::from_be_bytes(frag[i..i + 4].try_into().unwrap()) as usize;
        if len < 8 || i + len > moof_len {
            break;
        }
        if &frag[i + 4..i + 8] == b"traf" {
            let (mut track, mut j) = (0u32, i + 8);
            while j + 8 <= i + len {
                let l = u32::from_be_bytes(frag[j..j + 4].try_into().unwrap()) as usize;
                if l < 8 {
                    break;
                }
                match &frag[j + 4..j + 8] {
                    b"tfhd" if l >= 16 => {
                        track = u32::from_be_bytes(frag[j + 12..j + 16].try_into().unwrap());
                        let flags = u32::from_be_bytes(frag[j + 8..j + 12].try_into().unwrap()) & 0xFF_FFFF;
                        if flags & 1 != 0 && l >= 24 {
                            let at = j + 16;
                            let v = u64::from_be_bytes(frag[at..at + 8].try_into().unwrap()) as i64 + shift;
                            frag[at..at + 8].copy_from_slice(&(v.max(0) as u64).to_be_bytes());
                        }
                    }
                    b"tfdt" => {
                        let v1 = frag[j + 8] == 1;
                        let at = j + 12;
                        let t = if v1 { u64::from_be_bytes(frag[at..at + 8].try_into().unwrap()) } else { u32::from_be_bytes(frag[at..at + 4].try_into().unwrap()) as u64 };
                        let b = match base.iter().find(|(k, _)| *k == track) {
                            Some((_, b)) => *b,
                            None => {
                                base.push((track, t));
                                t
                            }
                        };
                        let n = t.saturating_sub(b);
                        if v1 {
                            frag[at..at + 8].copy_from_slice(&n.to_be_bytes());
                        } else {
                            frag[at..at + 4].copy_from_slice(&(n as u32).to_be_bytes());
                        }
                    }
                    _ => {}
                }
                j += l;
            }
        }
        i += len;
    }
}

#[implement(IMFByteStream)]
struct Stream(Buffer);

impl IMFByteStream_Impl for Stream_Impl {
    fn GetCapabilities(&self) -> Result<u32> {
        Ok(MFBYTESTREAM_IS_WRITABLE | MFBYTESTREAM_IS_SEEKABLE)
    }
    fn GetLength(&self) -> Result<u64> {
        let g = self.0 .0.lock().unwrap();
        Ok(g.pend_at + g.pending.len() as u64)
    }
    fn SetLength(&self, _len: u64) -> Result<()> {
        Ok(())
    }
    fn GetCurrentPosition(&self) -> Result<u64> {
        Ok(self.0 .0.lock().unwrap().pos)
    }
    fn SetCurrentPosition(&self, pos: u64) -> Result<()> {
        self.0 .0.lock().unwrap().pos = pos;
        Ok(())
    }
    fn IsEndOfStream(&self) -> Result<BOOL> {
        Ok(true.into())
    }
    fn Read(&self, _pb: *mut u8, _cb: u32, pcbread: *mut u32) -> Result<()> {
        if !pcbread.is_null() {
            unsafe { *pcbread = 0 };
        }
        Ok(())
    }
    fn BeginRead(&self, _pb: *mut u8, _cb: u32, _cb2: Option<&IMFAsyncCallback>, _st: Option<&windows::core::IUnknown>) -> Result<()> {
        Err(windows::Win32::Foundation::E_NOTIMPL.into())
    }
    fn EndRead(&self, _r: Option<&IMFAsyncResult>) -> Result<u32> {
        Err(windows::Win32::Foundation::E_NOTIMPL.into())
    }
    fn Write(&self, pb: *const u8, cb: u32) -> Result<u32> {
        let data = unsafe { std::slice::from_raw_parts(pb, cb as usize) };
        let at = self.0 .0.lock().unwrap().pos;
        self.0.write_at(at, data);
        Ok(cb)
    }
    fn BeginWrite(&self, pb: *const u8, cb: u32, callback: Option<&IMFAsyncCallback>, state: Option<&windows::core::IUnknown>) -> Result<()> {
        let n = self.Write(pb, cb)?;
        self.0 .0.lock().unwrap().last_written = n;
        unsafe {
            let r = MFCreateAsyncResult(None, callback, state)?;
            r.SetStatus(windows::core::HRESULT(0))?;
            MFInvokeCallback(&r)?;
        }
        Ok(())
    }
    fn EndWrite(&self, _r: Option<&IMFAsyncResult>) -> Result<u32> {
        Ok(self.0 .0.lock().unwrap().last_written)
    }
    fn Seek(&self, origin: MFBYTESTREAM_SEEK_ORIGIN, offset: i64, _flags: u32) -> Result<u64> {
        let mut g = self.0 .0.lock().unwrap();
        let from = if origin == msoCurrent { g.pos as i64 } else { 0 };
        g.pos = (from + offset).max(0) as u64;
        Ok(g.pos)
    }
    fn Flush(&self) -> Result<()> {
        Ok(())
    }
    fn Close(&self) -> Result<()> {
        Ok(())
    }
}
