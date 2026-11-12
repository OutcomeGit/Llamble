import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./common";
import { onSnapshot, setOverlayPrefs, setWidget, useOverlayPrefs, usePopout, type OverlayLine, type OverlaySnapshot, type WidgetId } from "../overlay";

const NAMES: Record<WidgetId, string> = { voice: "Voice", chat: "Chat", alerts: "Alerts" };

function Face({ name, avatar, speaking, size }: { name: string; avatar: string; speaking?: boolean; size: number }) {
  return (
    <span className={"ov-face" + (speaking ? " speaking" : "")} style={{ width: size, height: size }}>
      {avatar ? <img src={avatar} alt="" /> : <span className="ov-face-txt">{name.slice(0, 1).toUpperCase()}</span>}
    </span>
  );
}

function VoiceWidget({ s }: { s: OverlaySnapshot }) {
  const p = useOverlayPrefs();
  if (!s.inVoice) return <div className="ov-empty">Not in a voice channel</div>;
  const list = p.voiceMode === "speaking" ? s.people.filter((x) => x.speaking) : s.people;
  return (
    <div className="ov-voice">
      <div className="ov-head">
        <Icon name="speaker" size={14} /> {s.channelName}
        {s.muted && <Icon name="micOff" size={14} className="ov-red" />}
        {s.deafened && <Icon name="deaf" size={14} className="ov-red" />}
      </div>
      {s.rec && <div className="ov-rec">● REC · {s.rec}</div>}
      {s.replay && <div className="ov-replay">⏪ Alt+F10 saves the last {s.replay}</div>}
      {list.map((x) => (
        <div key={x.id} className={"ov-person" + (x.speaking ? " speaking" : "")}>
          {p.voiceAvatars && <Face name={x.name} avatar={x.avatar} speaking={x.speaking} size={24} />}
          <span className="ov-name">{x.name}</span>
          {x.screen && <span className="ov-live">LIVE</span>}
          {x.deafened ? <Icon name="deaf" size={13} className="ov-red" /> : x.muted ? <Icon name="micOff" size={13} className="ov-red" /> : null}
        </div>
      ))}
      {p.voiceMode === "speaking" && list.length === 0 && <div className="ov-empty small">Nobody talking</div>}
    </div>
  );
}

function Lines({ lines, fade, now, empty }: { lines: OverlayLine[]; fade: number; now: number; empty: string }) {
  const shown = fade > 0 ? lines.filter((l) => now - l.ts < fade * 1000) : lines;
  if (!shown.length) return <div className="ov-empty small">{empty}</div>;
  return (
    <div className="ov-lines">
      {shown.map((l) => {
        const age = fade > 0 ? (now - l.ts) / (fade * 1000) : 0;
        return (
          <div key={l.id} className="ov-line" style={{ opacity: age > 0.75 ? Math.max(0.15, (1 - age) * 4) : 1 }}>
            <Face name={l.author} avatar={l.avatar} size={20} />
            <div>
              <span className="ov-author">{l.author}</span>
              {l.where && <span className="ov-where"> {l.where}</span>}
              <div className="ov-text">{l.text}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Widget({ id, s }: { id: WidgetId; s: OverlaySnapshot }) {
  const p = useOverlayPrefs();
  if (id === "voice") return <VoiceWidget s={s} />;
  if (id === "chat") return <Lines lines={s.chat} fade={p.chatFade} now={s.now} empty={p.chatSource === "mentions" ? "No mentions yet" : "No new messages"} />;
  return <Lines lines={s.alerts} fade={p.alertsFade} now={s.now} empty="No alerts" />;
}

/** The whole-screen overlay (Windows app). `edit` lets the widgets be dragged. */
const EMPTY_SNAP: OverlaySnapshot = { inVoice: false, channelName: "", muted: false, deafened: false, people: [], chat: [], alerts: [], now: 0 };

export function ScreenOverlay({ snap, edit, onDone }: { snap: OverlaySnapshot | null; edit: boolean; onDone?: () => void }) {
  const p = useOverlayPrefs();
  const drag = useRef<{ id: WidgetId; dx: number; dy: number } | null>(null);
  const [, force] = useState(0);
  // the Windows app must know the "Done" bar is really on screen (else it lets go of the mouse)
  useEffect(() => {
    if (edit) window.llambleNative?.overlay?.editShown?.();
  }, [edit]);
  if (!snap && !edit) return null;
  snap = snap || EMPTY_SNAP;

  const move = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const x = Math.min(0.98, Math.max(0, (e.clientX - d.dx) / window.innerWidth));
    const y = Math.min(0.98, Math.max(0, (e.clientY - d.dy) / window.innerHeight));
    setWidget(d.id, { x, y });
    force((n) => n + 1);
  };

  return (
    <div className={"ov-screen" + (edit ? " edit" : "")} onPointerMove={move} onPointerUp={() => (drag.current = null)}>
      {(Object.keys(p.widgets) as WidgetId[])
        .filter((id) => p.widgets[id].on)
        .map((id) => {
          const w = p.widgets[id];
          // hide empty widgets while playing; show them all while arranging
          if (!edit && id === "chat" && !snap.chat.some((l) => !p.chatFade || snap.now - l.ts < p.chatFade * 1000)) return null;
          if (!edit && id === "alerts" && !snap.alerts.some((l) => snap.now - l.ts < p.alertsFade * 1000)) return null;
          if (!edit && id === "voice" && !snap.inVoice) return null;
          return (
            <div
              key={id}
              className="ov-widget"
              style={{ left: w.x * 100 + "%", top: w.y * 100 + "%", opacity: p.opacity, transform: `scale(${p.scale})` }}
              onPointerDown={(e) => {
                if (!edit) return;
                const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                drag.current = { id, dx: e.clientX - r.left, dy: e.clientY - r.top };
                (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
              }}
            >
              {edit && <div className="ov-grip">⠿ {NAMES[id]}</div>}
              <Widget id={id} s={snap} />
            </div>
          );
        })}
      {edit && (
        <div className="ov-editbar">
          <b>Drag the widgets where you want them.</b>
          <span>
            Size
            <input type="range" min={0.6} max={1.6} step={0.05} value={p.scale} onChange={(e) => setOverlayPrefs({ scale: +e.target.value })} />
          </span>
          <span>
            See-through
            <input type="range" min={0.3} max={1} step={0.05} value={p.opacity} onChange={(e) => setOverlayPrefs({ opacity: +e.target.value })} />
          </span>
          {(Object.keys(NAMES) as WidgetId[]).map((id) => (
            <label key={id} className="ov-check">
              <input type="checkbox" checked={p.widgets[id].on} onChange={(e) => setWidget(id, { on: e.target.checked })} /> {NAMES[id]}
            </label>
          ))}
          <button className="btn primary" onClick={onDone}>
            Done
          </button>
          <span className="muted small">Ctrl+Shift+O</span>
        </div>
      )}
    </div>
  );
}

/** Browser pop-out: the same widgets stacked in a small always-on-top window. */
export function PopoutOverlay() {
  const win = usePopout((s) => s.win);
  const p = useOverlayPrefs();
  const [snap, setSnap] = useState<OverlaySnapshot | null>(null);
  useEffect(() => (win ? onSnapshot(setSnap) : undefined), [win]);
  if (!win || !snap) return null;
  return createPortal(
    <div className="ov-stack" style={{ fontSize: 14 * p.scale + "px" }}>
      {(Object.keys(NAMES) as WidgetId[])
        .filter((id) => p.widgets[id].on)
        .map((id) => (
          <section key={id} className="ov-widget static">
            <div className="ov-title">{NAMES[id]}</div>
            <Widget id={id} s={snap} />
          </section>
        ))}
    </div>,
    win.document.body,
  );
}
