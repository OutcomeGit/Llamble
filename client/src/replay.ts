// Instant replay (Windows app): the helper keeps the last 30 s – 5 min of your game (or main
// screen) in memory, encoded on the graphics card, and Alt+F10 saves it as a clip to
// Library → Recordings. Off unless turned on; nothing leaves your PC.
import { create } from "zustand";
import { toast } from "./ui";
import { recBpp, type RecQuality } from "./nativerec";

export interface ReplayPrefs {
  on: boolean;
  keep: 30 | 60 | 120 | 300;
  sound: "app" | "all" | "off";
  fps: 30 | 60;
  quality: RecQuality;
}
const KEY = "llamble.replay";
const DEFAULTS: ReplayPrefs = { on: false, keep: 60, sound: "app", fps: 60, quality: "great" };

export function replayPrefs(): ReplayPrefs {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || "{}") };
  } catch {
    return DEFAULTS;
  }
}

export const useReplay = create<{ prefs: ReplayPrefs; running: { codec: string; gpu: boolean; width: number; height: number; target: string } | null; error: string | null; saving: boolean }>(() => ({
  prefs: replayPrefs(),
  running: null,
  error: null,
  saving: false,
}));

export const canReplay = () => !!(window.llambleNative as any)?.replay;

const native = () => (window.llambleNative as any)?.replay as
  | { set: (o: unknown) => Promise<void>; save: (secs?: number) => Promise<{ id?: string; secs?: number; error?: string }>; on: (cb: (kind: string, v: any) => void) => () => void }
  | undefined;

function apply(p: ReplayPrefs) {
  native()?.set({ on: p.on, keep: p.keep, sound: p.sound, fps: p.fps, bpp: recBpp(p.quality, p.fps) });
}

export function setReplayPrefs(p: Partial<ReplayPrefs>) {
  const next = { ...useReplay.getState().prefs, ...p };
  localStorage.setItem(KEY, JSON.stringify(next));
  useReplay.setState({ prefs: next, error: null, ...(next.on ? {} : { running: null }) });
  apply(next);
}

/** Save the last stretch as a clip (the whole buffer unless told less). */
export async function saveReplay(secs?: number) {
  const n = native();
  if (!n) return;
  useReplay.setState({ saving: true });
  const r = await n.save(secs);
  useReplay.setState({ saving: false });
  if (r.error) toast("Couldn't save the replay: " + r.error, "error");
}

/** At startup (Windows app): start replay if it's on, and listen for what it says. */
export function initReplay() {
  const n = native();
  if (!n) return;
  n.on((kind, v) => {
    if (kind === "state") useReplay.setState(v.on ? { running: { codec: v.codec, gpu: v.gpu, width: v.width, height: v.height, target: v.target }, error: null } : { running: null, error: v.error ?? null });
    else toast(`Saved the last ${v.secs} s — it's in Library → Recordings`);
  });
  if (useReplay.getState().prefs.on) apply(useReplay.getState().prefs);
}
