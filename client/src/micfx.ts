// The audio chain your mic goes through before it's sent (only when a setting needs it):
//   mic → low-cut → AI noise suppression → tone (bass/mid/treble) → compressor → volume → noise gate → call
// The noise suppressors and gate are open-source (RNNoise, GTCRN; @sapphi-red/web-noise-suppressor,
// MIT) and run from Llamble's own files.
import { GtcrnWorkletNode, NoiseGateWorkletNode, RnnoiseWorkletNode, loadGtcrn, loadRnnoise } from "@sapphi-red/web-noise-suppressor";
import type { AudioProcessorOptions, Track, TrackProcessor } from "livekit-client";
import type { MicSound } from "./micsound";

function base(): string {
  // the Windows app loads pages from disk, where audio modules can't load; it serves them here
  return window.llambleNative ? "llamble-asset://audio/" : new URL("audio/", location.href).href;
}

const modules = new WeakMap<BaseAudioContext, Map<string, Promise<void>>>();
function addModule(ctx: BaseAudioContext, file: string): Promise<void> {
  let m = modules.get(ctx);
  if (!m) modules.set(ctx, (m = new Map()));
  let p = m.get(file);
  if (!p) {
    p = ctx.audioWorklet.addModule(base() + file);
    p.catch(() => m!.delete(file));
    m.set(file, p);
  }
  return p;
}

let rnnoise: Promise<ArrayBuffer> | null = null;
let gtcrn: Promise<ArrayBuffer> | null = null;
const rnnoiseBinary = () => (rnnoise ??= loadRnnoise({ url: base() + "rnnoise.wasm", simdUrl: base() + "rnnoise_simd.wasm" }).catch((e) => ((rnnoise = null), Promise.reject(e))));
const gtcrnBinary = () => (gtcrn ??= loadGtcrn({ url: base() + "gtcrn.wasm" }).catch((e) => ((gtcrn = null), Promise.reject(e))));

let shared: AudioContext | null = null;
/** One 48 kHz context for the mic chain (RNNoise works at 48 kHz). */
export function micContext(): AudioContext {
  if (!shared || shared.state === "closed") shared = new AudioContext({ sampleRate: 48000, latencyHint: "interactive" });
  if (shared.state === "suspended") shared.resume().catch(() => {});
  return shared;
}

export interface Chain {
  output: MediaStreamTrack;
  /** last node before the output, for "hear myself" */
  tail: AudioNode;
  destroy(): void;
}

export async function buildChain(ctx: AudioContext, input: MediaStreamTrack, m: MicSound): Promise<Chain> {
  const chans = m.stereo ? 2 : 1;
  const nodes: AudioNode[] = [];
  const cleanups: (() => void)[] = [];
  const add = (n: AudioNode) => {
    if (nodes.length) nodes[nodes.length - 1].connect(n);
    nodes.push(n);
    return n;
  };
  add(ctx.createMediaStreamSource(new MediaStream([input])));

  if (m.lowCut) {
    const f = ctx.createBiquadFilter();
    f.type = "highpass";
    f.frequency.value = 80;
    f.Q.value = 0.7;
    add(f);
  }
  if (m.noise === "rnnoise") {
    await addModule(ctx, "rnnoiseWorklet.js");
    const n = new RnnoiseWorkletNode(ctx, { maxChannels: chans, wasmBinary: (await rnnoiseBinary()).slice(0) });
    cleanups.push(() => n.destroy());
    add(n);
  } else if (m.noise === "gtcrn") {
    await addModule(ctx, "gtcrnWorklet.js");
    const n = new GtcrnWorkletNode(ctx, { maxChannels: chans, wasmBinary: (await gtcrnBinary()).slice(0) });
    cleanups.push(() => n.destroy());
    add(n);
  }
  const tone = (type: BiquadFilterType, freq: number, db: number) => {
    if (!db) return;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.gain.value = db;
    if (type === "peaking") f.Q.value = 0.9;
    add(f);
  };
  tone("lowshelf", 200, m.bassDb);
  tone("peaking", 1200, m.midDb);
  tone("highshelf", 4500, m.trebleDb);
  if (m.compressor) {
    const c = ctx.createDynamicsCompressor();
    c.threshold.value = -24;
    c.knee.value = 12;
    c.ratio.value = 4;
    c.attack.value = 0.005;
    c.release.value = 0.2;
    add(c);
    // make up most of what the compressor takes off
    const g = ctx.createGain();
    g.gain.value = 1.6;
    add(g);
  }
  if (m.gainDb) {
    const g = ctx.createGain();
    g.gain.value = Math.pow(10, m.gainDb / 20);
    add(g);
  }
  if (m.gateDb !== null) {
    await addModule(ctx, "noiseGateWorklet.js");
    add(new NoiseGateWorkletNode(ctx, { openThreshold: m.gateDb, closeThreshold: m.gateDb - 6, holdMs: 250, maxChannels: chans }));
  }
  const dest = ctx.createMediaStreamDestination();
  dest.channelCount = chans;
  dest.channelCountMode = "explicit";
  const tail = nodes[nodes.length - 1];
  tail.connect(dest);
  return {
    output: dest.stream.getAudioTracks()[0],
    tail,
    destroy() {
      for (const n of nodes) {
        try {
          n.disconnect();
        } catch {}
      }
      cleanups.forEach((f) => {
        try {
          f();
        } catch {}
      });
      dest.stream.getTracks().forEach((t) => t.stop());
    },
  };
}

/** LiveKit processor: the published mic track becomes the chain's output. */
export class MicProcessor implements TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> {
  name = "llamble-mic";
  processedTrack?: MediaStreamTrack;
  private chain?: Chain;
  constructor(readonly sound: MicSound) {}
  async init(opts: AudioProcessorOptions) {
    this.chain = await buildChain(opts.audioContext, opts.track, this.sound);
    this.processedTrack = this.chain.output;
  }
  async restart(opts: AudioProcessorOptions) {
    await this.destroy();
    await this.init(opts);
  }
  async destroy() {
    this.chain?.destroy();
    this.chain = undefined;
  }
}
