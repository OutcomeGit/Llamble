// "Playing X": the Windows app notices games you have open and (unless you turn it off)
// tells the people you share a server with. Also powers "Stream <game>".
import { create } from "zustand";
import { sendGateway } from "./gateway";
import { prefs } from "./voice";
import { useStore } from "./store";
import type { DetectedGame } from "./types";

export const useGames = create<{ list: DetectedGame[] }>(() => ({ list: [] }));

export function showPlaying(): boolean {
  return prefs.get("showPlaying", "1") !== "0";
}

export function setShowPlaying(on: boolean) {
  prefs.set("showPlaying", on ? "1" : "0");
  announce();
}

function announce() {
  const g = showPlaying() ? useGames.getState().list[0]?.name ?? null : null;
  sendGateway("activity", { game: g });
  const me = useStore.getState().me;
  if (me) {
    const games = { ...useStore.getState().games };
    if (g) games[me.id] = g;
    else delete games[me.id];
    useStore.setState({ games });
  }
}

let started = false;
export function startGameDetection() {
  const n = window.llambleNative?.games;
  if (!n || started) return;
  started = true;
  const update = (list: DetectedGame[]) => {
    useGames.setState({ list });
    announce();
  };
  n.on(update);
  n.current().then(update).catch(() => {});
  // the server forgets activity when you disconnect; say it again after reconnecting
  window.addEventListener("llamble:gateway-open", () => setTimeout(announce, 500));
}

/** Ask for a fresh look right now (e.g. when opening the screen picker). */
export async function refreshGames(): Promise<DetectedGame[]> {
  const n = window.llambleNative?.games;
  if (!n) return [];
  try {
    const list = await n.current();
    useGames.setState({ list });
    return list;
  } catch {
    return useGames.getState().list;
  }
}
