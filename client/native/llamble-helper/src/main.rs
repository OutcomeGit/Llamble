//! llamble-helper: answers the Llamble app's questions about this PC.
//!
//! Commands (one per line on stdin), each answered with one JSON line on stdout:
//!   windows  -> [{"pid":1,"exe":"robloxplayerbeta","path":"C:\\...","title":"Roblox","hwnd":123}]
//!   gpus     -> [{"name":"NVIDIA GeForce RTX 4090","vram_mb":24564,"vendor":4318}]
//!   mem 1234 5678 -> [{"pid":1234,"mb":52}]   (memory in use by those programs, for Settings → About)
//!   exit
//!
//! Push-to-talk mode: `llamble-helper ptt <virtual-key>` watches that ONE key (or mouse
//! button) and prints "down" / "up" when it changes, so push-to-talk works while a game
//! has focus. It reads no other keys and records nothing. Exits when stdin closes.
//!
//! Sound mode: `llamble-helper audio window <hwnd>` (or `app <pid>` / `except <pid>`)
//! streams that one program's sound for a screen share (see audio.rs).
//!
//! It only reads: window titles, which program owns each window and where that
//! program is installed, and the graphics adapters Windows reports. It never opens
//! other programs' memory, never runs anything, and never touches files.

use std::io::{BufRead, Write};

#[cfg(windows)]
mod audio;
#[cfg(windows)]
mod area;
#[cfg(windows)]
mod convert;
#[cfg(windows)]
mod record;
#[cfg(windows)]
mod replay;

fn esc(s: &str) -> String {
    let mut o = String::with_capacity(s.len() + 2);
    o.push('"');
    for c in s.chars() {
        match c {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            c if (c as u32) < 0x20 => o.push_str(&format!("\\u{:04x}", c as u32)),
            c => o.push(c),
        }
    }
    o.push('"');
    o
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if let Some(cmd @ ("covers" | "track")) = args.get(1).map(String::as_str) {
        #[cfg(windows)]
        std::process::exit(area::run(cmd, &args[2..]));
        #[cfg(not(windows))]
        {
            let _ = cmd;
            std::process::exit(2);
        }
    }
    if args.get(1).map(String::as_str) == Some("replay") {
        #[cfg(windows)]
        std::process::exit(record::run_replay(&args[2..]));
        #[cfg(not(windows))]
        std::process::exit(2);
    }
    if args.get(1).map(String::as_str) == Some("record") {
        #[cfg(windows)]
        std::process::exit(record::run(&args[2..]));
        #[cfg(not(windows))]
        std::process::exit(2);
    }
    if args.get(1).map(String::as_str) == Some("audio") {
        #[cfg(windows)]
        std::process::exit(audio::run(&args[2..]));
        #[cfg(not(windows))]
        std::process::exit(2);
    }
    if args.get(1).map(String::as_str) == Some("ptt") {
        let vk: i32 = args.get(2).and_then(|v| v.parse().ok()).unwrap_or(0);
        if !(1..=254).contains(&vk) {
            eprintln!("usage: llamble-helper ptt <virtual-key 1-254>");
            std::process::exit(2);
        }
        // the app closes our stdin when it no longer needs us
        std::thread::spawn(|| {
            let mut sink = String::new();
            while std::io::stdin().read_line(&mut sink).map(|n| n > 0).unwrap_or(false) {
                sink.clear();
            }
            std::process::exit(0);
        });
        let mut out = std::io::stdout().lock();
        let mut was = false;
        loop {
            let down = sys::key_down(vk);
            if down != was {
                was = down;
                if writeln!(out, "{}", if down { "down" } else { "up" }).and_then(|_| out.flush()).is_err() {
                    return;
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(8));
        }
    }
    let stdin = std::io::stdin();
    let mut out = std::io::stdout().lock();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let t = line.trim();
        let answer = match t {
            _ if t.starts_with("mem ") => sys::mem(&t[4..].split_whitespace().filter_map(|p| p.parse().ok()).take(32).collect::<Vec<u32>>()),
            "windows" => sys::windows(),
            "gpus" => sys::gpus(),
            "exit" => break,
            "" => continue,
            _ => "null".to_string(),
        };
        if writeln!(out, "{answer}").and_then(|_| out.flush()).is_err() {
            break;
        }
    }
}

#[cfg(windows)]
mod sys {
    use super::esc;
    use std::collections::HashSet;
    use windows::core::PWSTR;
    use windows::Win32::Foundation::{CloseHandle, BOOL, HWND, LPARAM};
    use windows::Win32::Graphics::Dxgi::{CreateDXGIFactory1, IDXGIFactory1, DXGI_ADAPTER_FLAG_SOFTWARE};
    use windows::Win32::System::ProcessStatus::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS, PROCESS_MEMORY_COUNTERS_EX};
    use windows::Win32::System::Threading::{OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION};
    use windows::Win32::UI::WindowsAndMessaging::{EnumWindows, GetWindow, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId, IsWindowVisible, GW_OWNER};

    struct Found {
        pid: u32,
        hwnd: isize,
        title: String,
    }

    unsafe extern "system" fn each(hwnd: HWND, lp: LPARAM) -> BOOL {
        let list = &mut *(lp.0 as *mut Vec<Found>);
        // the same windows that show in the taskbar / Alt+Tab: visible, top-level, not owned by another window
        if !IsWindowVisible(hwnd).as_bool() {
            return true.into();
        }
        if GetWindow(hwnd, GW_OWNER).map(|o| !o.is_invalid()).unwrap_or(false) {
            return true.into();
        }
        let len = GetWindowTextLengthW(hwnd);
        if len <= 0 {
            return true.into();
        }
        let mut buf = vec![0u16; len as usize + 1];
        let n = GetWindowTextW(hwnd, &mut buf);
        let title = String::from_utf16_lossy(&buf[..n.max(0) as usize]);
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid != 0 {
            list.push(Found { pid, hwnd: hwnd.0 as isize, title });
        }
        true.into()
    }

    fn exe_path(pid: u32) -> Option<String> {
        unsafe {
            let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
            let mut buf = vec![0u16; 32768];
            let mut size = buf.len() as u32;
            let ok = QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut size).is_ok();
            let _ = CloseHandle(h);
            ok.then(|| String::from_utf16_lossy(&buf[..size as usize]))
        }
    }

    pub fn windows() -> String {
        let mut found: Vec<Found> = Vec::new();
        unsafe {
            let _ = EnumWindows(Some(each), LPARAM(&mut found as *mut _ as isize));
        }
        let mut seen = HashSet::new();
        let mut items = Vec::new();
        for f in found {
            // one window per program (its first, usually the main one)
            if !seen.insert(f.pid) {
                continue;
            }
            let path = exe_path(f.pid).unwrap_or_default();
            let exe = path
                .rsplit(['\\', '/'])
                .next()
                .unwrap_or("")
                .trim_end_matches(".exe")
                .trim_end_matches(".EXE")
                .to_lowercase();
            if exe.is_empty() {
                continue;
            }
            items.push(format!(
                "{{\"pid\":{},\"exe\":{},\"path\":{},\"title\":{},\"hwnd\":{}}}",
                f.pid,
                esc(&exe),
                esc(&path),
                esc(&f.title),
                f.hwnd
            ));
        }
        format!("[{}]", items.join(","))
    }

    pub fn key_down(vk: i32) -> bool {
        // high bit = held right now; only this one key is checked
        unsafe { (windows::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState(vk) as u16) & 0x8000 != 0 }
    }

    pub fn mem(pids: &[u32]) -> String {
        let mut items = Vec::new();
        for &pid in pids {
            unsafe {
                let Ok(h) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else { continue };
                // private memory (PrivateUsage), like Task Manager, not the working set (which
                // includes memory shared with other programs)
                let mut c = PROCESS_MEMORY_COUNTERS_EX { cb: std::mem::size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32, ..Default::default() };
                if GetProcessMemoryInfo(h, &mut c as *mut PROCESS_MEMORY_COUNTERS_EX as *mut PROCESS_MEMORY_COUNTERS, c.cb).is_ok() {
                    items.push(format!("{{\"pid\":{},\"mb\":{}}}", pid, c.PrivateUsage / (1024 * 1024)));
                }
                let _ = CloseHandle(h);
            }
        }
        format!("[{}]", items.join(","))
    }

    pub fn gpus() -> String {
        let mut items = Vec::new();
        unsafe {
            let Ok(factory) = CreateDXGIFactory1::<IDXGIFactory1>() else { return "[]".into() };
            let mut i = 0;
            while let Ok(adapter) = factory.EnumAdapters1(i) {
                i += 1;
                let Ok(d) = adapter.GetDesc1() else { continue };
                if d.Flags & (DXGI_ADAPTER_FLAG_SOFTWARE.0 as u32) != 0 {
                    continue; // "Microsoft Basic Render Driver"
                }
                let end = d.Description.iter().position(|&c| c == 0).unwrap_or(d.Description.len());
                let name = String::from_utf16_lossy(&d.Description[..end]);
                items.push(format!(
                    "{{\"name\":{},\"vram_mb\":{},\"vendor\":{}}}",
                    esc(&name),
                    d.DedicatedVideoMemory / (1024 * 1024),
                    d.VendorId
                ));
            }
        }
        format!("[{}]", items.join(","))
    }
}

#[cfg(not(windows))]
mod sys {
    pub fn key_down(_vk: i32) -> bool {
        false
    }
    pub fn mem(_pids: &[u32]) -> String {
        "[]".into()
    }
    pub fn windows() -> String {
        "[]".into()
    }
    pub fn gpus() -> String {
        "[]".into()
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn json_escaping() {
        assert_eq!(super::esc("a\"b\\c\n"), "\"a\\\"b\\\\c\\u000a\"");
    }
}
