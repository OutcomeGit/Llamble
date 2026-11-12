// Overlay: a small always-on-top view of who's talking, recent chat and alerts,
// shown over games and other apps.
//  - Windows app: a transparent, click-through window over the whole screen.
//    Ctrl+Shift+O (or "Move widgets") lets you drag the widgets around.
//  - Browsers (Chromebook, PC web): a pop-out window that stays on top
//    (Chrome's Document Picture-in-Picture). You move and resize the window itself.
import { create } from "zustand";
import { avatarUrl } from "./api";
import { currentChannelId, memberName, useStore } from "./store";
import { useVoice } from "./voice";
import { useRecorder } from "./show";
import { useNativeRec } from "./nativerec";
import { useReplay } from "./replay";

function recLine(): string | undefined {
  const n = useNativeRec.getState();
  if (n.active) return `${n.active.codec} · ${n.active.gpu ? "graphics card" : "processor"} · ${n.fps} fps${n.dropped ? ` (${n.dropped} skipped)` : ""}`;
  const r = useRecorder.getState();
  if (!r.showId) return undefined;
  return [r.encoder, r.fps ? `${r.fpsNow ?? "…"}/${r.fps} fps` : ""].filter(Boolean).join(" · ") || "starting…";
}

export type WidgetId = "voice" | "chat" | "alerts";

export interface WidgetPos {
  on: boolean;
  /** position of the widget's top-left corner, as a fraction of the screen */
  x: number;
  y: number;
}

export interface OverlayPrefs {
  enabled: boolean;
  /** "voice": only while you're in a voice channel */
  when: "voice" | "always";
  /** Windows app: hide while the Llamble window itself is in front */
  hideWhenFocused: boolean;
  opacity: number;
  scale: number;
  widgets: Record<WidgetId, WidgetPos>;
  /** voice list: everyone in the channel, or only people talking right now */
  voiceMode: "all" | "speaking";
  voiceAvatars: boolean;
  /** chat: which messages to show */
  chatSource: "open" | "mentions";
  chatCount: number;
  /** seconds before a chat line fades away (0 = keep) */
  chatFade: number;
  alertsFade: number;
}

export const DEFAULT_PREFS: OverlayPrefs = {
  enabled: false,
  when: "voice",
  hideWhenFocused: true,
  opacity: 0.9,
  scale: 1,
  widgets: {
    voice: { on: true, x: 0.015, y: 0.03 },
    chat: { on: true, x: 0.015, y: 0.62 },
    alerts: { on: true, x: 0.78, y: 0.03 },
  },
  voiceMode: "all",
  voiceAvatars: true,
  chatSource: "open",
  chatCount: 5,
  chatFade: 20,
  alertsFade: 8,
};

const KEY = "llamble.overlay";

function load(): OverlayPrefs {
  try {
    const p = JSON.parse(localStorage.getItem(KEY) || "{}");
    return { ...DEFAULT_PREFS, ...p, widgets: { ...DEFAULT_PREFS.widgets, ...(p.widgets || {}) } };
  } catch {
    return DEFAULT_PREFS;
  }
}

export const useOverlayPrefs = create<OverlayPrefs>(load);

export function setOverlayPrefs(patch: Partial<OverlayPrefs>) {
  const next = { ...useOverlayPrefs.getState(), ...patch };
  useOverlayPrefs.setState(next, true);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {}
}

export function setWidget(id: WidgetId, patch: Partial<WidgetPos>) {
  const w = useOverlayPrefs.getState().widgets;
  setOverlayPrefs({ widgets: { ...w, [id]: { ...w[id], ...patch } } });
}

// the Windows overlay window shares localStorage with the main window
window.addEventListener("storage", (e) => {
  if (e.key === KEY) useOverlayPrefs.setState(load(), true);
});

// ---------------------------------------------------------------- what the overlay shows

export interface OverlayPerson {
  id: string;
  name: string;
  avatar: string;
  speaking: boolean;
  muted: boolean;
  deafened: boolean;
  screen: boolean;
  me: boolean;
}

export interface OverlayLine {
  id: string;
  author: string;
  avatar: string;
  text: string;
  where: string;
  ts: number;
}

export interface OverlaySnapshot {
  inVoice: boolean;
  channelName: string;
  muted: boolean;
  deafened: boolean;
  people: OverlayPerson[];
  chat: OverlayLine[];
  alerts: OverlayLine[];
  now: number;
  /** while this app records a show: "AV1 · graphics card · 58/60 fps" */
  rec?: string;
  /** instant replay is keeping your game: how long */
  replay?: string;
}

const alerts: OverlayLine[] = [];
const mentionLines: OverlayLine[] = [];

/** Called by the app for DMs and @mentions (and anything else worth a pop-up). */
export function pushOverlayAlert(line: OverlayLine, isMention: boolean) {
  alerts.push(line);
  if (alerts.length > 6) alerts.shift();
  if (isMention) {
    mentionLines.push(line);
    if (mentionLines.length > 20) mentionLines.shift();
  }
  bumpSnapshot();
}

function plain(text: string): string {
  return text
    .replace(/<@!?(\w+)>/g, (_, id) => "@" + (useStore.getState().users[id]?.display_name || useStore.getState().users[id]?.username || "someone"))
    .replace(/```[\s\S]*?```/g, "[code]")
    .replace(/[*_~`>]/g, "")
    .slice(0, 160);
}

export function buildSnapshot(): OverlaySnapshot {
  const s = useStore.getState();
  const v = useVoice.getState();
  const p = useOverlayPrefs.getState();
  const vch = v.channelId ? s.channels[v.channelId] : undefined;
  const gid = vch?.guild_id ?? null;
  const people: OverlayPerson[] = [];
  if (v.channelId) {
    for (const st of Object.values(s.voiceStates)) {
      if (st.channel_id !== v.channelId) continue;
      const u = s.users[st.user_id];
      const isMe = st.user_id === s.me?.id;
      people.push({
        id: st.user_id,
        name: memberName(gid, u),
        avatar: avatarUrl(u?.avatar_file_id),
        speaking: v.speaking.includes(st.user_id),
        muted: isMe ? v.muted : st.muted,
        deafened: isMe ? v.deafened : st.deafened,
        screen: st.screen,
        me: isMe,
      });
    }
    people.sort((a, b) => a.name.localeCompare(b.name));
  }
  let chat: OverlayLine[] = [];
  if (p.chatSource === "mentions") chat = mentionLines.slice(-p.chatCount);
  else {
    const cid = currentChannelId(s);
    const ch = cid ? s.channels[cid] : undefined;
    chat = (cid ? s.messages[cid] || [] : []).slice(-p.chatCount).map((m) => ({
      id: m.id,
      author: memberName(ch?.guild_id ?? null, m.author),
      avatar: avatarUrl(m.author.avatar_file_id),
      text: plain(m.content) || (m.attachments.length ? "📎 " + m.attachments[0].filename : ""),
      where: ch?.kind === "dm" ? "" : "#" + (ch?.name ?? ""),
      ts: m.created_at,
    }));
  }
  return {
    inVoice: v.status !== "idle" && !!v.channelId,
    channelName: vch?.name ?? "",
    muted: v.muted,
    deafened: v.deafened,
    people,
    chat,
    alerts: alerts.slice(),
    now: Date.now(),
    rec: recLine(),
    replay: useReplay.getState().running ? (useReplay.getState().prefs.keep >= 60 ? useReplay.getState().prefs.keep / 60 + " min" : useReplay.getState().prefs.keep + " s") : undefined,
  };
}

// ---------------------------------------------------------------- feeding the overlay

type Listener = (s: OverlaySnapshot) => void;
const listeners = new Set<Listener>();
let queued = false;

export function onSnapshot(cb: Listener) {
  listeners.add(cb);
  cb(buildSnapshot());
  return () => {
    listeners.delete(cb);
  };
}

export function bumpSnapshot() {
  if (queued) return;
  queued = true;
  setTimeout(() => {
    queued = false;
    const snap = buildSnapshot();
    listeners.forEach((l) => l(snap));
    sendNative(snap);
  }, 120);
}

/** Should the overlay be up right now? */
export function overlayWanted(snap: OverlaySnapshot = buildSnapshot()): boolean {
  const p = useOverlayPrefs.getState();
  return p.enabled && (p.when === "always" || snap.inVoice);
}

function sendNative(snap: OverlaySnapshot) {
  const n = window.llambleNative?.overlay;
  if (!n) return;
  const p = useOverlayPrefs.getState();
  n.set({ show: overlayWanted(snap), hideWhenFocused: p.hideWhenFocused });
  n.update(snap);
}

let started = false;
/** Start watching app state (main window only). */
export function startOverlayFeed() {
  if (started) return;
  started = true;
  useStore.subscribe(bumpSnapshot);
  useVoice.subscribe(bumpSnapshot);
  useRecorder.subscribe(bumpSnapshot);
  useNativeRec.subscribe(bumpSnapshot);
  useReplay.subscribe(bumpSnapshot);
  useOverlayPrefs.subscribe(bumpSnapshot);
  // fades are time based: refresh now and then even when nothing changes
  setInterval(() => listeners.size && bumpSnapshot(), 2000);
  bumpSnapshot();
}

// ---------------------------------------------------------------- browser pop-out

export function popoutSupported(): boolean {
  return !window.llambleNative && "documentPictureInPicture" in window;
}

export const usePopout = create<{ win: Window | null }>(() => ({ win: null }));

/** Open the always-on-top pop-out (browsers). Must be called from a click. */
export async function openPopout() {
  if (usePopout.getState().win) return;
  const dpip = (window as any).documentPictureInPicture;
  if (!dpip) throw new Error("This browser can't open an always-on-top window. Use Chrome or Edge, or the Windows app.");
  const w: Window = await dpip.requestWindow({ width: 300, height: 420 });
  // bring the app's styles along
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      const css = Array.from(sheet.cssRules).map((r) => r.cssText).join("\n");
      const st = w.document.createElement("style");
      st.textContent = css;
      w.document.head.appendChild(st);
    } catch {
      if (sheet.href) {
        const l = w.document.createElement("link");
        l.rel = "stylesheet";
        l.href = sheet.href;
        w.document.head.appendChild(l);
      }
    }
  }
  w.document.body.className = "overlay-popout";
  w.document.title = "Llamble overlay";
  w.addEventListener("pagehide", () => usePopout.setState({ win: null }));
  usePopout.setState({ win: w });
}

export function closePopout() {
  usePopout.getState().win?.close();
  usePopout.setState({ win: null });
}
