# Third-party pieces bundled with Llamble

| What | Used for | License |
|---|---|---|
| Google MediaPipe (tasks-vision, face landmarker, selfie segmenter) | camera effects, face filters, background blur | Apache-2.0 |
| canvas-confetti | /confetti, /snow, /hearts chat effects | ISC |
| fireworks-js | /fireworks chat effect | MIT |
| LiveKit (server + livekit-client) | voice, video, screen share | Apache-2.0 |
| Built-in soundboard clips (`client/public/sounds`) | soundboard | made for Llamble from scratch by `tools/make_sounds.py`; same license as Llamble |
| stable-diffusion.cpp | pictures on the NAS and on lent GPUs | MIT |
| FLUX.2 [klein] 4B / Z-Image Turbo (downloaded when turned on) | picture models | Apache-2.0 |
| sherpa-onnx, Whisper, Kokoro (downloaded when turned on) | "Hey Llamble" speech | Apache-2.0 / MIT |

## llamble-helper.exe (Windows app)

Our own small Rust program (`client/native/llamble-helper`) that lists open windows for game
detection and reads graphics card info. Its only runtime dependency is Microsoft's
[`windows`](https://github.com/microsoft/windows-rs) crate (MIT or Apache-2.0); `syn`, `quote`
and `proc-macro2` are used only while compiling it.
