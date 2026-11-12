//! `llamble-helper audio window <hwnd>` / `audio app <pid>` / `audio except <pid>`
//!
//! Captures the sound of ONE program (and the programs it started) — or of every program
//! except one — using Windows' own per-process loopback (Windows 10 2004 and newer). This
//! is what lets a screen share carry the game's sound without the other call apps,
//! music player or notifications playing on the PC.
//!
//! Output on stdout: raw 48 kHz stereo 32-bit float samples, interleaved, nothing else.
//! The first line on stderr is "ok" once capture is running (or an error). Stops when
//! stdin closes.

#![cfg(windows)]

use std::io::Write;
use windows::core::{implement, Interface, Result, HRESULT, PROPVARIANT};
use windows::Win32::Foundation::{CloseHandle, HANDLE, HWND, WAIT_OBJECT_0};
use windows::Win32::Media::Audio::*;
use windows::Win32::System::Com::{CoInitializeEx, BLOB, COINIT_MULTITHREADED};
use windows::Win32::System::Threading::{CreateEventW, SetEvent, WaitForSingleObject};
use windows::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId;

#[implement(IActivateAudioInterfaceCompletionHandler)]
struct Done(HANDLE);

impl IActivateAudioInterfaceCompletionHandler_Impl for Done_Impl {
    fn ActivateCompleted(&self, _op: Option<&IActivateAudioInterfaceAsyncOperation>) -> Result<()> {
        unsafe { SetEvent(self.0) }
    }
}

// PROPVARIANT holding a VT_BLOB, laid out by hand (24 bytes on 64-bit Windows).
#[repr(C)]
struct BlobVariant {
    vt: u16,
    r1: u16,
    r2: u16,
    r3: u16,
    blob: BLOB,
    _pad: u64,
}

pub fn run(args: &[String]) -> i32 {
    let (mode, target) = (args.first().map(String::as_str).unwrap_or(""), args.get(1).and_then(|v| v.parse::<u64>().ok()).unwrap_or(0));
    let (pid, include) = match mode {
        "window" => {
            let mut pid = 0u32;
            unsafe { GetWindowThreadProcessId(HWND(target as usize as *mut _), Some(&mut pid)) };
            (pid, true)
        }
        "app" => (target as u32, true),
        "except" => (target as u32, false),
        _ => (0, true),
    };
    if pid == 0 {
        eprintln!("usage: llamble-helper audio window <hwnd> | app <pid> | except <pid>");
        return 2;
    }
    // the app closes our stdin when the share ends
    std::thread::spawn(|| {
        let mut sink = String::new();
        while std::io::stdin().read_line(&mut sink).map(|n| n > 0).unwrap_or(false) {
            sink.clear();
        }
        std::process::exit(0);
    });
    match unsafe { capture(pid, include) } {
        Ok(()) => 0,
        Err(e) => {
            eprintln!("error {e}");
            1
        }
    }
}

unsafe fn capture(pid: u32, include: bool) -> Result<()> {
    CoInitializeEx(None, COINIT_MULTITHREADED).ok()?;
    let mut params = AUDIOCLIENT_ACTIVATION_PARAMS {
        ActivationType: AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
        Anonymous: AUDIOCLIENT_ACTIVATION_PARAMS_0 {
            ProcessLoopbackParams: AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
                TargetProcessId: pid,
                ProcessLoopbackMode: if include { PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE } else { PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE },
            },
        },
    };
    let var = BlobVariant {
        vt: 65, // VT_BLOB
        r1: 0,
        r2: 0,
        r3: 0,
        blob: BLOB { cbSize: std::mem::size_of::<AUDIOCLIENT_ACTIVATION_PARAMS>() as u32, pBlobData: &mut params as *mut _ as *mut u8 },
        _pad: 0,
    };
    let ready = CreateEventW(None, false, false, None)?;
    let handler: IActivateAudioInterfaceCompletionHandler = Done(ready).into();
    let op = ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, &IAudioClient::IID, Some(&var as *const _ as *const PROPVARIANT), &handler)?;
    if WaitForSingleObject(ready, 10_000) != WAIT_OBJECT_0 {
        return Err(HRESULT(0x8000_000Au32 as i32).into()); // E_PENDING: Windows never answered
    }
    let mut hr = HRESULT(0);
    let mut unk = None;
    op.GetActivateResult(&mut hr, &mut unk)?;
    hr.ok()?;
    let client: IAudioClient = unk.ok_or_else(|| windows::core::Error::from(HRESULT(0x8000_4005u32 as i32)))?.cast()?;

    let fmt = WAVEFORMATEX {
        wFormatTag: 3, // WAVE_FORMAT_IEEE_FLOAT
        nChannels: 2,
        nSamplesPerSec: 48_000,
        nAvgBytesPerSec: 48_000 * 8,
        nBlockAlign: 8,
        wBitsPerSample: 32,
        cbSize: 0,
    };
    client.Initialize(
        AUDCLNT_SHAREMODE_SHARED,
        AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM,
        200_000, // 20 ms
        0,
        &fmt,
        None,
    )?;
    let wake = CreateEventW(None, false, false, None)?;
    client.SetEventHandle(wake)?;
    let cap: IAudioCaptureClient = client.GetService()?;
    client.Start()?;
    eprintln!("ok");

    let mut out = std::io::stdout().lock();
    let mut bytes: Vec<u8> = Vec::with_capacity(48_000);
    loop {
        WaitForSingleObject(wake, 200);
        bytes.clear();
        loop {
            let n = cap.GetNextPacketSize()?;
            if n == 0 {
                break;
            }
            let mut data = std::ptr::null_mut();
            let mut frames = 0u32;
            let mut flags = 0u32;
            cap.GetBuffer(&mut data, &mut frames, &mut flags, None, None)?;
            let len = frames as usize * 8;
            if flags & (AUDCLNT_BUFFERFLAGS_SILENT.0 as u32) != 0 || data.is_null() {
                bytes.resize(bytes.len() + len, 0);
            } else {
                bytes.extend_from_slice(std::slice::from_raw_parts(data, len));
            }
            cap.ReleaseBuffer(frames)?;
        }
        if !bytes.is_empty() && out.write_all(&bytes).and_then(|_| out.flush()).is_err() {
            let _ = client.Stop();
            let _ = CloseHandle(wake);
            return Ok(());
        }
    }
}
