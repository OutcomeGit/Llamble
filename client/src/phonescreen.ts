// Screen sharing in the Android app.
//
// Android's WebView can't capture the screen itself, so the app does: Android's own screen
// capture (you pick the whole screen or one app), encoded to H.264 on the phone's video chip,
// plus the shared apps' sound. It hands that to this page piece by piece; here the video is
// decoded (also on the video chip) into a live video track, and the sound is played into an
// audio track. voice.ts then shares them in the call like any screen share. No extra libraries.
import { androidSend, isAndroidApp, onAndroid } from "./android";

/** This phone app can share its screen (needs the WebView's video decoder). */
export function canPhoneShare(): boolean {
  return isAndroidApp && typeof (window as any).VideoDecoder === "function";
}

export interface PhoneCapture {
  video: MediaStreamTrack;
  audio: MediaStreamTrack | null;
  width: number;
  height: number;
  stop(): void;
}

type Msg = { event: string; [k: string]: unknown };
let handler: ((m: Msg) => void) | null = null;
onAndroid((m) => {
  if (m.event.startsWith("screen-")) handler?.(m);
});

function bytes(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** "avc1.PPCCLL" from the SPS (the first bytes after its start code). */
function codecFrom(config: Uint8Array): string {
  for (let i = 0; i + 4 < config.length; i++) {
    if (config[i] === 0 && config[i + 1] === 0 && config[i + 2] === 1 && (config[i + 3] & 0x1f) === 7) {
      const hex = (n: number) => n.toString(16).padStart(2, "0");
      return "avc1." + hex(config[i + 4]) + hex(config[i + 5]) + hex(config[i + 6]);
    }
  }
  return "avc1.42e01f";
}

/**
 * Ask Android to start capturing. Resolves once you've picked what to share in Android's
 * prompt and the first picture has arrived; rejects if you cancel.
 */
export function startPhoneCapture(want: { width: number; height: number; fps: number; bitrate: number; audio: boolean }): Promise<PhoneCapture> {
  return new Promise((resolve, reject) => {
    let config: Uint8Array | null = null;
    let decoder: VideoDecoder | null = null;
    let width = 0;
    let height = 0;
    let done = false;
    let stopped = false;
    let needKey = true; // a decoder that just (re)started needs a full picture first

    // decoded pictures -> a live track (a generator if this WebView has one, else a canvas)
    const Gen = (window as any).MediaStreamTrackGenerator;
    let video: MediaStreamTrack;
    let put: (f: VideoFrame) => void;
    let canvas: HTMLCanvasElement | null = null;
    if (typeof Gen === "function") {
      const gen = new Gen({ kind: "video" });
      const w = gen.writable.getWriter();
      video = gen;
      put = (f) => {
        w.write(f).catch(() => f.close());
      };
    } else {
      canvas = document.createElement("canvas");
      const g = canvas.getContext("2d")!;
      video = canvas.captureStream(want.fps).getVideoTracks()[0];
      put = (f) => {
        if (canvas!.width !== f.displayWidth) canvas!.width = f.displayWidth;
        if (canvas!.height !== f.displayHeight) canvas!.height = f.displayHeight;
        g.drawImage(f, 0, 0);
        f.close();
      };
    }

    // the shared sound
    let ctx: AudioContext | null = null;
    let player: AudioWorkletNode | null = null;
    let audio: MediaStreamTrack | null = null;
    const audioReady = (async () => {
      if (!want.audio) return;
      try {
        ctx = new AudioContext({ sampleRate: 48000 });
        await ctx.audioWorklet.addModule("/pcmPlayerWorklet.js");
        player = new AudioWorkletNode(ctx, "pcm-player", { outputChannelCount: [2] });
        const dest = ctx.createMediaStreamDestination();
        dest.channelCount = 2;
        player.connect(dest);
        audio = dest.stream.getAudioTracks()[0];
        await ctx.resume();
      } catch (e) {
        console.warn("[llamble] shared sound unavailable", e);
        audio = null;
      }
    })();

    // the video chip's decoder when this phone offers one for this video, else the regular one
    let decoderConfig: VideoDecoderConfig | null = null;
    let failures = 0;
    const pickConfig = async (cfg: Uint8Array) => {
      const base = { codec: codecFrom(cfg), optimizeForLatency: true } as VideoDecoderConfig;
      for (const hw of ["prefer-hardware", "no-preference"] as const) {
        const c = { ...base, hardwareAcceleration: hw } as VideoDecoderConfig;
        try {
          if ((await VideoDecoder.isConfigSupported(c)).supported) return c;
        } catch {}
      }
      return base;
    };
    const newDecoder = () => {
      needKey = true;
      if (decoder && decoder.state !== "closed") decoder.close();
      decoder = null;
      if (!decoderConfig || failures > 5) return;
      decoder = new VideoDecoder({
        output: (f) => {
          if (stopped) return f.close();
          width = f.displayWidth;
          height = f.displayHeight;
          put(f);
          if (!done) {
            done = true;
            audioReady.then(() => resolve({ video, audio, width, height, stop }));
          }
        },
        error: (e) => {
          console.warn("[llamble] screen decoder", e);
          // start over from the next full picture (a few times at most)
          failures++;
          if (!stopped) {
            newDecoder();
            androidSend("screen-keyframe");
          }
        },
      });
      decoder.configure(decoderConfig);
    };

    function stop() {
      if (stopped) return;
      stopped = true;
      handler = null;
      androidSend("screen-stop");
      if (decoder && decoder.state !== "closed") decoder.close();
      video.stop();
      audio?.stop();
      ctx?.close().catch(() => {});
    }

    handler = (m) => {
      if (m.event === "screen-denied") {
        handler = null;
        stopped = true;
        video.stop();
        ctx?.close().catch(() => {});
        reject(new Error(String(m.reason || "Screen sharing wasn't started")));
      } else if (m.event === "screen-stopped") {
        // ended from Android's side (its "stop sharing" control, or the app was closed)
        if (!done) reject(new Error("Screen sharing stopped"));
        stop();
        window.dispatchEvent(new Event("llamble-phone-share-ended"));
      } else if (m.event === "screen-video") {
        const data = bytes(String(m.b64));
        if (m.config) {
          config = data;
          pickConfig(data).then((c) => {
            decoderConfig = c;
            failures = 0;
            newDecoder();
            androidSend("screen-keyframe"); // the next full picture starts it
          });
          return;
        }
        if (!decoder || decoder.state !== "configured") return;
        const key = !!m.key;
        if (needKey && !key) return;
        needKey = false;
        // keep it live: if decoding falls behind, skip ahead to the next full picture
        if (decoder.decodeQueueSize > 8 && !key) return;
        decoder.decode(new EncodedVideoChunk({ type: key ? "key" : "delta", timestamp: Number(m.ts) || 0, data }));
      } else if (m.event === "screen-audio") {
        if (player) {
          const b = bytes(String(m.b64));
          player.port.postMessage(b.buffer, [b.buffer]);
        }
      }
    };

    androidSend("screen-start", want);
    // nothing at all within 60s (prompt left open): give up quietly
    setTimeout(() => {
      if (!done && !stopped) {
        stop();
        reject(new Error("Screen sharing didn't start"));
      }
    }, 60000);
  });
}
