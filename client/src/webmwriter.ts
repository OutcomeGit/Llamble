// A small streaming WebM (Matroska) writer: one video track (AV1, H.264, VP9 or VP8) and
// one Opus sound track, written as it records, in pieces that join into one normal file.
// No imports, so the recorder's background thread can use it.

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
export function av1C(codec: string): Bytes {
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

export interface Block {
  track: 1 | 2;
  ms: number;
  key: boolean;
  data: Bytes;
}

export class WebmWriter {
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

  private lastMs: Record<number, number> = { 1: -1, 2: -1 };

  add(b: Block) {
    // times are whole milliseconds: two frames drawn within the same one must still move forward
    if (b.ms <= this.lastMs[b.track]) b.ms = this.lastMs[b.track] + 1;
    this.lastMs[b.track] = b.ms;
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

