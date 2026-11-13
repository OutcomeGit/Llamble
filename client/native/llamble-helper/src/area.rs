//! Windows that show other windows on top of themselves (Godot plays your game in a separate
//! window laid over its editor; some apps do popups the same way). Capturing just the window
//! misses those, so for them we capture its area of the screen instead.
//!
//! `llamble-helper covers <hwnd>`  → `yes` / `no`
//! `llamble-helper track <hwnd>`   → `rect <left> <top> <right> <bottom> <monitor w> <monitor h>`
//!                                   (on its monitor, real pixels) whenever it moves, `gone` when
//!                                   minimised; until stdin closes

#![cfg(windows)]

use windows::Win32::Foundation::{BOOL, HWND, LPARAM, RECT};
use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS};
use windows::Win32::Graphics::Gdi::{GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST};
use windows::Win32::System::Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS};
use windows::Win32::UI::HiDpi::{SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2};
use windows::Win32::UI::WindowsAndMessaging::{EnumWindows, GetWindowThreadProcessId, IsIconic, IsWindowVisible};

unsafe fn bounds(h: HWND) -> Option<RECT> {
    let mut r = RECT::default();
    DwmGetWindowAttribute(h, DWMWA_EXTENDED_FRAME_BOUNDS, &mut r as *mut _ as *mut _, std::mem::size_of::<RECT>() as u32).ok()?;
    Some(r)
}

/// The process and every process it started (and those started, and so on).
unsafe fn family(root: u32) -> Vec<u32> {
    let mut parents: Vec<(u32, u32)> = Vec::new();
    if let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) {
        let mut e = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
        if Process32FirstW(snap, &mut e).is_ok() {
            loop {
                parents.push((e.th32ProcessID, e.th32ParentProcessID));
                if Process32NextW(snap, &mut e).is_err() {
                    break;
                }
            }
        }
        let _ = windows::Win32::Foundation::CloseHandle(snap);
    }
    let mut fam = vec![root];
    let mut i = 0;
    while i < fam.len() {
        let p = fam[i];
        for (c, par) in &parents {
            if *par == p && !fam.contains(c) {
                fam.push(*c);
            }
        }
        i += 1;
    }
    fam
}

/// Does another visible window of the same program family sit over this one?
pub unsafe fn covers(target: HWND) -> bool {
    let Some(tr) = bounds(target) else { return false };
    let mut pid = 0u32;
    GetWindowThreadProcessId(target, Some(&mut pid));
    struct Ctx {
        target: HWND,
        tr: RECT,
        fam: Vec<u32>,
        hit: bool,
    }
    unsafe extern "system" fn each(h: HWND, lp: LPARAM) -> BOOL {
        let c = &mut *(lp.0 as *mut Ctx);
        if h == c.target || !IsWindowVisible(h).as_bool() || IsIconic(h).as_bool() {
            return true.into();
        }
        let mut cloaked = 0u32;
        let _ = DwmGetWindowAttribute(h, DWMWA_CLOAKED, &mut cloaked as *mut _ as *mut _, 4);
        if cloaked != 0 {
            return true.into();
        }
        let mut p = 0u32;
        GetWindowThreadProcessId(h, Some(&mut p));
        if !c.fam.contains(&p) {
            return true.into();
        }
        if let Some(r) = bounds(h) {
            let (w, hh) = (r.right.min(c.tr.right) - r.left.max(c.tr.left), r.bottom.min(c.tr.bottom) - r.top.max(c.tr.top));
            // a real overlap (not a 1-pixel shadow), inside the target
            if w > 64 && hh > 64 {
                c.hit = true;
                return false.into();
            }
        }
        true.into()
    }
    let mut c = Ctx { target, tr, fam: family(pid), hit: false };
    let _ = EnumWindows(Some(each), LPARAM(&mut c as *mut _ as isize));
    c.hit
}

/// Where the window is on its monitor (real pixels), and the monitor's size; None if minimised.
pub unsafe fn on_monitor(h: HWND) -> Option<(RECT, i32, i32)> {
    if IsIconic(h).as_bool() {
        return None;
    }
    let r = bounds(h)?;
    let mut mi = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
    GetMonitorInfoW(MonitorFromWindow(h, MONITOR_DEFAULTTONEAREST), &mut mi).ok().ok()?;
    let m = mi.rcMonitor;
    Some((RECT { left: (r.left - m.left).max(0), top: (r.top - m.top).max(0), right: (r.right - m.left).min(m.right - m.left), bottom: (r.bottom - m.top).min(m.bottom - m.top) }, m.right - m.left, m.bottom - m.top))
}

pub fn run(cmd: &str, args: &[String]) -> i32 {
    let Some(h) = args.first().and_then(|a| a.parse::<u64>().ok()) else {
        println!("usage: covers|track <hwnd>");
        return 2;
    };
    let hwnd = HWND(h as usize as *mut _);
    unsafe {
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }
    if cmd == "covers" {
        println!("{}", if unsafe { covers(hwnd) } { "yes" } else { "no" });
        return 0;
    }
    // track: report moves until the app closes our stdin
    std::thread::spawn(|| {
        let mut s = String::new();
        while std::io::stdin().read_line(&mut s).map(|n| n > 0).unwrap_or(false) {
            s.clear();
        }
        std::process::exit(0);
    });
    let mut last = String::new();
    loop {
        let now = match unsafe { on_monitor(hwnd) } {
            Some((r, mw, mh)) => format!("rect {} {} {} {} {mw} {mh}", r.left, r.top, r.right, r.bottom),
            None => "gone".to_string(),
        };
        if now != last {
            println!("{now}");
            use std::io::Write;
            let _ = std::io::stdout().flush();
            last = now;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
}
