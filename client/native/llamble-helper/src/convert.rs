//! On the graphics card: take a captured BGRA frame, cut out the part we want (a window's
//! area on its monitor), scale it to the recording size keeping its shape (black bars if
//! needed), and convert it to NV12 — the format video encoders (NVENC, AMD, Intel) take.
//! Uses the card's own video processor, like recording software does.

#![cfg(windows)]

use std::collections::HashMap;
use windows::core::{Interface, Result};
use windows::Win32::Foundation::{BOOL, RECT};
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::Dxgi::Common::*;

pub struct Converter {
    device: ID3D11Device,
    ctx: ID3D11DeviceContext,
    vdev: ID3D11VideoDevice,
    vctx: ID3D11VideoContext,
    pub out_w: u32,
    pub out_h: u32,
    fps: u32,
    /// our copy of the wanted part of the capture (BGRA), and the processor set up for its size
    stage: Option<Stage>,
    /// output views onto the encoder's frames, by texture
    views: HashMap<usize, ID3D11VideoProcessorOutputView>,
}

struct Stage {
    w: u32,
    h: u32,
    tex: ID3D11Texture2D,
    en: ID3D11VideoProcessorEnumerator,
    vp: ID3D11VideoProcessor,
    input: ID3D11VideoProcessorInputView,
}

// Only used under the recorder's lock, on a device with multithread protection on.
unsafe impl Send for Converter {}

impl Converter {
    pub unsafe fn new(device: &ID3D11Device, ctx: &ID3D11DeviceContext, out_w: u32, out_h: u32, fps: u32) -> Result<Self> {
        Ok(Converter { device: device.clone(), ctx: ctx.clone(), vdev: device.cast()?, vctx: ctx.cast()?, out_w, out_h, fps, stage: None, views: HashMap::new() })
    }

    /// Make an NV12 texture of the output size (for the processor-encoder path).
    pub unsafe fn nv12_texture(&self, staging: bool) -> Result<ID3D11Texture2D> {
        let desc = D3D11_TEXTURE2D_DESC {
            Width: self.out_w,
            Height: self.out_h,
            MipLevels: 1,
            ArraySize: 1,
            Format: DXGI_FORMAT_NV12,
            SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
            Usage: if staging { D3D11_USAGE_STAGING } else { D3D11_USAGE_DEFAULT },
            BindFlags: if staging { 0 } else { D3D11_BIND_RENDER_TARGET.0 as u32 },
            CPUAccessFlags: if staging { D3D11_CPU_ACCESS_READ.0 as u32 } else { 0 },
            MiscFlags: 0,
        };
        let mut t = None;
        self.device.CreateTexture2D(&desc, None, Some(&mut t))?;
        Ok(t.unwrap())
    }

    unsafe fn stage(&mut self, w: u32, h: u32) -> Result<&Stage> {
        if self.stage.as_ref().map(|s| s.w != w || s.h != h).unwrap_or(true) {
            self.views.clear(); // tied to the old processor
            let desc = D3D11_TEXTURE2D_DESC {
                Width: w,
                Height: h,
                MipLevels: 1,
                ArraySize: 1,
                Format: DXGI_FORMAT_B8G8R8A8_UNORM,
                SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
                Usage: D3D11_USAGE_DEFAULT,
                BindFlags: (D3D11_BIND_RENDER_TARGET.0 | D3D11_BIND_SHADER_RESOURCE.0) as u32,
                CPUAccessFlags: 0,
                MiscFlags: 0,
            };
            let mut tex = None;
            self.device.CreateTexture2D(&desc, None, Some(&mut tex))?;
            let tex = tex.unwrap();
            let rate = DXGI_RATIONAL { Numerator: self.fps, Denominator: 1 };
            let content = D3D11_VIDEO_PROCESSOR_CONTENT_DESC {
                InputFrameFormat: D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE,
                InputFrameRate: rate,
                InputWidth: w,
                InputHeight: h,
                OutputFrameRate: rate,
                OutputWidth: self.out_w,
                OutputHeight: self.out_h,
                Usage: D3D11_VIDEO_USAGE_PLAYBACK_NORMAL,
            };
            let en = self.vdev.CreateVideoProcessorEnumerator(&content)?;
            let vp = self.vdev.CreateVideoProcessor(&en, 0)?;
            let ind = D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC {
                FourCC: 0,
                ViewDimension: D3D11_VPIV_DIMENSION_TEXTURE2D,
                Anonymous: D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC_0 { Texture2D: D3D11_TEX2D_VPIV { MipSlice: 0, ArraySlice: 0 } },
            };
            let mut input = None;
            self.vdev.CreateVideoProcessorInputView(&tex, &en, &ind, Some(&mut input))?;
            // full-range screen colours in, HD (BT.709) video colours out
            if let Ok(v1) = self.vctx.cast::<ID3D11VideoContext1>() {
                v1.VideoProcessorSetStreamColorSpace1(&vp, 0, DXGI_COLOR_SPACE_RGB_FULL_G22_NONE_P709);
                v1.VideoProcessorSetOutputColorSpace1(&vp, DXGI_COLOR_SPACE_YCBCR_STUDIO_G22_LEFT_P709);
            }
            self.vctx.VideoProcessorSetStreamFrameFormat(&vp, 0, D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE);
            // keep the shape: fit inside the output, black around it
            let s = (self.out_w as f64 / w as f64).min(self.out_h as f64 / h as f64);
            let (dw, dh) = (((w as f64 * s) as i32) & !1, ((h as f64 * s) as i32) & !1);
            let (dx, dy) = (((self.out_w as i32 - dw) / 2) & !1, ((self.out_h as i32 - dh) / 2) & !1);
            self.vctx.VideoProcessorSetStreamDestRect(&vp, 0, BOOL(1), Some(&RECT { left: dx, top: dy, right: dx + dw, bottom: dy + dh }));
            self.vctx.VideoProcessorSetOutputBackgroundColor(&vp, BOOL(0), &D3D11_VIDEO_COLOR { Anonymous: D3D11_VIDEO_COLOR_0 { RGBA: D3D11_VIDEO_COLOR_RGBA { R: 0.0, G: 0.0, B: 0.0, A: 1.0 } } });
            self.stage = Some(Stage { w, h, tex, en, vp, input: input.unwrap() });
        }
        Ok(self.stage.as_ref().unwrap())
    }

    /// Cut `region` out of `src` (a captured frame) and paint it, scaled and converted, into `dst` (NV12).
    pub unsafe fn convert(&mut self, src: &ID3D11Texture2D, region: &D3D11_BOX, dst: &ID3D11Texture2D) -> Result<()> {
        let (w, h) = (((region.right - region.left) & !1).max(2), ((region.bottom - region.top) & !1).max(2));
        let region = D3D11_BOX { right: region.left + w, bottom: region.top + h, ..*region };
        self.stage(w, h)?;
        let st = self.stage.as_ref().unwrap();
        self.ctx.CopySubresourceRegion(&st.tex, 0, 0, 0, 0, src, 0, Some(&region));
        let key = dst.as_raw() as usize;
        if !self.views.contains_key(&key) {
            let od = D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC {
                ViewDimension: D3D11_VPOV_DIMENSION_TEXTURE2D,
                Anonymous: D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC_0 { Texture2D: D3D11_TEX2D_VPOV { MipSlice: 0 } },
            };
            let mut v = None;
            self.vdev.CreateVideoProcessorOutputView(dst, &st.en, &od, Some(&mut v))?;
            self.views.insert(key, v.unwrap());
        }
        let view = self.views.get(&key).unwrap();
        let stream = D3D11_VIDEO_PROCESSOR_STREAM {
            Enable: BOOL(1),
            OutputIndex: 0,
            InputFrameOrField: 0,
            PastFrames: 0,
            FutureFrames: 0,
            ppPastSurfaces: std::ptr::null_mut(),
            pInputSurface: std::mem::ManuallyDrop::new(Some(st.input.clone())),
            ppFutureSurfaces: std::ptr::null_mut(),
            ppPastSurfacesRight: std::ptr::null_mut(),
            pInputSurfaceRight: std::mem::ManuallyDrop::new(None),
            ppFutureSurfacesRight: std::ptr::null_mut(),
        };
        let r = self.vctx.VideoProcessorBlt(&st.vp, view, 0, &[stream.clone()]);
        // the stream struct holds a reference to the input view: let it go
        let mut s = stream;
        std::mem::ManuallyDrop::drop(&mut s.pInputSurface);
        r
    }
}
