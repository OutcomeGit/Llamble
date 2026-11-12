// Picks the show recorder's video encoder: the same codec choice as screen sharing (AV1 on
// RTX 40 / RX 7000 / Arc, else H.264 on almost any graphics card, else VP9/VP8 on the CPU).
// The recording itself runs in recworker.ts.
import { codecChoice, hardwareEncoders } from "./encoder";

export interface RecorderInfo {
  codec: string; // "AV1", "H.264", "VP9"...
  hardware: boolean;
  fps: number; // target
}

export interface Pick {
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
