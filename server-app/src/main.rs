//! Llamble Server for Windows: the same Llamble server that runs on a NAS, running on this PC.
//!
//! This small tray app starts the bundled server (`bin\llamble-server.exe`, with its voice
//! server, AI and ffmpeg next to it), restarts it if it stops, and puts a few things in the
//! tray menu: open Llamble, copy the address for others, start with Windows, logs, quit.
//! Everything Llamble keeps lives in %LOCALAPPDATA%\Llamble Server.
#![cfg_attr(windows, windows_subsystem = "windows")]

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::net::{TcpStream, UdpSocket};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tao::event::{Event, StartCause};
use tao::event_loop::{ControlFlow, EventLoopBuilder};
use tray_icon::menu::{CheckMenuItem, Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tray_icon::{Icon, TrayIconBuilder};

/// The port people connect to (the same one the NAS install uses).
const PORT: u16 = 8090;
const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
const RUN_NAME: &str = "Llamble Server";
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

struct Shared {
    quitting: AtomicBool,
    restart: AtomicBool,
    pid: AtomicU32,
    status: Mutex<String>,
}

fn main() {
    let install = std::env::current_exe().ok().and_then(|p| p.parent().map(Path::to_path_buf)).unwrap_or_else(|| PathBuf::from("."));
    let home = data_home();
    let _ = fs::create_dir_all(home.join("data"));
    // one copy at a time: the second one just opens Llamble in the browser
    let _lock = match single_instance(&home) {
        Some(l) => l,
        None => {
            open_url(&address());
            return;
        }
    };
    let background = std::env::args().any(|a| a == "--background");

    let shared = Arc::new(Shared { quitting: AtomicBool::new(false), restart: AtomicBool::new(false), pid: AtomicU32::new(0), status: Mutex::new("Starting…".into()) });
    {
        let shared = shared.clone();
        let install = install.clone();
        let home = home.clone();
        std::thread::spawn(move || supervise(&install, &home, &shared));
    }

    let event_loop = EventLoopBuilder::new().build();
    let status = MenuItem::new("Llamble Server: starting…", false, None);
    let open = MenuItem::new("Open Llamble", true, None);
    let copy = MenuItem::new("Copy the address for others", true, None);
    let autostart = CheckMenuItem::new("Start with Windows", true, autostart_on(), None);
    let restart = MenuItem::new("Restart the server", true, None);
    let folder = MenuItem::new("Open the data folder", true, None);
    let log = MenuItem::new("Open the log", true, None);
    let quit = MenuItem::new("Quit (stops the server)", true, None);
    let menu = Menu::new();
    let _ = menu.append_items(&[
        &status,
        &PredefinedMenuItem::separator(),
        &open,
        &copy,
        &PredefinedMenuItem::separator(),
        &autostart,
        &restart,
        &folder,
        &log,
        &PredefinedMenuItem::separator(),
        &quit,
    ]);

    let mut tray = None;
    let mut opened_once = background;
    let mut last_status = String::new();
    let mut next_check = Instant::now();
    event_loop.run(move |event, _, flow| {
        *flow = ControlFlow::WaitUntil(Instant::now() + Duration::from_millis(300));
        if let Event::NewEvents(StartCause::Init) = event {
            // the tray icon has to be made once the event loop is running
            tray = TrayIconBuilder::new()
                .with_menu(Box::new(menu.clone()))
                .with_tooltip("Llamble Server")
                .with_icon(tray_icon())
                .build()
                .ok();
        }
        while let Ok(ev) = MenuEvent::receiver().try_recv() {
            if ev.id == open.id() {
                open_url(&address());
            } else if ev.id == copy.id() {
                let a = address();
                copy_text(&a);
                status.set_text(format!("Copied: {a}"));
                last_status.clear();
            } else if ev.id == autostart.id() {
                set_autostart(autostart.is_checked());
            } else if ev.id == restart.id() {
                shared.restart.store(true, Ordering::SeqCst);
                kill_tree(shared.pid.load(Ordering::SeqCst));
            } else if ev.id == folder.id() {
                open_path(&home);
            } else if ev.id == log.id() {
                open_path(&home.join("server.log"));
            } else if ev.id == quit.id() {
                shared.quitting.store(true, Ordering::SeqCst);
                kill_tree(shared.pid.load(Ordering::SeqCst));
                tray.take();
                *flow = ControlFlow::Exit;
                return;
            }
        }
        if Instant::now() >= next_check {
            next_check = Instant::now() + Duration::from_secs(2);
            let up = TcpStream::connect_timeout(&([127, 0, 0, 1], PORT).into(), Duration::from_millis(300)).is_ok();
            let text = if up { format!("Llamble Server: running at {}", address()) } else { format!("Llamble Server: {}", shared.status.lock().unwrap()) };
            if text != last_status {
                status.set_text(&text);
                if let Some(t) = &tray {
                    let _ = t.set_tooltip(Some(&text));
                }
                last_status = text;
            }
            // first start: open Llamble (the setup wizard on a new install) once it answers
            if up && !opened_once {
                opened_once = true;
                open_url(&address());
            }
        }
    });
}

/// Starts the server and keeps it running until Quit.
fn supervise(install: &Path, home: &Path, sh: &Shared) {
    let mut backoff = 2;
    while !sh.quitting.load(Ordering::SeqCst) {
        *sh.status.lock().unwrap() = "starting…".into();
        let started = Instant::now();
        match spawn_server(install, home) {
            Ok(mut child) => {
                sh.pid.store(child.id(), Ordering::SeqCst);
                let code = child.wait().ok().and_then(|s| s.code());
                sh.pid.store(0, Ordering::SeqCst);
                if sh.quitting.load(Ordering::SeqCst) {
                    break;
                }
                log_line(home, &format!("server stopped (exit code {code:?})"));
                *sh.status.lock().unwrap() = "stopped, restarting…".into();
            }
            Err(e) => {
                log_line(home, &format!("couldn't start the server: {e}"));
                *sh.status.lock().unwrap() = format!("couldn't start ({e})");
            }
        }
        if sh.restart.swap(false, Ordering::SeqCst) || started.elapsed() > Duration::from_secs(60) {
            backoff = 2;
        } else {
            backoff = (backoff * 2).min(30);
        }
        for _ in 0..backoff * 10 {
            if sh.quitting.load(Ordering::SeqCst) || sh.restart.load(Ordering::SeqCst) {
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    }
}

fn spawn_server(install: &Path, home: &Path) -> std::io::Result<Child> {
    let log = OpenOptions::new().create(true).append(true).open(home.join("server.log"))?;
    let path = std::env::var("PATH").unwrap_or_default();
    let mut cmd = Command::new(install.join("bin").join("llamble-server.exe"));
    cmd.current_dir(home)
        .env("LLAMBLE_DATA", home.join("data"))
        .env("LLAMBLE_BIND", format!("0.0.0.0:{PORT}"))
        .env("LLAMBLE_WEB_DIR", install.join("web"))
        .env("LLAMBLE_LIVEKIT_BIN", install.join("livekit").join("livekit-server.exe"))
        .env("LLAMBLE_LLAMA_BIN", install.join("llama").join("llama-server.exe"))
        // the server runs ffmpeg/ffprobe by name for video thumbnails
        .env("PATH", format!("{};{path}", install.join("ffmpeg").display()))
        .env("RUST_LOG", "info")
        .stdin(Stdio::null())
        .stdout(log.try_clone()?)
        .stderr(log);
    if let Ok(v) = fs::read_to_string(install.join("version.txt")) {
        cmd.env("LLAMBLE_VERSION", v.trim());
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.spawn()
}

/// Stops the server along with the voice server and AI it started.
fn kill_tree(pid: u32) {
    if pid == 0 {
        return;
    }
    let mut cmd = Command::new("taskkill");
    cmd.args(["/T", "/F", "/PID", &pid.to_string()]).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let _ = cmd.status();
}

fn data_home() -> PathBuf {
    let base = std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("."));
    base.join("Llamble Server")
}

/// Holds a file open with no sharing: a second copy of the app can't open it.
fn single_instance(home: &Path) -> Option<File> {
    let mut o = OpenOptions::new();
    o.create(true).write(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        o.share_mode(0);
    }
    o.open(home.join("running.lock")).ok()
}

/// This PC's address on the home network (what other people type in), falling back to localhost.
fn address() -> String {
    let ip = UdpSocket::bind("0.0.0.0:0")
        .and_then(|s| {
            // no packet is sent: this only asks Windows which network card it would use
            s.connect("8.8.8.8:80")?;
            s.local_addr()
        })
        .map(|a| a.ip().to_string())
        .unwrap_or_else(|_| "localhost".into());
    format!("http://{ip}:{PORT}")
}

fn log_line(home: &Path, line: &str) {
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(home.join("server.log")) {
        let _ = writeln!(f, "[Llamble Server app] {line}");
    }
}

fn hidden(program: &str, args: &[&str]) -> Command {
    let mut cmd = Command::new(program);
    cmd.args(args).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

fn open_url(url: &str) {
    let _ = hidden("rundll32", &["url.dll,FileProtocolHandler", url]).spawn();
}

fn open_path(p: &Path) {
    let _ = Command::new("explorer").arg(p).spawn();
}

fn copy_text(t: &str) {
    if let Ok(mut c) = hidden("clip", &[]).stdin(Stdio::piped()).spawn() {
        if let Some(mut i) = c.stdin.take() {
            let _ = i.write_all(t.as_bytes());
        }
        let _ = c.wait();
    }
}

#[cfg(windows)]
fn autostart_on() -> bool {
    use winreg::{enums::HKEY_CURRENT_USER, RegKey};
    RegKey::predef(HKEY_CURRENT_USER).open_subkey(RUN_KEY).and_then(|k| k.get_value::<String, _>(RUN_NAME)).is_ok()
}
#[cfg(not(windows))]
fn autostart_on() -> bool {
    false
}

#[cfg(windows)]
fn set_autostart(on: bool) {
    use winreg::{enums::HKEY_CURRENT_USER, RegKey};
    if let Ok((k, _)) = RegKey::predef(HKEY_CURRENT_USER).create_subkey(RUN_KEY) {
        if on {
            if let Ok(exe) = std::env::current_exe() {
                let _ = k.set_value(RUN_NAME, &format!("\"{}\" --background", exe.display()));
            }
        } else {
            let _ = k.delete_value(RUN_NAME);
        }
    }
}
#[cfg(not(windows))]
fn set_autostart(_on: bool) {}

fn tray_icon() -> Icon {
    let dec = png::Decoder::new(std::io::Cursor::new(&include_bytes!("../tray.png")[..]));
    let mut reader = dec.read_info().expect("tray icon");
    let mut buf = vec![0; reader.output_buffer_size().expect("tray icon size")];
    let info = reader.next_frame(&mut buf).expect("tray icon");
    buf.truncate(info.buffer_size());
    Icon::from_rgba(buf, info.width, info.height).expect("tray icon")
}
