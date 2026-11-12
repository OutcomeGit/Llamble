// The show recorder's background thread. Everything heavy happens here, away from the
// app's main thread (which runs the interface, chat and the call):
//  - the newest picture from every source (game/screen, cameras) arrives straight from the
//    capture as a VideoFrame;
//  - a frame is recorded when the main shot's source delivers one (paced by the game, not a
//    timer), at most at the chosen frame rate;
//  - when the shot is one full-screen picture with nothing on top and the right size, that
//    frame goes straight to the encoder untouched; otherwise the scene is painted here;
//  - video is encoded on the graphics card, sound as Opus, and both are written to WebM in
//    pieces posted back every few seconds.
import { drawScene, soloItem, type Frame, type Scene } from "./showscene";
import { av1C, WebmWriter } from "./webmwriter";

type In =
  | { type: "start"; w: number; h: number; fps: number; config: VideoEncoderConfig; webm: string; audio: ReadableStream<AudioData> | null }
  | { type: "add"; key: string; frames: ReadableStream<VideoFrame> }
  | { type: "drop"; key: string }
  | { type: "scene"; scene: Scene }
  | { type: "preview"; canvas: OffscreenCanvas | null }
  | { type: "stop" };

const post = (m: unknown, t: Transferable[] = []) => (self as unknown as Worker).postMessage(m, t);

let W = 1920;
let H = 1080;
let fps = 60;
let venc: VideoEncoder | null = null;
let aenc: AudioEncoder | null = null;
let writer: WebmWriter | null = null;
let canvas: OffscreenCanvas | null = null;
let ctx: OffscreenCanvasRenderingContext2D | null = null;
let preview: OffscreenCanvas | null = null;
let pctx: OffscreenCanvasRenderingContext2D | null = null;
let lastPreview = 0;
let scene: Scene = { items: [] };
let t0 = 0;
let lastEnc = -1e9;
let lastKeyUs = -1e9;
let lastDriverFrame = 0;
let stopped = false;
let encoded = 0;
let dropped = 0;
let timers: number[] = [];
const latest = new Map<string, VideoFrame>();
const readers = new Map<string, ReadableStreamDefaultReader<VideoFrame>>();

function frameOf(key: string): Frame | null {
  const f = latest.get(key);
  return f ? { img: f, w: f.displayWidth, h: f.displayHeight } : null;
}

/** The source whose new frames drive recording: the main shot. */
const driver = () => scene.items[0]?.key ?? null;

function tick() {
  if (stopped || !venc || venc.state !== "configured") return;
  const now = performance.now();
  if (now - lastEnc < 1000 / fps - 2) return; // faster than the chosen frame rate: skip
  // quality mode keeps a few frames in hand to look ahead; only skip when it's really behind
  if (venc.encodeQueueSize > 8) {
    dropped++; // the encoder is behind: skip rather than pile up
    return;
  }
  const us = Math.round((now - t0) * 1000);
  const solo = soloItem(scene);
  const sf = solo ? latest.get(solo.key) : undefined;
  let frame: VideoFrame;
  if (sf && sf.displayWidth === W && sf.displayHeight === H) {
    frame = new VideoFrame(sf, { timestamp: us }); // untouched: straight to the encoder
  } else {
    drawScene(ctx!, W, H, scene, frameOf);
    frame = new VideoFrame(canvas!, { timestamp: us });
  }
  const key = us - lastKeyUs >= 2_000_000;
  if (key) lastKeyUs = us;
  venc.encode(frame, { keyFrame: key });
  frame.close();
  lastEnc = now;
  encoded++;
  // the director's preview, a few times a second
  if (pctx && preview && now - lastPreview > 100) {
    lastPreview = now;
    if (sf && sf.displayWidth === W && sf.displayHeight === H) pctx.drawImage(sf, 0, 0, preview.width, preview.height);
    else pctx.drawImage(canvas!, 0, 0, preview.width, preview.height);
  }
}

async function pumpFrames(key: string, reader: ReadableStreamDefaultReader<VideoFrame>) {
  for (;;) {
    const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }) as const);
    if (done || !value) break;
    if (readers.get(key) !== reader) {
      value.close();
      break;
    }
    latest.get(key)?.close();
    latest.set(key, value);
    if (key === driver()) {
      lastDriverFrame = performance.now();
      tick();
    }
  }
}

async function pumpAudio(stream: ReadableStream<AudioData>) {
  const reader = stream.getReader();
  let base = -1;
  let frames = 0;
  while (!stopped) {
    const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }) as const);
    if (done || !value) break;
    try {
      if (!aenc || aenc.state !== "configured") continue;
      // re-time the sound on the recording's clock (samples counted from when it began)
      if (base < 0) base = Math.round((performance.now() - t0) * 1000);
      const n = value.numberOfFrames;
      const ch = value.numberOfChannels;
      const planes = new Float32Array(n * 2);
      for (let c = 0; c < 2; c++) value.copyTo(planes.subarray(c * n, (c + 1) * n), { planeIndex: Math.min(c, ch - 1), format: "f32-planar" });
      const data = new AudioData({ format: "f32-planar", sampleRate: value.sampleRate, numberOfFrames: n, numberOfChannels: 2, timestamp: base + Math.round((frames / value.sampleRate) * 1e6), data: planes });
      frames += n;
      aenc.encode(data);
      data.close();
    } finally {
      value.close();
    }
  }
  reader.cancel().catch(() => {});
}

function start(m: Extract<In, { type: "start" }>) {
  W = m.w;
  H = m.h;
  fps = m.fps;
  canvas = new OffscreenCanvas(W, H);
  ctx = canvas.getContext("2d", { alpha: false, desynchronized: true }) as OffscreenCanvasRenderingContext2D;
  writer = new WebmWriter({ codec: m.webm, width: W, height: H }, !!m.audio);
  let headerDone = false;
  venc = new VideoEncoder({
    output: (chunk, meta) => {
      if (!headerDone) {
        const d = meta?.decoderConfig?.description as ArrayBuffer | ArrayBufferView | undefined;
        const priv = d ? (d instanceof ArrayBuffer ? new Uint8Array(d) : new Uint8Array(d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength))) : m.webm === "V_AV1" ? av1C(m.config.codec) : null;
        writer!.setHeader(priv);
        headerDone = true;
      }
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      writer!.add({ track: 1, ms: Math.round(chunk.timestamp / 1000), key: chunk.type === "key", data });
    },
    error: (e) => post({ type: "error", message: "video encoder: " + e.message }),
  });
  venc.configure(m.config);
  if (m.audio) {
    aenc = new AudioEncoder({
      output: (chunk) => {
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        writer!.add({ track: 2, ms: Math.round(chunk.timestamp / 1000), key: true, data });
      },
      error: (e) => post({ type: "error", message: "sound encoder: " + e.message }),
    });
    aenc.configure({ codec: "opus", sampleRate: 48000, numberOfChannels: 2, bitrate: 160_000 });
    pumpAudio(m.audio);
  }
  t0 = performance.now();
  timers = [
    // pieces of the file
    self.setInterval(() => {
      const b = writer?.take();
      if (b) post({ type: "piece", blob: b });
    }, 4000),
    // how it's keeping up
    self.setInterval(() => {
      post({ type: "fps", now: encoded, dropped });
      encoded = 0;
    }, 1000),
    // nothing driving (voice-only, a card, a frozen source): keep the picture going at 15 fps
    self.setInterval(() => {
      if (performance.now() - lastDriverFrame > 250) tick();
    }, 66),
  ];
}

async function stop() {
  if (stopped) return;
  stopped = true;
  timers.forEach((t) => clearInterval(t));
  for (const r of readers.values()) r.cancel().catch(() => {});
  readers.clear();
  try {
    if (venc?.state === "configured") await venc.flush();
  } catch {}
  // the sound encoder's final flush can hand back a malformed padding packet in some engine
  // versions; the last <20 ms of sound isn't worth a broken file, so just close it
  try {
    venc?.close();
    aenc?.close();
  } catch {}
  for (const f of latest.values()) f.close();
  latest.clear();
  const last = writer?.take(true);
  post({ type: "stopped", blob: last ?? null });
}

self.onmessage = (e: MessageEvent<In>) => {
  const m = e.data;
  if (m.type === "start") start(m);
  else if (m.type === "add") {
    readers.get(m.key)?.cancel().catch(() => {});
    const r = m.frames.getReader();
    readers.set(m.key, r);
    pumpFrames(m.key, r);
  } else if (m.type === "drop") {
    readers.get(m.key)?.cancel().catch(() => {});
    readers.delete(m.key);
    latest.get(m.key)?.close();
    latest.delete(m.key);
  } else if (m.type === "scene") scene = m.scene;
  else if (m.type === "preview") {
    preview = m.canvas;
    pctx = preview ? (preview.getContext("2d") as OffscreenCanvasRenderingContext2D) : null;
  } else if (m.type === "stop") stop();
};
