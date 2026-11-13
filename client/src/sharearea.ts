// Sharing a window that shows another window on top of itself — Godot plays your game in a
// separate window laid over its editor. Window capture would leave that game out, so we
// share the screen it's on and crop it to the window (following it as it moves).
import type { LocalVideoTrack, TrackProcessor, Track } from "livekit-client";
import CropWorker from "./cropworker?worker&inline";

/** The screen to share instead, if this window needs it (Windows app only). */
export async function areaFor(sourceId: string): Promise<string | null> {
  const a = window.llambleNative?.shareArea;
  if (!a || !sourceId.startsWith("window:")) return null;
  const r = await a.start(sourceId).catch(() => null);
  return r?.screenId ?? null;
}

/** Crop the published screen track to the window, live. */
export async function cropToWindow(track: LocalVideoTrack) {
  const a = window.llambleNative?.shareArea;
  if (!a || typeof (globalThis as any).MediaStreamTrackProcessor === "undefined") return;
  let worker: Worker | null = null;
  let off: (() => void) | null = null;
  const proc: TrackProcessor<Track.Kind.Video> & { processedTrack?: MediaStreamTrack } = {
    name: "llamble-window-area",
    async init({ track: src }) {
      worker = new CropWorker();
      const readable = new (globalThis as any).MediaStreamTrackProcessor({ track: src }).readable;
      const gen = new (globalThis as any).MediaStreamTrackGenerator({ kind: "video" });
      worker.postMessage({ readable, writable: gen.writable }, [readable, gen.writable]);
      proc.processedTrack = gen as MediaStreamTrack;
      off = a.on((v) => {
        if (v.gone) return; // minimised: keep the last area
        worker?.postMessage({ rect: { x: v.left!, y: v.top!, w: v.right! - v.left!, h: v.bottom! - v.top!, mw: v.mw!, mh: v.mh! } });
      });
    },
    async restart(opts) {
      await proc.destroy();
      await proc.init(opts);
    },
    async destroy() {
      off?.();
      off = null;
      worker?.terminate();
      worker = null;
      a.stop();
    },
  };
  await track.setProcessor(proc as any);
}

export function stopArea() {
  window.llambleNative?.shareArea?.stop();
}
