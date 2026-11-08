// Which video codec to send with. "Automatic" picks the best one this PC's graphics
// card can encode in hardware — AV1 (RTX 40, Radeon RX 7000, Intel Arc and newer),
// else H.264 (nearly any NVIDIA, AMD or Intel graphics from the last decade) —
// and otherwise the codec that's cheapest on the CPU (VP9 for screens, VP8 for
// cameras). After publishing we check what the browser engine actually did: if
// it fell back to encoding on the CPU (blocked driver, busy encoder...), that
// codec is skipped on this PC for a week and the video switches over by itself.
import type { LocalVideoTrack, VideoCodec } from "livekit-client";
import { create } from "zustand";

export type CodecChoice = "auto" | "av1" | "h264" | "vp9" | "vp8";
export type VideoKind = "camera" | "screen";

export interface EncoderInfo {
  codec: string;
  hardware: boolean | null; // null = the browser didn't say
  impl: string;
}

export const useEncoder = create<{ camera?: EncoderInfo; screen?: EncoderInfo; hw?: Record<string, boolean> }>(() => ({}));

export const CODEC_LABELS: Record<CodecChoice, string> = {
  auto: "Automatic (best for your graphics card)",
  av1: "AV1 (best quality per bit; needs RTX 40 / RX 7000 / Arc for hardware)",
  h264: "H.264 (hardware on almost any graphics card)",
  vp9: "VP9 (good quality, uses the CPU)",
  vp8: "VP8 (lightest on the CPU, lowest quality)",
};

export function codecChoice(): CodecChoice {
  return (localStorage.getItem("llamble.videoCodec") as CodecChoice) || "auto";
}

export function setCodecChoice(c: CodecChoice) {
  localStorage.setItem("llamble.videoCodec", c);
}

const WEEK = 7 * 24 * 3600 * 1000;
function isBad(codec: string): boolean {
  const t = Number(localStorage.getItem("llamble.hwBad." + codec) || 0);
  return Date.now() - t < WEEK;
}
function markBad(codec: string) {
  localStorage.setItem("llamble.hwBad." + codec, String(Date.now()));
}
export function clearBad() {
  for (const c of ["av1", "h264"]) localStorage.removeItem("llamble.hwBad." + c);
}

/** Codecs this browser can send over WebRTC at all. */
function sendable(): Set<string> {
  try {
    const caps = RTCRtpSender.getCapabilities("video")?.codecs || [];
    return new Set(caps.map((c) => c.mimeType.toLowerCase().replace("video/", "")));
  } catch {
    return new Set(["vp8", "vp9", "h264"]);
  }
}

const WEBCODECS: Record<string, string> = { av1: "av01.0.08M.08", h264: "avc1.42E028", vp9: "vp09.00.40.08" };
let hwProbe: Promise<Record<string, boolean>> | null = null;

/** Which codecs the graphics card can encode (asked through WebCodecs, which reports hardware support). */
export function hardwareEncoders(): Promise<Record<string, boolean>> {
  if (hwProbe) return hwProbe;
  hwProbe = (async () => {
    const out: Record<string, boolean> = { av1: false, h264: false, vp9: false };
    const VE = (globalThis as any).VideoEncoder;
    if (!VE?.isConfigSupported) return out;
    for (const [codec, str] of Object.entries(WEBCODECS)) {
      try {
        const r = await VE.isConfigSupported({ codec: str, width: 1920, height: 1080, bitrate: 4_000_000, framerate: 30, hardwareAcceleration: "prefer-hardware" });
        out[codec] = !!r?.supported;
      } catch {}
    }
    useEncoder.setState({ hw: out });
    return out;
  })();
  return hwProbe;
}

const isChromeOS = () => /\bCrOS\b/.test(navigator.userAgent);

/** The codec to publish with right now. */
export async function pickCodec(kind: VideoKind): Promise<VideoCodec> {
  const can = sendable();
  const choice = codecChoice();
  if (choice !== "auto" && can.has(choice)) return choice as VideoCodec;
  // Chromebooks encode H.264 in hardware; their VP9 encoder can send black frames
  if (isChromeOS() && can.has("h264")) return "h264";
  const hw = await hardwareEncoders();
  if (hw.av1 && can.has("av1") && !isBad("av1")) return "av1";
  if (hw.h264 && can.has("h264") && !isBad("h264")) return "h264";
  return kind === "screen" && can.has("vp9") ? "vp9" : "vp8";
}

/** AV1 and VP9 get a backup copy (VP8/H.264) for viewers whose device can't decode them. */
export function needsBackup(codec: VideoCodec): boolean {
  return codec === "av1" || codec === "vp9";
}

async function readEncoder(track: LocalVideoTrack): Promise<EncoderInfo | null> {
  const sender = (track as any).sender as RTCRtpSender | undefined;
  if (!sender) return null;
  const stats = await sender.getStats();
  let impl = "";
  let hardware: boolean | null = null;
  let codecId = "";
  const codecs: Record<string, string> = {};
  stats.forEach((s: any) => {
    if (s.type === "codec") codecs[s.id] = String(s.mimeType || "").replace("video/", "");
    if (s.type === "outbound-rtp" && s.kind === "video" && (s.framesEncoded || 0) > 0) {
      impl = s.encoderImplementation || impl;
      if (typeof s.powerEfficientEncoder === "boolean") hardware = hardware === true ? true : s.powerEfficientEncoder;
      codecId = s.codecId || codecId;
    }
  });
  if (!impl && hardware === null) return null;
  if (hardware === null && impl) {
    if (/libaom|libvpx|openh264|dav1d|svt/i.test(impl)) hardware = false;
    else if (/mediafoundation|nvenc|amf|qsv|vaapi|videotoolbox|accelerat|external/i.test(impl)) hardware = true;
  }
  return { codec: codecs[codecId] || "", hardware, impl };
}

/**
 * Check what's encoding a just-published video. Returns the codec to switch to when an
 * automatically chosen hardware codec turned out to run on the CPU, else null.
 */
export async function verifyEncoder(kind: VideoKind, track: LocalVideoTrack, codec: VideoCodec): Promise<VideoCodec | null> {
  let info: EncoderInfo | null = null;
  for (let i = 0; i < 6 && !info; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    info = await readEncoder(track).catch(() => null);
  }
  if (!info) return null;
  useEncoder.setState({ [kind]: info });
  if (codecChoice() !== "auto" || info.hardware !== false) return null;
  if (codec !== "av1" && codec !== "h264") return null;
  markBad(codec);
  const next = await pickCodec(kind);
  return next !== codec ? next : null;
}

export function describe(info: EncoderInfo | undefined): string {
  if (!info) return "—";
  const name = (info.codec || "?").toUpperCase();
  const where = info.hardware === true ? "on your graphics card" : info.hardware === false ? "on the CPU" : "";
  return `${name} ${where}`.trim() + (info.impl ? ` (${info.impl})` : "");
}
