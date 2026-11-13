// Recording your screen or a game on this PC (the Windows app): the helper program records
// it on the graphics card to an MP4 in Videos\Llamble, like dedicated recording apps do.
// Nothing goes through a call, nobody else is involved; the file shows up in Library →
// Recordings. (Shows, with several people and a director, are show.ts.)
import { create } from "zustand";
import { openModal, toast } from "./ui";

export type RecQuality = "good" | "great" | "max";
/**
 * Bits per pixel per frame. The helper multiplies by the real size and frame rate, so at
 * 1440p 60 fps: good ≈ 25, great ≈ 45, max ≈ 80 Mbps (a 4K screen gets about 2.25× that).
 * 30 fps gets a bit more per frame (each frame has to carry more change).
 */
export function recBpp(q: RecQuality, fps: 30 | 60): number {
  const base = { good: 0.113, great: 0.2, max: 0.36 }[q];
  return fps === 60 ? base : base * 1.3;
}

interface RecState {
  active: { id: string; startedAt: number; codec: string; gpu: boolean; width: number; height: number; bitrate: number; sound: string } | null;
  fps: number;
  dropped: number;
  bytes: number;
  error: string | null;
  stopping: boolean;
}
export const useNativeRec = create<RecState>(() => ({ active: null, fps: 0, dropped: 0, bytes: 0, error: null, stopping: false }));

/** Can this app record natively? (The Windows app.) */
export const canRecordNatively = () => !!window.llambleNative?.nativeRec;

/** Open the picker in recording mode. */
export function pickRecording() {
  if (!canRecordNatively()) {
    toast("Recording your screen needs the Windows app.", "error");
    return;
  }
  openModal({ kind: "screenPicker", mode: "record" });
}

let off: (() => void) | null = null;

/** Recording size: the height (width follows the shape), or 0 for exactly what's captured. */
export type RecSize = 0 | 1080 | 1440 | 2160;

export async function startRecording(sourceId: string, fps: 30 | 60, quality: RecQuality, sound: "app" | "all" | "off", size: RecSize = 0, title = "") {
  const n = window.llambleNative?.nativeRec;
  if (!n || useNativeRec.getState().active) return;
  const id = "clip-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  useNativeRec.setState({ error: null, fps: 0, dropped: 0, bytes: 0, stopping: false });
  off ??= n.on((kind, v) => {
    const cur = useNativeRec.getState().active;
    if (!cur || v.id !== cur.id) return;
    if (kind === "stat") {
      if (v.error) useNativeRec.setState({ error: v.error });
      else useNativeRec.setState({ fps: v.fps ?? 0, dropped: v.dropped ?? 0, bytes: v.bytes ?? 0 });
    } else {
      useNativeRec.setState({ active: null, stopping: false });
      toast(v.ok ? "Recording saved — it's in Library → Recordings" : "The recording stopped unexpectedly; what was recorded is in Library → Recordings", v.ok ? "info" : "error");
    }
  });
  const r = await n.start({ id, sourceId, fps, bpp: recBpp(quality, fps), sound, height: size || undefined, title });
  if ("error" in r) {
    useNativeRec.setState({ error: r.error });
    toast("Couldn't start recording: " + r.error, "error");
    return;
  }
  useNativeRec.setState({ active: { id: r.id, startedAt: Date.now(), codec: r.codec, gpu: r.gpu, width: r.width, height: r.height, bitrate: r.bitrate, sound: r.sound } });
}

export async function stopRecording() {
  const n = window.llambleNative?.nativeRec;
  if (!n || !useNativeRec.getState().active) return;
  useNativeRec.setState({ stopping: true });
  await n.stop();
}
