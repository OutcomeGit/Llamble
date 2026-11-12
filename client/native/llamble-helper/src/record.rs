//! `llamble-helper record <out.mp4> (--window <hwnd> | --point <x>,<y>) [--fps 60]
//!     [--bitrate 40000000 | --bpp 0.2] [--codec auto|av1|h264] [--audio window|app|except <id>]`
//!
//! Records a window or a whole screen the way dedicated recording software does, with no
//! browser engine in the way:
//!  - Windows Graphics Capture hands us each new frame as a texture on the graphics card;
//!  - it's copied (still on the graphics card) into a frame the encoder owns;
//!  - Media Foundation encodes it on the graphics card's own encoder (NVIDIA NVENC, AMD,
//!    Intel): AV1 when the card has it, else H.264; variable bitrate at the rate asked;
//!  - sound comes from one program (or everything but one) via Windows' per-app capture
//!    (audio.rs), encoded as AAC;
//!  - both go into an MP4, timed by the same clock so they stay in step.
//!
//! The size is whatever is captured (a 2560×1440 game records at 2560×1440).
//! Talks on stdout, one line each: `started <codec> <gpu|cpu> <w> <h>`, `stat <fps> <dropped>
//! <bytes>` every second, then `done` (or `error <why>`). Send `stop` on stdin to finish.

#![cfg(windows)]

use crate::audio;
use std::io::{BufRead, Write};
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use windows::core::{factory, Interface, Result, GUID, HRESULT, PCWSTR, VARIANT};
use windows::Foundation::TypedEventHandler;
use windows::Graphics::Capture::{Direct3D11CaptureFramePool, GraphicsCaptureItem};
use windows::Graphics::DirectX::Direct3D11::IDirect3DDevice;
use windows::Graphics::DirectX::DirectXPixelFormat;
use windows::Win32::Foundation::{HMODULE, HWND, POINT};
use windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_HARDWARE;
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::Dxgi::IDXGIDevice;
use windows::Win32::Graphics::Gdi::{MonitorFromPoint, MONITOR_DEFAULTTONEAREST};
use windows::Win32::Media::MediaFoundation::*;
use windows::Win32::System::Com::{CoInitializeEx, CoTaskMemFree, COINIT_MULTITHREADED};
use windows::Win32::System::WinRT::Direct3D11::{CreateDirect3D11DeviceFromDXGIDevice, IDirect3DDxgiInterfaceAccess};
use windows::Win32::System::WinRT::Graphics::Capture::IGraphicsCaptureItemInterop;

struct Opts {
    out: String,
    window: Option<u64>,
    point: Option<(i32, i32)>,
    fps: u32,
    bitrate: u32,
    /// bits per pixel per frame: when given, the bitrate follows the captured size
    bpp: Option<f64>,
    codec: String,
    audio: Option<(String, u64)>,
}

fn parse(args: &[String]) -> Option<Opts> {
    let mut o = Opts { out: args.first()?.clone(), window: None, point: None, fps: 60, bitrate: 40_000_000, bpp: None, codec: "auto".into(), audio: None };
    let mut i = 1;
    while i < args.len() {
        let v = args.get(i + 1).cloned().unwrap_or_default();
        match args[i].as_str() {
            "--window" => o.window = v.parse().ok(),
            "--point" => {
                let (x, y) = v.split_once(',')?;
                o.point = Some((x.trim().parse().ok()?, y.trim().parse().ok()?));
            }
            "--fps" => o.fps = v.parse().ok().filter(|f| (10..=240).contains(f))?,
            "--bitrate" => o.bitrate = v.parse().ok().filter(|b| (1_000_000..=200_000_000).contains(b))?,
            "--codec" => o.codec = v,
            "--bpp" => o.bpp = v.parse().ok().filter(|b: &f64| (0.01..=2.0).contains(b)),
            "--audio" => {
                let id = args.get(i + 2)?.parse().ok()?;
                o.audio = Some((v, id));
                i += 1;
            }
            _ => return None,
        }
        i += 2;
    }
    (o.window.is_some() || o.point.is_some()).then_some(o)
}

fn say(line: &str) {
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{line}");
    let _ = out.flush();
}

pub fn run(args: &[String]) -> i32 {
    let Some(o) = parse(args) else {
        say("error usage: record <out.mp4> (--window <hwnd> | --point <x>,<y>) [--fps 60] [--bitrate 40000000] [--codec auto|av1|h264] [--audio window|app|except <id>]");
        return 2;
    };
    match unsafe { record(o) } {
        Ok(()) => 0,
        Err(e) => {
            say(&format!("error {e}"));
            1
        }
    }
}

/// Is there an encoder for this format on the graphics card?
unsafe fn gpu_encoder(subtype: GUID) -> bool {
    let out = MFT_REGISTER_TYPE_INFO { guidMajorType: MFMediaType_Video, guidSubtype: subtype };
    let mut list: *mut Option<IMFActivate> = std::ptr::null_mut();
    let mut n = 0u32;
    if MFTEnumEx(MFT_CATEGORY_VIDEO_ENCODER, MFT_ENUM_FLAG_HARDWARE | MFT_ENUM_FLAG_SORTANDFILTER, None, Some(&out), &mut list, &mut n).is_err() || list.is_null() {
        return false;
    }
    for i in 0..n as usize {
        drop(std::ptr::read(list.add(i)));
    }
    CoTaskMemFree(Some(list as *const _));
    n > 0
}

unsafe fn video_type(subtype: GUID, w: u32, h: u32, fps: u32, bitrate: u32) -> Result<IMFMediaType> {
    let t = MFCreateMediaType()?;
    t.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
    t.SetGUID(&MF_MT_SUBTYPE, &subtype)?;
    t.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)?;
    t.SetUINT64(&MF_MT_FRAME_SIZE, ((w as u64) << 32) | h as u64)?;
    t.SetUINT64(&MF_MT_FRAME_RATE, ((fps as u64) << 32) | 1)?;
    t.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, (1u64 << 32) | 1)?;
    if subtype != MFVideoFormat_ARGB32 {
        t.SetUINT32(&MF_MT_AVG_BITRATE, bitrate)?;
    }
    if subtype == MFVideoFormat_H264 {
        t.SetUINT32(&MF_MT_MPEG2_PROFILE, eAVEncH264VProfile_High.0 as u32)?;
    }
    Ok(t)
}

unsafe fn audio_type(aac: bool) -> Result<IMFMediaType> {
    let t = MFCreateMediaType()?;
    t.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio)?;
    t.SetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND, 48_000)?;
    t.SetUINT32(&MF_MT_AUDIO_NUM_CHANNELS, 2)?;
    if aac {
        t.SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_AAC)?;
        t.SetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE, 16)?;
        t.SetUINT32(&MF_MT_AUDIO_AVG_BYTES_PER_SECOND, 24_000)?; // 192 kbps
    } else {
        t.SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_Float)?;
        t.SetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE, 32)?;
        t.SetUINT32(&MF_MT_AUDIO_BLOCK_ALIGNMENT, 8)?;
        t.SetUINT32(&MF_MT_AUDIO_AVG_BYTES_PER_SECOND, 48_000 * 8)?;
    }
    Ok(t)
}

struct Writer {
    sink: IMFSinkWriter,
    video: u32,
    audio: Option<u32>,
    name: &'static str,
}
// Media Foundation's sink writer is free-threaded; we also only touch it under a lock.
unsafe impl Send for Writer {}

/// What the frame callback (on Windows' capture thread) uses. The device has multithread
/// protection turned on and the sample allocator is free-threaded, so this is safe to share.
struct Gpu {
    ctx: ID3D11DeviceContext,
    alloc: IMFVideoSampleAllocatorEx,
    rt_device: IDirect3DDevice,
}
unsafe impl Send for Gpu {}
unsafe impl Sync for Gpu {}

/// Open the MP4 with the best encoder: AV1 or H.264 on the graphics card, else H.264 on the processor.
unsafe fn open_writer(o: &Opts, mgr: &IMFDXGIDeviceManager, w: u32, h: u32, with_audio: bool) -> Result<(Writer, bool)> {
    let mut picks: Vec<(GUID, &'static str)> = vec![];
    if o.codec == "auto" || o.codec == "av1" {
        picks.push((MFVideoFormat_AV1, "AV1"));
    }
    picks.push((MFVideoFormat_H264, "H.264"));
    let mut last = HRESULT(0x8000_4005u32 as i32).into();
    for (sub, name) in picks {
        let gpu = gpu_encoder(sub);
        if !gpu && sub == MFVideoFormat_AV1 {
            continue; // AV1 on the processor is far too slow to record with
        }
        let _ = std::fs::remove_file(&o.out);
        let mut attrs = None;
        MFCreateAttributes(&mut attrs, 4)?;
        let attrs = attrs.unwrap();
        attrs.SetUINT32(&MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, 1)?;
        attrs.SetUnknown(&MF_SINK_WRITER_D3D_MANAGER, mgr)?;
        let path: Vec<u16> = o.out.encode_utf16().chain([0]).collect();
        let attempt = (|| -> Result<Writer> {
            let sink = MFCreateSinkWriterFromURL(PCWSTR(path.as_ptr()), None, &attrs)?;
            let video = sink.AddStream(&video_type(sub, w, h, o.fps, o.bitrate)?)?;
            sink.SetInputMediaType(video, &video_type(MFVideoFormat_ARGB32, w, h, o.fps, 0)?, None)?;
            // recording-grade settings: variable bitrate, quality over speed, a key frame every 2 s
            let mut api: *mut core::ffi::c_void = std::ptr::null_mut();
            if sink.GetServiceForStream(video, &GUID::zeroed(), &ICodecAPI::IID, &mut api).is_ok() && !api.is_null() {
                let api = ICodecAPI::from_raw(api);
                let _ = api.SetValue(&CODECAPI_AVEncCommonRateControlMode, &VARIANT::from(eAVEncCommonRateControlMode_UnconstrainedVBR.0 as u32));
                let _ = api.SetValue(&CODECAPI_AVEncCommonMeanBitRate, &VARIANT::from(o.bitrate));
                let _ = api.SetValue(&CODECAPI_AVEncCommonQualityVsSpeed, &VARIANT::from(70u32));
                let _ = api.SetValue(&CODECAPI_AVEncMPVGOPSize, &VARIANT::from(o.fps * 2));
            }
            let audio = if with_audio {
                let a = sink.AddStream(&audio_type(true)?)?;
                sink.SetInputMediaType(a, &audio_type(false)?, None)?;
                Some(a)
            } else {
                None
            };
            sink.BeginWriting()?;
            Ok(Writer { sink, video, audio, name })
        })();
        match attempt {
            Ok(wr) => return Ok((wr, gpu)),
            Err(e) => last = e,
        }
    }
    Err(last)
}

unsafe fn record(o: Opts) -> Result<()> {
    CoInitializeEx(None, COINIT_MULTITHREADED).ok()?;
    MFStartup(MF_VERSION, MFSTARTUP_FULL)?;

    // the graphics card
    let mut device = None;
    let mut ctx = None;
    D3D11CreateDevice(None, D3D_DRIVER_TYPE_HARDWARE, HMODULE::default(), D3D11_CREATE_DEVICE_BGRA_SUPPORT | D3D11_CREATE_DEVICE_VIDEO_SUPPORT, None, D3D11_SDK_VERSION, Some(&mut device), None, Some(&mut ctx))?;
    let device: ID3D11Device = device.unwrap();
    let ctx: ID3D11DeviceContext = ctx.unwrap();
    let _ = device.cast::<ID3D11Multithread>()?.SetMultithreadProtected(true);
    let rt_device: IDirect3DDevice = CreateDirect3D11DeviceFromDXGIDevice(&device.cast::<IDXGIDevice>()?)?.cast()?;

    // what to capture
    let interop = factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>()?;
    let item: GraphicsCaptureItem = match (o.window, o.point) {
        (Some(hwnd), _) => interop.CreateForWindow(HWND(hwnd as usize as *mut _))?,
        (None, Some((x, y))) => interop.CreateForMonitor(MonitorFromPoint(POINT { x, y }, MONITOR_DEFAULTTONEAREST))?,
        _ => unreachable!(),
    };
    let size = item.Size()?;
    let (w, h) = ((size.Width.max(2) as u32) & !1, (size.Height.max(2) as u32) & !1);
    let mut o = o;
    if let Some(bpp) = o.bpp {
        o.bitrate = ((w as f64 * h as f64 * o.fps as f64 * bpp) as u32).clamp(4_000_000, 150_000_000);
    }

    // the encoder and the file
    let mut token = 0u32;
    let mut mgr = None;
    MFCreateDXGIDeviceManager(&mut token, &mut mgr)?;
    let mgr = mgr.unwrap();
    mgr.ResetDevice(&device, token)?;
    let audio_target = o.audio.as_ref().and_then(|(m, id)| audio::target(m, *id));
    let (wr, gpu) = open_writer(&o, &mgr, w, h, audio_target.is_some())?;

    // frames the encoder owns (it hands one back when it's done with it); same pixel format as
    // what Windows captures (BGRA), so they can be copied on the graphics card
    let mut alloc: *mut core::ffi::c_void = std::ptr::null_mut();
    MFCreateVideoSampleAllocatorEx(&IMFVideoSampleAllocatorEx::IID, &mut alloc)?;
    let alloc = IMFVideoSampleAllocatorEx::from_raw(alloc);
    alloc.SetDirectXManager(&mgr)?;
    let mut aattrs = None;
    MFCreateAttributes(&mut aattrs, 2)?;
    let aattrs = aattrs.unwrap();
    aattrs.SetUINT32(&MF_SA_D3D11_BINDFLAGS, (D3D11_BIND_RENDER_TARGET.0 | D3D11_BIND_SHADER_RESOURCE.0) as u32)?;
    alloc.InitializeSampleAllocatorEx(4, 16, &aattrs, &video_type(MFVideoFormat_ARGB32, w, h, o.fps, 0)?)?;

    let writer = Arc::new(Mutex::new(wr));
    let stop = Arc::new(AtomicBool::new(false));
    let t0 = Arc::new(AtomicI64::new(-1)); // the first frame's time: zero in the file
    let frames = Arc::new(AtomicU32::new(0));
    let frames_total = Arc::new(AtomicU32::new(0));
    // what happened to frames that didn't make it in (shown once a second, then cleared)
    let arrived = Arc::new(AtomicU32::new(0));
    let total_arrived = Arc::new(AtomicU32::new(0));
    let last_error: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));
    let dropped = Arc::new(AtomicU32::new(0));
    let frame_len = 10_000_000i64 / o.fps as i64;
    let heard = Arc::new(AtomicBool::new(false)); // any sound written yet?

    // each new frame from Windows
    let pool = Direct3D11CaptureFramePool::CreateFreeThreaded(&rt_device, DirectXPixelFormat::B8G8R8A8UIntNormalized, 3, size)?;
    let session = pool.CreateCaptureSession(&item)?;
    let _ = session.SetIsCursorCaptureEnabled(true);
    let _ = session.SetIsBorderRequired(false); // no yellow border (Windows 11)
    let pool_size = Arc::new(Mutex::new(size));
    {
        let (writer, t0, frames, dropped, stop, frames_total) = (writer.clone(), t0.clone(), frames.clone(), dropped.clone(), stop.clone(), frames_total.clone());
        let (arrived, last_error, total_arrived) = (arrived.clone(), last_error.clone(), total_arrived.clone());
        let gpu = Gpu { ctx: ctx.clone(), alloc: alloc.clone(), rt_device: rt_device.clone() };
        let pool_size = pool_size.clone();
        let mut last = i64::MIN;
        pool.FrameArrived(&TypedEventHandler::<Direct3D11CaptureFramePool, windows::core::IInspectable>::new(move |p, _| {
            let gpu = &gpu; // the whole bundle (see Gpu), not its parts one by one
            arrived.fetch_add(1, Ordering::Relaxed);
            total_arrived.fetch_add(1, Ordering::SeqCst);
            let Some(p) = p.as_ref() else { return Ok(()) };
            let res = (|| -> Result<()> {
            let frame = p.TryGetNextFrame()?;
            if stop.load(Ordering::Relaxed) {
                return Ok(());
            }
            let t = frame.SystemRelativeTime()?.Duration;
            // the window changed size: keep capturing at its new size (the video stays its first size)
            let content = frame.ContentSize()?;
            {
                let mut ps = pool_size.lock().unwrap();
                if content.Width != ps.Width || content.Height != ps.Height {
                    p.Recreate(&gpu.rt_device, DirectXPixelFormat::B8G8R8A8UIntNormalized, 3, content)?;
                    *ps = content;
                }
            }
            // faster than the chosen frame rate (a 240 Hz game): skip in between
            if last != i64::MIN && t - last < frame_len - frame_len / 8 {
                return Ok(());
            }
            let sample = match gpu.alloc.AllocateSample() {
                Ok(s) => s,
                Err(_) => {
                    dropped.fetch_add(1, Ordering::Relaxed); // the encoder's behind: drop rather than pile up
                    return Ok(());
                }
            };
            last = t;
            let src: ID3D11Texture2D = frame.Surface()?.cast::<IDirect3DDxgiInterfaceAccess>()?.GetInterface()?;
            let mut dst: *mut core::ffi::c_void = std::ptr::null_mut();
            sample.GetBufferByIndex(0)?.cast::<IMFDXGIBuffer>()?.GetResource(&ID3D11Texture2D::IID, &mut dst)?;
            let dst = ID3D11Texture2D::from_raw(dst);
            let cw = (content.Width.max(0) as u32).min(w);
            let ch = (content.Height.max(0) as u32).min(h);
            let wr = writer.lock().unwrap();
            gpu.ctx.CopySubresourceRegion(&dst, 0, 0, 0, 0, &src, 0, Some(&D3D11_BOX { left: 0, top: 0, front: 0, right: cw, bottom: ch, back: 1 }));
            let _ = t0.compare_exchange(-1, t, Ordering::SeqCst, Ordering::SeqCst);
            sample.SetSampleTime(t - t0.load(Ordering::SeqCst))?;
            sample.SetSampleDuration(frame_len)?;
            wr.sink.WriteSample(wr.video, &sample)?;
            frames.fetch_add(1, Ordering::Relaxed);
            frames_total.fetch_add(1, Ordering::SeqCst);
            Ok(())
            })();
            if let Err(e) = res {
                *last_error.lock().unwrap() = format!("{e}");
            }
            Ok(())
        }))?;
    }

    // the sound, on its own thread, on the same clock
    let audio_thread = audio_target.map(|(pid, include)| {
        let (writer, t0, stop, heard) = (writer.clone(), t0.clone(), stop.clone(), heard.clone());
        std::thread::spawn(move || {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            let mut next = 0i64; // where the sound track has reached (100 ns units)
            let _ = audio::capture(pid, include, &mut |pcm: &[u8], qpc: u64| {
                if stop.load(Ordering::Relaxed) {
                    return false;
                }
                let start = t0.load(Ordering::SeqCst);
                if start < 0 {
                    return true; // no picture yet
                }
                let mut at = qpc as i64 - start;
                let len = (pcm.len() as i64 / 8) * 10_000_000 / 48_000;
                if at + len <= 0 {
                    return true;
                }
                // the program was silent for a while (Windows sends nothing then): fill the gap
                let wr = writer.lock().unwrap();
                let Some(stream) = wr.audio else { return false };
                if at > next + 200_000 {
                    let _ = write_audio(&wr.sink, stream, &vec![0u8; (((at - next) * 48_000 / 10_000_000) as usize) * 8], next);
                    next = at;
                }
                at = at.max(next);
                let ok = write_audio(&wr.sink, stream, pcm, at).is_ok();
                heard.store(true, Ordering::SeqCst);
                next = at + len;
                ok
            });
        })
    });

    session.StartCapture()?;
    say(&format!("started {} {} {w} {h} {}", wr_name(&writer), if gpu { "gpu" } else { "cpu" }, o.bitrate));

    // progress every second, until "stop" (or the app goes away)
    {
        let (frames, dropped, stop, out) = (frames.clone(), dropped.clone(), stop.clone(), o.out.clone());
        let (arrived, last_error) = (arrived.clone(), last_error.clone());
        std::thread::spawn(move || {
            while !stop.load(Ordering::Relaxed) {
                std::thread::sleep(std::time::Duration::from_secs(1));
                let bytes = std::fs::metadata(&out).map(|m| m.len()).unwrap_or(0);
                say(&format!("stat {} {} {bytes}", frames.swap(0, Ordering::Relaxed), dropped.swap(0, Ordering::Relaxed)));
                // frames came from Windows but didn't make it into the file: say why
                let a = arrived.swap(0, Ordering::Relaxed);
                let e = std::mem::take(&mut *last_error.lock().unwrap());
                if !e.is_empty() {
                    say(&format!("warn {a} frames arrived; last problem: {e}"));
                }
            }
        });
    }
    let stdin = std::io::stdin();
    for line in stdin.lock().lines() {
        if line.map(|l| l.trim() == "stop").unwrap_or(true) {
            break;
        }
    }
    stop.store(true, Ordering::SeqCst);
    let _ = session.Close();
    let _ = pool.Close();
    if let Some(t) = audio_thread {
        let _ = t.join();
    }
    let wr = writer.lock().unwrap();
    // the program never made a sound: the MP4 writer won't finish an empty track, so give it a moment of silence
    if let Some(a) = wr.audio {
        if !heard.load(Ordering::SeqCst) {
            let _ = write_audio(&wr.sink, a, &vec![0u8; 4800 * 8], 0);
        }
    }
    if frames_total.load(Ordering::SeqCst) == 0 {
        let why = if total_arrived.load(Ordering::SeqCst) == 0 { "Windows sent no picture (is the window minimised, or is there no desktop?)" } else { "pictures arrived but none could be recorded" };
        return Err(windows::core::Error::new(HRESULT(0x8000_4005u32 as i32), why));
    }
    wr.sink.Finalize()?;
    drop(wr);
    say("done");
    let _ = MFShutdown();
    Ok(())
}

fn wr_name(w: &Arc<Mutex<Writer>>) -> &'static str {
    w.lock().unwrap().name
}

unsafe fn write_audio(sink: &IMFSinkWriter, stream: u32, pcm: &[u8], at: i64) -> Result<()> {
    if pcm.is_empty() {
        return Ok(());
    }
    let buf = MFCreateMemoryBuffer(pcm.len() as u32)?;
    let mut p = std::ptr::null_mut();
    buf.Lock(&mut p, None, None)?;
    std::ptr::copy_nonoverlapping(pcm.as_ptr(), p, pcm.len());
    buf.Unlock()?;
    buf.SetCurrentLength(pcm.len() as u32)?;
    let s = MFCreateSample()?;
    s.AddBuffer(&buf)?;
    s.SetSampleTime(at)?;
    s.SetSampleDuration((pcm.len() as i64 / 8) * 10_000_000 / 48_000)?;
    sink.WriteSample(stream, &s)
}
