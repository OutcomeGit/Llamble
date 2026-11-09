import { useShallow } from "zustand/react/shallow";
import { useEffect, useRef, useState } from "react";
import { Track } from "livekit-client";
import { memberName, useStore } from "../store";
import { toast } from "../ui";
import { canShareScreen, defaultShareQuality, participants, startScreenShare, stopScreenShare, useVoice } from "../voice";
import { openModal } from "../ui";

/** Pick a screen, window or app to share (same picker as the Share Screen button). */
async function pickScreen(replace = false) {
  if (!canShareScreen()) {
    toast("This device can't share its screen, so the show uses your camera and voice only.");
    return;
  }
  if (replace && useVoice.getState().screen) await stopScreenShare();
  if (window.llambleNative) openModal({ kind: "screenPicker" });
  else startScreenShare("", true, defaultShareQuality());
}
import { Compositor, showApi, useRecorder, useShows, type RecRes, type Show, type Streams } from "../show";

const NONE: Streams = { voice: false, camera: false, screen: false };
const ALL: Streams = { voice: true, camera: true, screen: true };
const label = (s: Streams) => [s.voice && "voice", s.camera && "camera", s.screen && "screen"].filter(Boolean).join(", ") || "nothing";

function useName() {
  const users = useStore((s) => s.users);
  const ch = useVoice((s) => s.channelId);
  const gid = useStore((s) => (ch ? s.channels[ch]?.guild_id ?? null : null));
  return (uid: string) => memberName(gid, users[uid]);
}

function useMyShow(): Show | undefined {
  const ch = useVoice((s) => s.channelId);
  return useShows((s) => (ch ? s.live[ch] : undefined));
}

// ---------------------------------------------------------------- start a show

export function StartShow({ channelId, onClose }: { channelId: string; onClose: () => void }) {
  const me = useStore((s) => s.me)!;
  const name = useName();
  useVoice((s) => s.version);
  const inCall = useStore(useShallow((s) => Object.values(s.voiceStates).filter((v) => v.channel_id === channelId).map((v) => v.user_id)));
  const [title, setTitle] = useState("");
  // everyone starts ticked; people who join while this is open too
  const [picks, setPicks] = useState<Record<string, Streams>>({});
  const [recorder, setRecorder] = useState(me.id);
  const [director, setDirector] = useState(me.id);
  const serverOk = useStore((s) => !!s.config.media?.server_recording);
  const [saveTo, setSaveTo] = useState<"member" | "server">("member");
  const [res, setRes] = useState<RecRes>((localStorage.getItem("llamble.showRes") as RecRes) || "1080p");
  const [busy, setBusy] = useState(false);
  const bot = useStore((s) => s.config.bot?.id);
  const people = inCall.filter((u) => u !== bot);

  const toggle = (u: string, k: keyof Streams) => setPicks((p) => ({ ...p, [u]: { ...(p[u] || ALL), [k]: !(p[u] || ALL)[k] } }));
  const go = async () => {
    setBusy(true);
    localStorage.setItem("llamble.showRes", res);
    try {
      await showApi.create(channelId, {
        title,
        people: people.map((u) => ({ user_id: u, ...(picks[u] || ALL) })),
        recorder_id: recorder,
        director_id: director,
        record_on: serverOk ? saveTo : "member",
      });
      onClose();
      if ((picks[me.id] || ALL).screen && people.includes(me.id) && !useVoice.getState().screen) pickScreen();
    } catch (e: any) {
      toast(e.message, "error");
    }
    setBusy(false);
  };

  return (
    <div className="camfx-pop show-start">
      <div className="sb-head">
        <b>🎬 Start a show</b>
        <button className="btn small" onClick={onClose}>
          Close
        </button>
      </div>
      <input placeholder="Title (optional)" value={title} maxLength={100} onChange={(e) => setTitle(e.target.value)} style={{ width: "100%" }} />
      <div className="camfx-title" style={{ marginTop: 12 }}>
        Who's in it, and what of theirs gets recorded
      </div>
      <table className="show-people">
        <tbody>
          {people.map((u) => (
            <tr key={u}>
              <td>{name(u)}</td>
              {(["voice", "camera", "screen"] as const).map((k) => (
                <td key={k}>
                  <label className="check">
                    <input type="checkbox" checked={(picks[u] || ALL)[k]} onChange={() => toggle(u, k)} /> {k}
                  </label>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="row gap" style={{ flexWrap: "wrap", marginTop: 10 }}>
        <label>
          Recorded on
          <select value={recorder} onChange={(e) => setRecorder(e.target.value)}>
            {people.map((u) => (
              <option key={u} value={u}>
                {u === me.id ? "My app" : name(u) + "'s app"}
              </option>
            ))}
          </select>
        </label>
        {serverOk && (
          <label title="Kept on the recorder's device unless someone shares it, or saved straight to this server as it records">
            Saved
            <select value={saveTo} onChange={(e) => setSaveTo(e.target.value as "member" | "server")}>
              <option value="member">{recorder === me.id ? "On my device" : "On their device"}</option>
              <option value="server">To the server</option>
            </select>
          </label>
        )}
        <label>
          Director
          <select value={director} onChange={(e) => setDirector(e.target.value)}>
            {people.map((u) => (
              <option key={u} value={u}>
                {u === me.id ? "Me" : name(u)}
              </option>
            ))}
          </select>
        </label>
        {recorder === me.id && (
          <label>
            Quality
            <select value={res} onChange={(e) => setRes(e.target.value as RecRes)}>
              <option value="1080p">1080p</option>
              <option value="1440p">1440p</option>
              <option value="2160p">4K</option>
            </select>
          </label>
        )}
      </div>
      <p className="muted small">
        Everyone picked gets asked first and can say yes to some, all, or none, and change their mind any time. Kids are covered by their parent. Everyone in the call sees REC while it records.{" "}
        {saveTo === "server" && serverOk ? "It's saved on the server as it records." : "It's kept on the recorder's device (their Library → Recordings) and only reaches the server if they share it."}
      </p>
      <button className="btn primary" disabled={busy || !people.length} onClick={go}>
        Ask everyone
      </button>
    </div>
  );
}

// ---------------------------------------------------------------- banner in the call

export function ShowBanner({ onDirect }: { onDirect: () => void }) {
  const show = useMyShow();
  const me = useStore((s) => s.me?.id);
  const name = useName();
  const rec = useRecorder();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  // every hook must run on every render, show or not (React crashes otherwise)
  const sharing = useVoice((s) => s.screen);
  if (!show) return null;
  const soundWarn = rec.showId === show.id && rec.soundBlocked;
  const crew = [show.initiator_id, show.recorder_id, show.director_id].includes(me || "");
  const waiting = show.people.filter((p) => !p.consent).map((p) => name(p.user_id));
  const mine = show.people.find((p) => p.user_id === me);
  const secs = show.started_at ? Math.floor((now - show.started_at) / 1000) : 0;
  const time = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;

  return (
    <div className={"show-banner " + show.status}>
      {show.status === "recording" ? <span className="rec-dot">REC {time}</span> : <span className="show-setup">🎬 Getting ready</span>}
      <span className="show-what">
        {show.title || "Show"}
        {show.status === "setup" && (
          <span className="muted small">
            {" "}
            · {!show.recorder_ok ? `waiting for ${name(show.recorder_id)} to record` : waiting.length ? `waiting for ${waiting.join(", ")}` : "everyone answered"}
          </span>
        )}
        {mine && <span className="muted small"> · you: {label(mine.consent || NONE)}</span>}
        {rec.showId === show.id && (
          <span className="muted small">
            {" "}
            · {(rec.uploaded / 1e6).toFixed(0)} MB {rec.where === "server" ? "saved to the server" : "saved on this device"}{rec.error ? " · " + rec.error : ""}
            {soundWarn && <b className="rec-sound-warn"> · 🔇 Tap anywhere to turn on sound in the recording</b>}
          </span>
        )}
      </span>
      <span className="row gap">
        {mine && (
          <button className="btn small" onClick={() => openConsent(show.id)}>
            Change mine
          </button>
        )}
        {mine?.consent?.screen && canShareScreen() && (
          <button className={"btn small" + (sharing ? "" : " primary")} onClick={() => pickScreen(sharing)} title="Pick which screen, window or app goes in the show">
            {sharing ? "Change what I share" : "Pick my screen"}
          </button>
        )}
        {show.director_id === me && (
          <button className="btn small" onClick={onDirect}>
            Director
          </button>
        )}
        {show.status === "setup" && (show.initiator_id === me || show.recorder_id === me) && (
          <button className="btn small primary" disabled={!show.recorder_ok} onClick={() => showApi.start(show.id).catch((e) => toast(e.message, "error"))}>
            Start recording
          </button>
        )}
        {crew && (
          <button className="btn small red" onClick={() => showApi.stop(show.id).catch((e) => toast(e.message, "error"))}>
            {show.status === "recording" ? "Stop" : "Cancel"}
          </button>
        )}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------- questions people get asked

const useConsentOpen = (() => {
  let set: (id: string | null) => void = () => {};
  return { bind: (f: (id: string | null) => void) => (set = f), open: (id: string) => set(id) };
})();
export const openConsent = (id: string) => useConsentOpen.open(id);

/** Consent / recorder / director / joined-mid-show prompts. Mounted once in the shell. */
export function ShowPrompts() {
  const me = useStore((s) => s.me?.id);
  const ch = useVoice((s) => s.channelId);
  const live = useShows((s) => s.live);
  const name = useName();
  const [forced, setForced] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<Record<string, boolean>>({});
  useConsentOpen.bind(setForced);
  const shows = Object.values(live);

  // 1) asked to record / direct
  const role = shows.find((s) => s.status === "setup" && ((s.recorder_id === me && !s.recorder_ok) || (s.director_id === me && !s.director_ok)) && !dismissed["role" + s.id]);
  if (role) {
    const what = role.recorder_id === me && !role.recorder_ok ? (role.director_id === me ? "record and direct" : "record") : "direct";
    return (
      <PromptBox>
        <b>🎬 {name(role.initiator_id)} wants you to {what} a show</b>
        <p className="muted small">
          {what.includes("record") ? "Your app will mix and save the video while you're in the call. Keep Llamble open until it's over." : "You'll pick who's on screen, titles, and when to cut."}
        </p>
        {what.includes("record") && (
          <label>
            Quality
            <select defaultValue={localStorage.getItem("llamble.showRes") || "1080p"} onChange={(e) => localStorage.setItem("llamble.showRes", e.target.value)}>
              <option value="1080p">1080p</option>
              <option value="1440p">1440p</option>
              <option value="2160p">4K</option>
            </select>
          </label>
        )}
        <div className="row gap">
          <button className="btn primary" onClick={() => showApi.role(role.id, true).catch((e) => toast(e.message, "error"))}>
            Yes
          </button>
          <button className="btn" onClick={() => (showApi.role(role.id, false).catch(() => {}), setDismissed((d) => ({ ...d, ["role" + role.id]: true })))}>
            No thanks
          </button>
        </div>
      </PromptBox>
    );
  }

  // 2) asked to be in it (or changing your answer)
  const ask =
    (forced && shows.find((s) => s.id === forced)) ||
    shows.find((s) => s.people.some((p) => p.user_id === me && !p.consent) && !dismissed["c" + s.id]);
  if (ask) {
    const mine = ask.people.find((p) => p.user_id === me);
    if (mine) return <ConsentBox show={ask} wanted={mine.wanted} current={mine.consent} onDone={() => (setForced(null), setDismissed((d) => ({ ...d, ["c" + ask.id]: true })))} />;
  }

  // 3) joined a call that's recording and you're not in the show
  const here = ch ? live[ch] : undefined;
  if (here && here.status === "recording" && me && !here.people.some((p) => p.user_id === me) && !dismissed["j" + here.id]) {
    return <ConsentBox show={here} wanted={{ voice: true, camera: true, screen: true }} current={null} joining onDone={() => setDismissed((d) => ({ ...d, ["j" + here.id]: true }))} />;
  }
  return null;
}

function ConsentBox({ show, wanted, current, joining, onDone }: { show: Show; wanted: Streams; current: Streams | null; joining?: boolean; onDone: () => void }) {
  const name = useName();
  const [c, setC] = useState<Streams>(() => {
    const start = current || wanted;
    return { ...start, screen: start.screen && canShareScreen() };
  });
  const send = (s: Streams) =>
    showApi
      .consent(show.id, s)
      .then(() => {
        onDone();
        // they said yes to their screen: let them choose what to show right away
        if (s.screen && !useVoice.getState().screen) pickScreen();
      })
      .catch((e) => toast(e.message, "error"));
  return (
    <PromptBox>
      <b>
        {show.status === "recording" ? "🔴 " : "🎬 "}
        {joining ? "This call is being recorded" : `${name(show.initiator_id)} wants to record you`}
        {show.title ? ` for "${show.title}"` : ""}
      </b>
      <p className="muted small">
        {joining ? "You're not in it. Want to join in?" : "Pick what can be recorded. You can change this any time."}
        {wanted.screen && canShareScreen() ? " If you include your screen, you'll pick which screen, window or app next." : ""}
        {wanted.screen && !canShareScreen() ? " This device can't share its screen, so only your voice and camera can be included." : ""}
      </p>
      <div className="row gap">
        {(["voice", "camera", "screen"] as const)
          .filter((k) => wanted[k] && (k !== "screen" || canShareScreen()))
          .map((k) => (
            <label key={k} className="check">
              <input type="checkbox" checked={c[k]} onChange={() => setC((x) => ({ ...x, [k]: !x[k] }))} /> my {k}
            </label>
          ))}
      </div>
      <div className="row gap">
        <button className="btn primary" onClick={() => send(c)}>
          {joining ? "Join in" : "OK"}
        </button>
        <button className="btn" onClick={() => (joining ? onDone() : send(NONE))}>
          {joining ? "Stay out" : "Don't record me"}
        </button>
      </div>
    </PromptBox>
  );
}

function PromptBox({ children }: { children: React.ReactNode }) {
  return <div className="show-prompt">{children}</div>;
}

// ---------------------------------------------------------------- director

export function DirectorPanel({ onClose }: { onClose: () => void }) {
  const show = useMyShow();
  const name = useName();
  const me = useStore((s) => s.me?.id);
  const prev = useRef<HTMLDivElement>(null);
  const [lt, setLt] = useState({ text: "", sub: "" });
  const [card, setCard] = useState("");
  const [title, setTitle] = useState("");
  const [handTo, setHandTo] = useState("");
  useVoice((s) => s.version);

  // live preview: the same compositor the recorder uses
  useEffect(() => {
    const comp = new Compositor(() => {
      const ch = useVoice.getState().channelId;
      return ch ? useShows.getState().live[ch] : undefined;
    }, 960, 540);
    comp.canvas.className = "director-preview";
    prev.current?.appendChild(comp.canvas);
    const t = setInterval(() => comp.draw(), 66);
    return () => {
      clearInterval(t);
      comp.canvas.remove();
      comp.destroy();
    };
  }, []);

  if (!show) return null;
  const st = show.state || {};
  const set = (x: Record<string, unknown>) => showApi.state(show.id, x).catch((e) => toast(e.message, "error"));
  const shots: { key: string; label: string }[] = [];
  for (const p of show.people) {
    if (p.consent?.camera) shots.push({ key: p.user_id, label: name(p.user_id) });
    if (p.consent?.screen && participants().find((x) => x.identity === p.user_id)?.getTrackPublication(Track.Source.ScreenShare)) shots.push({ key: "screen:" + p.user_id, label: name(p.user_id) + "'s screen" });
  }

  return (
    <div className="camfx-pop director">
      <div className="sb-head">
        <b>🎬 Director</b>
        <button className="btn small" onClick={onClose}>
          Close
        </button>
      </div>
      <div ref={prev} className="director-preview-box" />
      <div className="camfx-title">Shot {st.hold ? "(held)" : "(auto: follows whoever talks)"}</div>
      <div className="camfx-row">
        <button className={"camfx-chip" + (!st.hold ? " on" : "")} onClick={() => set({ hold: false, focus: null })}>
          Auto
        </button>
        {shots.map((s) => (
          <button key={s.key} className={"camfx-chip" + (st.hold && st.focus === s.key ? " on" : "")} onClick={() => set({ hold: true, focus: s.key })}>
            {s.label}
          </button>
        ))}
      </div>
      <div className="camfx-title">Layout</div>
      <div className="camfx-row">
        {(["auto", "speaker", "screen", "grid"] as const).map((l) => (
          <button key={l} className={"camfx-chip" + ((st.layout || "auto") === l ? " on" : "")} onClick={() => set({ layout: l })}>
            {l === "auto" ? "Auto" : l === "speaker" ? "Speaker" : l === "screen" ? "Screen + faces" : "Grid"}
          </button>
        ))}
      </div>
      <div className="camfx-title">Lower third</div>
      <div className="row gap">
        <input placeholder="Name / headline" value={lt.text} onChange={(e) => setLt({ ...lt, text: e.target.value })} />
        <input placeholder="Second line" value={lt.sub} onChange={(e) => setLt({ ...lt, sub: e.target.value })} />
        <button className="btn small primary" onClick={() => set({ lower_third: lt.text ? lt : null })}>
          Show
        </button>
        <button className="btn small" onClick={() => set({ lower_third: null })}>
          Clear
        </button>
      </div>
      <div className="camfx-title">Title bar</div>
      <div className="row gap">
        <input placeholder="Shown at the top" value={title} onChange={(e) => setTitle(e.target.value)} />
        <button className="btn small primary" onClick={() => set({ title: title || null })}>
          Show
        </button>
        <button className="btn small" onClick={() => set({ title: null })}>
          Clear
        </button>
      </div>
      <div className="camfx-title">Full-screen card</div>
      <div className="row gap">
        <input placeholder="e.g. Be right back" value={card} onChange={(e) => setCard(e.target.value)} />
        <button className="btn small primary" onClick={() => set({ card: card || null })}>
          Show
        </button>
        <button className="btn small" onClick={() => set({ card: null })}>
          Clear
        </button>
      </div>
      <div className="camfx-title">Hand off directing</div>
      <div className="row gap">
        <select value={handTo} onChange={(e) => setHandTo(e.target.value)}>
          <option value="">Pick someone…</option>
          {show.people
            .filter((p) => p.user_id !== me)
            .map((p) => (
              <option key={p.user_id} value={p.user_id}>
                {name(p.user_id)}
              </option>
            ))}
        </select>
        <button className="btn small" disabled={!handTo} onClick={() => showApi.director(show.id, handTo).then(onClose).catch((e) => toast(e.message, "error"))}>
          Hand off
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- recordings

/** Browser-recorded WebM has no length written in it; this makes the seek bar work. */
export function Player({ src }: { src: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  return (
    <video
      ref={ref}
      src={src}
      controls
      preload="metadata"
      className="recording-video"
      onLoadedMetadata={(e) => {
        const v = e.currentTarget;
        if (v.duration === Infinity) {
          v.currentTime = 1e101;
          v.ontimeupdate = () => {
            v.ontimeupdate = null;
            v.currentTime = 0;
          };
        }
      }}
    />
  );
}
