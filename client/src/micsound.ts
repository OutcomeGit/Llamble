// Mic sound settings: presets from lowest to highest fidelity, each "with helpers" or
// "raw", plus every individual setting. Changing anything shows "Custom (<bitrate>)".

export type NoiseMode = "off" | "browser" | "rnnoise" | "gtcrn";

export interface MicSound {
  bitrate: number;
  stereo: boolean;
  noise: NoiseMode;
  echoCancellation: boolean;
  autoGainControl: boolean;
  /** DTX: send almost nothing while you're silent */
  trimSilence: boolean;
  /** RED: each packet also carries a copy of the previous one, so a lost packet is rebuilt */
  repairPackets: boolean;
  /** mic volume in dB (-20..+20) */
  gainDb: number;
  /** noise gate: only send sound louder than this (dB); null = off */
  gateDb: number | null;
  /** cut rumble below ~80 Hz */
  lowCut: boolean;
  /** even out loud peaks */
  compressor: boolean;
  /** tone, dB each (-12..+12) */
  bassDb: number;
  midDb: number;
  trebleDb: number;
}

const SHAPING = { gainDb: 0, gateDb: null, lowCut: false, compressor: false, bassDb: 0, midDb: 0, trebleDb: 0 } as const;

const helpers = (bitrate: number): MicSound => ({
  bitrate,
  stereo: false,
  noise: "rnnoise",
  echoCancellation: true,
  autoGainControl: true,
  trimSilence: true,
  repairPackets: true,
  ...SHAPING,
});

const raw = (bitrate: number): MicSound => ({
  bitrate,
  stereo: true,
  noise: "off",
  echoCancellation: false,
  autoGainControl: false,
  trimSilence: false,
  repairPackets: false,
  ...SHAPING,
});

export interface Level {
  id: string;
  label: string;
  bitrate: number;
  about: string;
}

/** Lowest to highest fidelity. */
export const LEVELS: Level[] = [
  { id: "saver", label: "Data saver", bitrate: 32000, about: "For weak connections or phone data. Speech stays clear but sounds flat." },
  { id: "standard", label: "Standard", bitrate: 96000, about: "Clearly better than most call apps (Discord's normal is 64 kbps)." },
  { id: "rich", label: "Rich", bitrate: 256000, about: "Full, detailed voice. What Discord allows on servers with 7 boosts." },
  { id: "high", label: "High", bitrate: 448000, about: "Above Discord's maximum (384 kbps, only on servers with 14 boosts)." },
  { id: "max", label: "Maximum", bitrate: 510000, about: "The most Opus can send. Few people can hear a difference from High." },
];

export const HELPERS_ABOUT =
  "With helpers: AI noise suppression removes fans, keyboards and hum; echo cancellation lets you use speakers; auto volume evens you out; silence is trimmed to save data; repair packets rebuild sound lost on shaky Wi-Fi (doubles the data).";
export const RAW_ABOUT =
  "Raw: everything off. Your mic exactly as it is, in stereo if it's a stereo mic. Use headphones (others hear echo otherwise); room noise comes through.";

export const PRESETS: { id: string; level: Level; raw: boolean; sound: MicSound }[] = LEVELS.flatMap((l) => [
  { id: l.id, level: l, raw: false, sound: helpers(l.bitrate) },
  { id: l.id + "-raw", level: l, raw: true, sound: raw(l.bitrate) },
]);

export const DEFAULT_PRESET = "high";
export const DEFAULT_SOUND: MicSound = helpers(448000);

/** The main Opus bitrates. */
export const BITRATES = [8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, 448, 510].map((k) => k * 1000);

export function presetFor(m: MicSound): (typeof PRESETS)[number] | undefined {
  return PRESETS.find((p) => (Object.keys(m) as (keyof MicSound)[]).every((k) => p.sound[k] === m[k]));
}

export function presetLabel(m: MicSound): string {
  const p = presetFor(m);
  if (p) return `${p.level.label} · ${p.raw ? "raw" : "with helpers"}`;
  return `Custom (${Math.round(m.bitrate / 1000)} kbps)`;
}

/** Anything that needs our own audio chain (vs. the browser's built-in processing only). */
export function needsChain(m: MicSound): boolean {
  return (
    m.noise === "rnnoise" ||
    m.noise === "gtcrn" ||
    m.gainDb !== 0 ||
    m.gateDb !== null ||
    m.lowCut ||
    m.compressor ||
    m.bassDb !== 0 ||
    m.midDb !== 0 ||
    m.trebleDb !== 0
  );
}

// ---- push-to-talk ----
export interface PushToTalk {
  on: boolean;
  /** KeyboardEvent.code, or Mouse3/Mouse4/Mouse5 */
  key: string;
  /** keep the mic open this long after letting go (ms), so word endings aren't cut */
  releaseMs: number;
}

/** Windows virtual-key codes for the keys people use for push-to-talk. */
export function virtualKey(code: string): number {
  if (code === "Mouse3") return 0x04;
  if (code === "Mouse4") return 0x05;
  if (code === "Mouse5") return 0x06;
  let m = /^Key([A-Z])$/.exec(code);
  if (m) return m[1].charCodeAt(0);
  m = /^Digit(\d)$/.exec(code);
  if (m) return 0x30 + Number(m[1]);
  m = /^Numpad(\d)$/.exec(code);
  if (m) return 0x60 + Number(m[1]);
  m = /^F(\d{1,2})$/.exec(code);
  if (m && Number(m[1]) >= 1 && Number(m[1]) <= 24) return 0x6f + Number(m[1]);
  const table: Record<string, number> = {
    Space: 0x20, Tab: 0x09, CapsLock: 0x14, Backquote: 0xc0, Minus: 0xbd, Equal: 0xbb, BracketLeft: 0xdb, BracketRight: 0xdd,
    Backslash: 0xdc, Semicolon: 0xba, Quote: 0xde, Comma: 0xbc, Period: 0xbe, Slash: 0xbf,
    ShiftLeft: 0xa0, ShiftRight: 0xa1, ControlLeft: 0xa2, ControlRight: 0xa3, AltLeft: 0xa4, AltRight: 0xa5,
    Insert: 0x2d, Delete: 0x2e, Home: 0x24, End: 0x23, PageUp: 0x21, PageDown: 0x22, Pause: 0x13, ScrollLock: 0x91,
    ArrowUp: 0x26, ArrowDown: 0x28, ArrowLeft: 0x25, ArrowRight: 0x27,
    NumpadAdd: 0x6b, NumpadSubtract: 0x6d, NumpadMultiply: 0x6a, NumpadDivide: 0x6f, NumpadDecimal: 0x6e, NumpadEnter: 0x0d,
  };
  return table[code] ?? 0;
}

export function keyLabel(code: string): string {
  if (code === "Mouse3") return "Middle mouse button";
  if (code === "Mouse4") return "Mouse side button (back)";
  if (code === "Mouse5") return "Mouse side button (forward)";
  return code.replace(/^Key/, "").replace(/^Digit/, "").replace(/Left$/, " (left)").replace(/Right$/, " (right)").replace(/^Numpad/, "Numpad ");
}
