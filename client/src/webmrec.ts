// Show recorder: draws come from a canvas, sound from an audio track; the video is encoded
// on the graphics card (WebCodecs, the same codec choice as screen sharing: AV1 on RTX 40 /
// RX 7000 / Arc, else H.264 on almost any card, else VP9/VP8 on the CPU), the sound as
// Opus, and both are written into a WebM file by our own small writer below. Pieces of the
// file come out every few seconds, in order, so they can be appended to disk or uploaded as
// they arrive — joined together they're a normal .webm video.
import { codecChoice, hardwareEncoders } from "./encoder";

export interface RecorderInfo {
  codec: string; // "AV1", "H.264", "VP9"...
  hardware: boolean;
  fps: number; // target
}

interface Pick {
  name: string;
  config: VideoEncoderConfig;
  webm: string; // Matroska codec id
  hardware: boolean;
}

/** Codec strings per resolution (the level has to allow the size and frame rate). */
function codecStrings(w: number, h: number) {
  const big = w * h > 2560 * 1440;
  return {
    av1: big ? "av01.0.13M.08" : "av01.0.12M.08",
    h264: ["avc1.640034", "avc1.4d0034", "avc1.420034"],
    vp9: big ? "vp09.00.51.08" : "vp09.00.41.08",
  };
}

async function supported(c: VideoEncoderConfig): Promise<boolean> {
  try {
    return !!(await VideoEncoder.isConfigSupported(c)).supported;
  } catch {
    return false;
  }
}

/** Tests only: try just this codec ("av1" | "h264" | "vp9" | "vp8"), on the processor. */
export const testing: { only?: string } = {};

/** The best encoder this PC has for a recording of this size. */
export async function pickVideoEncoder(w: number, h: number, fps: number, bitrate: number): Promise<Pick | null> {
  if (typeof VideoEncoder === "undefined") return null;
  const cs = codecStrings(w, h);
  const base = { width: w, height: h, framerate: fps, bitrate, latencyMode: "realtime" as const };
  if (testing.only) {
    const sw = { ...base, hardwareAcceleration: "prefer-software" as const };
    const t: Record<string, Pick> = {
      av1: { name: "AV1", webm: "V_AV1", hardware: false, config: { ...sw, codec: cs.av1 } },
      h264: { name: "H.264", webm: "V_MPEG4/ISO/AVC", hardware: false, config: { ...sw, codec: "avc1.42002a", avc: { format: "avc" } } as VideoEncoderConfig },
      vp9: { name: "VP9", webm: "V_VP9", hardware: false, config: { ...sw, codec: cs.vp9 } },
      vp8: { name: "VP8", webm: "V_VP8", hardware: false, config: { ...sw, codec: "vp8" } },
    };
    const p = t[testing.only];
    return p && (await supported(p.config)) ? p : null;
  }
  const choice = codecChoice();
  const hw = await hardwareEncoders().catch(() => ({}) as Record<string, boolean>);
  const tries: Pick[] = [];
  const av1 = (hardware: boolean): Pick => ({ name: "AV1", webm: "V_AV1", hardware, config: { ...base, codec: cs.av1, hardwareAcceleration: hardware ? "prefer-hardware" : "prefer-software" } });
  const h264 = (codec: string, hardware: boolean): Pick => ({ name: "H.264", webm: "V_MPEG4/ISO/AVC", hardware, config: { ...base, codec, avc: { format: "avc" }, hardwareAcceleration: hardware ? "prefer-hardware" : "prefer-software" } as VideoEncoderConfig });
  const vp9: Pick = { name: "VP9", webm: "V_VP9", hardware: false, config: { ...base, codec: cs.vp9 } };
  const vp8: Pick = { name: "VP8", webm: "V_VP8", hardware: false, config: { ...base, codec: "vp8" } };
  // the person's pick in Settings → Voice & Video comes first
  if (choice === "av1") tries.push(av1(true));
  if (choice === "h264") tries.push(...cs.h264.map((c) => h264(c, true)));
  if (choice === "vp9") tries.push(vp9);
  if (choice === "vp8") tries.push(vp8);
  if (hw.av1 !== false) tries.push(av1(true));
  tries.push(...cs.h264.map((c) => h264(c, true)));
  tries.push(vp9, vp8);
  for (const t of tries) if (await supported(t.config)) return t;
  return null;
}

// ------------------------------------------------------------------ WebM (Matroska) writer

type Bytes = Uint8Array;
const enc = new TextEncoder();

function concat(parts: Bytes[]): Bytes {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
function idBytes(id: number): Bytes {
  const b: number[] = [];
  while (id > 0) {
    b.unshift(id & 0xff);
    id = Math.floor(id / 256);
  }
  return Uint8Array.from(b);
}
function sizeBytes(n: number): Bytes {
  let len = 1;
  while (len < 8 && n >= 2 ** (7 * len) - 1) len++;
  const b = new Uint8Array(len);
  let v = n;
  for (let i = len - 1; i >= 0; i--) {
    b[i] = v % 256;
    v = Math.floor(v / 256);
  }
  b[0] |= 1 << (8 - len);
  return b;
}
const UNKNOWN_SIZE = Uint8Array.from([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
function el(id: number, ...body: Bytes[]): Bytes {
  const payload = concat(body);
  return concat([idBytes(id), sizeBytes(payload.length), payload]);
}
function uint(id: number, v: number): Bytes {
  const b: number[] = [];
  do {
    b.unshift(v % 256);
    v = Math.floor(v / 256);
  } while (v > 0);
  return el(id, Uint8Array.from(b));
}
function float(id: number, v: number): Bytes {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setFloat64(0, v);
  return el(id, b);
}
const str = (id: number, s: string) => el(id, enc.encode(s));

/** av1C box when the encoder didn't hand one over (profile 0, 8-bit 4:2:0). */
function av1C(codec: string): Bytes {
  const level = Number(codec.split(".")[2]?.slice(0, 2)) || 8;
  return Uint8Array.from([0x81, level & 0x1f, 0x0c, 0x00]);
}
function opusHead(): Bytes {
  const b = new Uint8Array(19);
  b.set(enc.encode("OpusHead"));
  const v = new DataView(b.buffer);
  v.setUint8(8, 1); // version
  v.setUint8(9, 2); // channels
  v.setUint16(10, 312, true); // pre-skip
  v.setUint32(12, 48000, true);
  v.setInt16(16, 0, true);
  v.setUint8(18, 0);
  return b;
}

interface Block {
  track: 1 | 2;
  ms: number;
  key: boolean;
  data: Bytes;
}

class WebmWriter {
  private pending: Block[] = [];
  private out: Bytes[] = [];
  private clusterMs = -1;
  private header: Bytes | null = null;
  private lastVideo = -1;
  private lastAudio = -1;

  constructor(
    private video: { codec: string; width: number; height: number },
    private audio: boolean,
  ) {}

  /** Call once the first video chunk tells us the codec's private data. */
  setHeader(videoPrivate: Bytes | null) {
    const v = this.video;
    const videoTrack = el(
      0xae,
      uint(0xd7, 1),
      uint(0x73c5, 1),
      uint(0x83, 1),
      str(0x86, v.codec),
      ...(videoPrivate ? [el(0x63a2, videoPrivate)] : []),
      el(0xe0, uint(0xb0, v.width), uint(0xba, v.height)),
    );
    const audioTrack = this.audio
      ? el(0xae, uint(0xd7, 2), uint(0x73c5, 2), uint(0x83, 2), str(0x86, "A_OPUS"), el(0x63a2, opusHead()), uint(0x56aa, 6_500_000), uint(0x56bb, 80_000_000), el(0xe1, float(0xb5, 48000), uint(0x9f, 2)))
      : new Uint8Array();
    this.header = concat([
      el(0x1a45dfa3, uint(0x4286, 1), uint(0x42f7, 1), uint(0x42f2, 4), uint(0x42f3, 8), str(0x4282, "webm"), uint(0x4287, 4), uint(0x4285, 2)),
      idBytes(0x18538067),
      UNKNOWN_SIZE, // Segment of unknown size: the file is written as it's recorded
      el(0x1549a966, uint(0x2ad7b1, 1_000_000), str(0x4d80, "Llamble"), str(0x5741, "Llamble")),
      el(0x1654ae6b, videoTrack, audioTrack),
    ]);
    this.out.push(this.header);
  }

  add(b: Block) {
    this.pending.push(b);
    if (b.track === 1) this.lastVideo = b.ms;
    else this.lastAudio = b.ms;
    // write everything both tracks have passed, in time order
    const upTo = this.audio && this.lastAudio >= 0 ? Math.min(this.lastVideo, this.lastAudio) : this.lastVideo;
    this.flush(upTo);
  }

  private flush(upTo: number) {
    if (!this.header) return;
    this.pending.sort((a, b) => a.ms - b.ms || a.track - b.track);
    let i = 0;
    for (; i < this.pending.length && this.pending[i].ms <= upTo; i++) this.write(this.pending[i]);
    this.pending.splice(0, i);
  }

  private write(b: Block) {
    // new cluster on each video key frame (every ~2 s), or before the 16-bit offset runs out
    if (this.clusterMs < 0 || (b.track === 1 && b.key) || b.ms - this.clusterMs > 30_000) {
      if (b.track !== 1 && this.clusterMs < 0) return; // start on a video key frame
      this.clusterMs = b.ms;
      this.out.push(idBytes(0x1f43b675), UNKNOWN_SIZE, uint(0xe7, b.ms));
    }
    const head = new Uint8Array(4);
    head[0] = 0x80 | b.track;
    new DataView(head.buffer).setInt16(1, Math.max(-32768, Math.min(32767, b.ms - this.clusterMs)));
    head[3] = b.key ? 0x80 : 0;
    this.out.push(el(0xa3, head, b.data));
  }

  /** Everything written since the last call. */
  take(final = false): Blob | null {
    if (final) this.flush(Infinity);
    if (!this.out.length) return null;
    const blob = new Blob(this.out as BlobPart[], { type: "video/webm" });
    this.out = [];
    return blob;
  }
}

// ------------------------------------------------------------------ recorder

export class CanvasRecorder {
  info: RecorderInfo | null = null;
  /** frames actually encoded in the last second (shows up in the recording panel) */
  fpsNow = 0;
  dropped = 0;
  private venc: VideoEncoder | null = null;
  private aenc: AudioEncoder | null = null;
  private writer: WebmWriter | null = null;
  private t0 = 0;
  private frames = 0;
  private lastKey = -1e9;
  private flushTimer = 0;
  private fpsTimer = 0;
  private framesThisSecond = 0;
  private reader: ReadableStreamDefaultReader<AudioData> | null = null;
  private audioFrames = 0;
  private stopped = false;
  private error: ((e: string) => void) | null = null;

  private constructor(
    private canvas: HTMLCanvasElement,
    private onPiece: (b: Blob) => void,
  ) {}

  /** null when this engine can't (no WebCodecs): the caller falls back to MediaRecorder. */
  static async start(canvas: HTMLCanvasElement, audio: MediaStreamTrack | null, fpsWanted: number, bitrate: number, onPiece: (b: Blob) => void, onError: (e: string) => void): Promise<CanvasRecorder | null> {
    if (typeof VideoEncoder === "undefined" || typeof VideoFrame === "undefined") return null;
    const pick = await pickVideoEncoder(canvas.width, canvas.height, fpsWanted, bitrate);
    if (!pick) return null;
    const fps = pick.hardware ? fpsWanted : Math.min(30, fpsWanted);
    const r = new CanvasRecorder(canvas, onPiece);
    r.error = onError;
    r.info = { codec: pick.name, hardware: pick.hardware, fps };
    const canAudio = !!audio && typeof AudioEncoder !== "undefined" && typeof (globalThis as any).MediaStreamTrackProcessor !== "undefined";
    r.writer = new WebmWriter({ codec: pick.webm, width: canvas.width, height: canvas.height }, canAudio);
    let headerDone = false;
    r.venc = new VideoEncoder({
      output: (chunk, meta) => {
        if (!headerDone) {
          const d = meta?.decoderConfig?.description;
          const priv = d ? new Uint8Array(d instanceof ArrayBuffer ? d : (d as ArrayBufferView).buffer.slice((d as ArrayBufferView).byteOffset, (d as ArrayBufferView).byteOffset + (d as ArrayBufferView).byteLength)) : pick.webm === "V_AV1" ? av1C(pick.config.codec) : null;
          r.writer!.setHeader(priv);
          headerDone = true;
        }
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        r.writer!.add({ track: 1, ms: Math.round(chunk.timestamp / 1000), key: chunk.type === "key", data });
        r.framesThisSecond++;
      },
      error: (e) => r.fail("video encoder: " + e.message),
    });
    r.venc.configure(pick.config);
    if (canAudio) {
      r.aenc = new AudioEncoder({
        output: (chunk) => {
          const data = new Uint8Array(chunk.byteLength);
          chunk.copyTo(data);
          r.writer!.add({ track: 2, ms: Math.round(chunk.timestamp / 1000), key: true, data });
        },
        error: (e) => r.fail("sound encoder: " + e.message),
      });
      r.aenc.configure({ codec: "opus", sampleRate: 48000, numberOfChannels: 2, bitrate: 160_000 });
      const proc = new (globalThis as any).MediaStreamTrackProcessor({ track: audio });
      r.reader = proc.readable.getReader();
    }
    r.t0 = performance.now();
    if (r.reader) r.pumpAudio();
    r.flushTimer = window.setInterval(() => {
      const b = r.writer?.take();
      if (b) onPiece(b);
    }, 4000);
    r.fpsTimer = window.setInterval(() => {
      r.fpsNow = r.framesThisSecond;
      r.framesThisSecond = 0;
    }, 1000);
    return r;
  }

  private fail(msg: string) {
    if (this.stopped) return;
    console.warn("[llamble] recorder", msg);
    this.error?.(msg);
  }

  /** Take the canvas as it is now as the next frame. */
  frame() {
    if (this.stopped || !this.venc || this.venc.state !== "configured") return;
    // the encoder is behind: skip this frame rather than pile up
    if (this.venc.encodeQueueSize > 4) {
      this.dropped++;
      return;
    }
    const us = Math.round((performance.now() - this.t0) * 1000);
    const f = new VideoFrame(this.canvas, { timestamp: us });
    const key = us - this.lastKey >= 2_000_000;
    if (key) this.lastKey = us;
    this.venc.encode(f, { keyFrame: key });
    f.close();
    this.frames++;
  }

  private async pumpAudio() {
    const reader = this.reader!;
    let base = -1;
    while (!this.stopped) {
      const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
      if (done || !value) break;
      try {
        if (!this.aenc || this.aenc.state !== "configured") continue;
        // re-time the sound on the recording's clock (samples counted from when it began)
        if (base < 0) base = Math.round((performance.now() - this.t0) * 1000);
        const n = value.numberOfFrames;
        const ch = value.numberOfChannels;
        const planes = new Float32Array(n * 2);
        for (let c = 0; c < 2; c++) value.copyTo(planes.subarray(c * n, (c + 1) * n), { planeIndex: Math.min(c, ch - 1), format: "f32-planar" });
        const data = new AudioData({ format: "f32-planar", sampleRate: value.sampleRate, numberOfFrames: n, numberOfChannels: 2, timestamp: base + Math.round((this.audioFrames / value.sampleRate) * 1e6), data: planes });
        this.audioFrames += n;
        this.aenc.encode(data);
        data.close();
      } finally {
        value.close();
      }
    }
  }

  async stop(): Promise<Blob | null> {
    if (this.stopped) return null;
    this.stopped = true;
    clearInterval(this.flushTimer);
    clearInterval(this.fpsTimer);
    this.reader?.cancel().catch(() => {});
    try {
      if (this.venc?.state === "configured") await this.venc.flush();
    } catch {}
    // the sound encoder's final flush can hand back a malformed padding packet in some
    // engine versions; the last <20 ms of sound isn't worth a broken file, so just close it
    this.venc?.close();
    this.aenc?.close();
    return this.writer?.take(true) ?? null;
  }
}
