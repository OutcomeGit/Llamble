// Director → Sound: what goes into the show's recording and how loud, with live meters;
// and Music & sounds: files the director plays into the call (and so into the show).
import { useEffect, useRef, useState } from "react";
import { mixGain, mixSources, showApi, type MixEntry, type Show } from "../show";
import { addMusic, pauseMusic, playMusic, removeMusic, setMusic, useShowMusic } from "../showmusic";
import { memberName, useStore } from "../store";
import { toast } from "../ui";
import { useVoice } from "../voice";

function useName() {
  const users = useStore((s) => s.users);
  const ch = useVoice((v) => v.channelId);
  const gid = useStore((s) => (ch ? (s.channels[ch]?.guild_id ?? null) : null));
  return (uid: string) => memberName(gid, users[uid]);
}

/** Live level meters for a set of tracks: returns a ref map you hang the bars on. */
function useMeters(tracks: Map<string, MediaStreamTrack>) {
  const bars = useRef(new Map<string, HTMLDivElement>());
  const keyList = [...tracks.entries()].map(([k, t]) => k + "=" + t.id).join("|");
  useEffect(() => {
    if (!tracks.size) return;
    const ctx = new AudioContext();
    const meters = new Map<string, AnalyserNode>();
    for (const [k, t] of tracks) {
      try {
        const a = ctx.createAnalyser();
        a.fftSize = 512;
        ctx.createMediaStreamSource(new MediaStream([t])).connect(a);
        meters.set(k, a);
      } catch {}
    }
    const buf = new Float32Array(512);
    let raf = 0;
    const tick = () => {
      for (const [k, a] of meters) {
        a.getFloatTimeDomainData(buf);
        let peak = 0;
        for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i]));
        // dB scale: -60 dB empty, 0 dB full
        const pct = Math.max(0, Math.min(100, ((20 * Math.log10(peak || 1e-6) + 60) / 60) * 100));
        const el = bars.current.get(k);
        if (el) el.style.width = pct + "%";
      }
      raf = requestAnimationFrame(tick);
    };
    ctx.resume().catch(() => {});
    tick();
    return () => {
      cancelAnimationFrame(raf);
      ctx.close().catch(() => {});
    };
  }, [keyList]);
  return bars;
}

export function SoundMixer({ show }: { show: Show }) {
  const name = useName();
  useVoice((v) => v.version); // tracks come and go
  const st = show.state || {};
  const [local, setLocal] = useState<Record<string, MixEntry>>({});
  const timer = useRef(0);
  const mix = { ...(st.mix || {}), ...local };
  const recorderName = name(show.recorder_id);

  const update = (key: string, p: MixEntry) => {
    const next = { ...mix, [key]: { ...mix[key], ...p } };
    setLocal((l) => ({ ...l, [key]: next[key] }));
    clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      showApi
        .state(show.id, { mix: next })
        .then(() => setLocal({}))
        .catch((e) => toast(e.message, "error"));
    }, 150);
  };

  const sources = mixSources(show);
  const tracks = new Map<string, MediaStreamTrack>();
  for (const s of sources) if (s.track) tracks.set(s.key, s.track);
  const bars = useMeters(tracks);

  const label = (s: (typeof sources)[number]) =>
    s.kind === "mic"
      ? `🎤 ${name(s.uid!)}`
      : s.kind === "screen"
        ? `🖥️ ${name(s.uid!)}'s app / game sound`
        : s.kind === "music"
          ? `🎵 Music from ${name(s.uid!)}`
          : s.kind === "soundboard"
            ? "🔊 Soundboard"
            : `💻 Everything playing on ${recorderName}'s PC`;
  const note = (s: (typeof sources)[number]) =>
    s.kind === "pc" ? "Other apps too (not Llamble). Windows app only." : s.kind === "screen" && !s.track ? "not sharing sound right now" : s.kind === "mic" && !s.track ? "mic off" : "";

  const row = (key: string, text: string, sub: string, meter: boolean) => {
    const g = mixGain({ mix }, key);
    const on = (mix[key]?.on ?? key !== "pc") as boolean;
    const vol = mix[key]?.vol ?? 1;
    return (
      <div key={key} className={"mix-row" + (on ? "" : " off")}>
        <button className={"mix-on" + (on ? " on" : "")} title={on ? "In the recording — click to leave out" : "Left out — click to put in"} onClick={() => update(key, { on: !on })}>
          {on ? "ON" : "OFF"}
        </button>
        <div className="mix-name">
          <div className="ellipsis">{text}</div>
          {sub && <div className="muted small ellipsis">{sub}</div>}
          {meter && (
            <div className="mix-meter">
              <div ref={(el) => (el ? bars.current.set(key, el) : bars.current.delete(key))} />
            </div>
          )}
        </div>
        <input type="range" min={0} max={200} step={5} value={Math.round(vol * 100)} disabled={!on} onChange={(e) => update(key, { vol: Number(e.target.value) / 100 })} />
        <span className="mix-pct">{on ? Math.round(g * 100) + "%" : "—"}</span>
      </div>
    );
  };

  return (
    <div className="mixer">
      {sources.map((s) => row(s.key, label(s), note(s), !!s.track))}
      {row("master", "🎚️ Master (whole recording)", "", false)}
      <div className="muted small">People's voices and shared sound only go in if they said yes. Changes apply to the recording live.</div>
    </div>
  );
}

const fmt = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;

export function MusicPanel() {
  const items = useShowMusic((s) => s.items);
  const live = useShowMusic((s) => s.live);
  const file = useRef<HTMLInputElement>(null);
  return (
    <div className="music">
      <div className="row gap">
        <button className="btn small primary" onClick={() => file.current?.click()}>
          + Add music or sounds
        </button>
        <span className="muted small grow">{live ? "Playing into the call — everyone hears it, and it's in the recording." : "mp3, wav, ogg, flac… they stay on your computer."}</span>
        <input
          ref={file}
          type="file"
          accept="audio/*"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files?.length) addMusic(e.target.files).catch((err) => toast(err.message, "error"));
            e.target.value = "";
          }}
        />
      </div>
      {items.map((m) => (
        <div key={m.id} className={"music-row" + (m.playing ? " playing" : "")}>
          <button className="mix-on on" title={m.playing ? "Pause" : "Play"} onClick={() => (m.playing ? pauseMusic(m.id) : playMusic(m.id).catch((e) => toast(e.message, "error")))}>
            {m.playing ? "❚❚" : "▶"}
          </button>
          <div className="mix-name">
            <div className="ellipsis">{m.name}</div>
            <div className="music-progress">
              <div style={{ width: (m.duration ? (m.pos / m.duration) * 100 : 0) + "%" }} />
            </div>
            <div className="muted small">
              {fmt(m.pos)} / {fmt(m.duration)}
            </div>
          </div>
          <button className={"camfx-chip" + (m.loop ? " on" : "")} title="Play it over and over" onClick={() => setMusic(m.id, { loop: !m.loop })}>
            🔁 Loop
          </button>
          <button className={"camfx-chip" + (m.duck ? " on" : "")} title="Turn it down while people talk" onClick={() => setMusic(m.id, { duck: !m.duck })}>
            🗣️ Duck
          </button>
          <input type="range" min={0} max={150} step={5} value={Math.round(m.vol * 100)} onChange={(e) => setMusic(m.id, { vol: Number(e.target.value) / 100 })} title="Volume" />
          <button className="icon-btn" title="Remove" onClick={() => removeMusic(m.id)}>
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
