//! llamble-helper: answers the Llamble app's questions about this PC.
//!
//! Commands (one per line on stdin), each answered with one JSON line on stdout:
//!   windows  -> [{"pid":1,"exe":"robloxplayerbeta","path":"C:\\...","title":"Roblox","hwnd":123}]
//!   gpus     -> [{"name":"NVIDIA GeForce RTX 4090","vram_mb":24564,"vendor":4318}]
//!   exit
//!
//! It only reads: window titles, which program owns each window and where that
//! program is installed, and the graphics adapters Windows reports. It never opens
//! other programs' memory, never runs anything, and never touches files.

use std::io::{BufRead, Write};

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
    let stdin = std::io::stdin();
    let mut out = std::io::stdout().lock();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let answer = match line.trim() {
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
