// Pop-out video: pull any screen share or camera out of the call into its own
// floating window that stays on top of everything (games included). Drag it anywhere,
// resize it from the edges, close it with ✕.
//  - Windows app: each pop-out is its own frameless always-on-top window.
//  - Browsers: Chrome allows one always-on-top window per page, so pop-outs share it.
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Track } from "livekit-client";
import { create } from "zustand";
import { memberName, useStore } from "../store";
import { toast } from "../ui";
import { needVideo, participants, useVoice } from "../voice";

interface Pop {
  key: string; // identity|source
  identity: string;
  source: Track.Source;
  win: Window | null; // own window (Windows app); null = lives in the shared browser pop-out
}

export const usePopouts = create<{ pops: Pop[]; shared: Window | null }>(() => ({ pops: [], shared: null }));

function copyStyles(w: Window) {
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      const st = w.document.createElement("style");
      st.textContent = Array.from(sheet.cssRules).map((r) => r.cssText).join("\n");
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
}

function remember(key: string, w: Window) {
  try {
    localStorage.setItem("llamble.pop." + key.split("|")[1], JSON.stringify({ x: w.screenX, y: w.screenY, w: w.outerWidth, h: w.outerHeight }));
  } catch {}
}

export function popoutSupported() {
  return !!window.llambleNative || "documentPictureInPicture" in window;
}

/** Pop a participant's screen share or camera out into a floating window. Call from a click. */
export async function popOut(identity: string, source: Track.Source) {
  const key = identity + "|" + source;
  const st = usePopouts.getState();
  if (st.pops.some((p) => p.key === key)) return;
  needVideo(identity, source === Track.Source.ScreenShare ? "screen" : "camera", true);
  if (window.llambleNative) {
    let pos = { x: 80, y: 80, w: 640, h: 380 };
    try {
      pos = { ...pos, ...JSON.parse(localStorage.getItem("llamble.pop." + source) || "{}") };
    } catch {}
    const w = window.open("about:blank", "llamble-pop-" + key.replace(/\W/g, ""), `left=${pos.x},top=${pos.y},width=${pos.w},height=${pos.h}`);
    if (!w) return toast("Couldn't open the pop-out window", "error");
    copyStyles(w);
    w.document.title = "Llamble";
    w.document.body.className = "pop-body";
    const save = () => remember(key, w);
    w.addEventListener("resize", save);
    w.addEventListener("beforeunload", () => {
      save();
      usePopouts.setState((s) => ({ pops: s.pops.filter((p) => p.key !== key) }));
    });
    usePopouts.setState((s) => ({ pops: [...s.pops, { key, identity, source, win: w }] }));
    return;
  }
  const dpip = (window as any).documentPictureInPicture;
  if (!dpip) return toast("This browser can't pop out video. Use Chrome or Edge, or the Windows app.", "error");
  let shared = st.shared;
  if (!shared) {
    shared = (await dpip.requestWindow({ width: 640, height: 380 })) as Window;
    copyStyles(shared);
    shared.document.body.className = "pop-body";
    shared.addEventListener("pagehide", () => usePopouts.setState((s) => ({ shared: null, pops: s.pops.filter((p) => p.win) })));
    usePopouts.setState({ shared });
  }
  usePopouts.setState((s) => ({ pops: [...s.pops, { key, identity, source, win: null }] }));
}

export function closePop(key: string) {
  const p = usePopouts.getState().pops.find((x) => x.key === key);
  if (p) needVideo(p.identity, p.source === Track.Source.ScreenShare ? "screen" : "camera", false);
  if (p?.win) p.win.close();
  usePopouts.setState((s) => {
    const pops = s.pops.filter((x) => x.key !== key);
    if (!pops.some((x) => !x.win) && s.shared) {
      s.shared.close();
      return { pops, shared: null };
    }
    return { pops };
  });
}

function PopVideo({ pop, guildId }: { pop: Pop; guildId: string | null }) {
  useVoice((s) => s.version);
  const user = useStore((s) => s.users[pop.identity]);
  const ref = useRef<HTMLVideoElement>(null);
  const p = participants().find((x) => x.identity === pop.identity);
  const pub = p?.getTrackPublication(pop.source);
  const track = pub && !pub.isMuted ? pub.track : undefined;
  const name = memberName(guildId, user) + (pop.source === Track.Source.ScreenShare ? "'s screen" : "");

  useEffect(() => {
    const el = ref.current;
    if (!el || !track) return;
    track.attach(el);
    return () => {
      track.detach(el);
    };
  }, [track]);
  useEffect(() => {
    if (pop.win) pop.win.document.title = name;
  }, [name]);

  return (
    <div className="pop">
      <div className="pop-bar">
        <span className="pop-name">{name}</span>
        <button className="pop-x" onClick={() => closePop(pop.key)} title="Close">
          ✕
        </button>
      </div>
      {track ? <video ref={ref} autoPlay playsInline muted className="pop-video" /> : <div className="pop-off">{p ? "Not sharing right now" : "Left the call"}</div>}
    </div>
  );
}

/** Renders every popped-out video into its window. Mounted once in the app shell. */
export function Popouts() {
  const { pops, shared } = usePopouts();
  const ch = useVoice((s) => s.channelId);
  const guildId = useStore((s) => (ch ? s.channels[ch]?.guild_id ?? null : null));
  // leaving the call closes them
  useEffect(() => {
    if (!ch) usePopouts.getState().pops.forEach((p) => closePop(p.key));
  }, [ch]);
  const inShared = pops.filter((p) => !p.win);
  return (
    <>
      {pops
        .filter((p) => p.win)
        .map((p) => createPortal(<PopVideo pop={p} guildId={guildId} />, p.win!.document.body, p.key))}
      {shared &&
        inShared.length > 0 &&
        createPortal(
          <div className={"pop-grid n" + Math.min(inShared.length, 4)}>
            {inShared.map((p) => (
              <PopVideo key={p.key} pop={p} guildId={guildId} />
            ))}
          </div>,
          shared.document.body,
        )}
    </>
  );
}
