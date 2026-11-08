import { useEffect, useRef, useState } from "react";
import { Track, type Participant } from "livekit-client";
import { memberName, useStore } from "../store";
import type { Channel } from "../types";
import { closePopout, openPopout, popoutSupported, setOverlayPrefs, useOverlayPrefs, usePopout } from "../overlay";
import { openModal, toast } from "../ui";
import { shareAllowed, enableAudio, getRoom, joinVoice, leaveVoice, participants, startScreenShare, stopScreenShare, toggleCamera, toggleDeafen, toggleMute, useVoice, type ShareQuality } from "../voice";
import { Avatar, Icon } from "./common";
import { userMenu } from "./Sidebar";

interface TileSpec {
  key: string;
  participant: Participant;
  source: Track.Source;
}

export function VoiceView({ channel }: { channel: Channel }) {
  const v = useVoice();
  const inThis = v.channelId === channel.id;
  const others = useStore((s) => Object.values(s.voiceStates).filter((x) => x.channel_id === channel.id).length);
  const [focus, setFocus] = useState<string | null>(null);

  if (!inThis) {
    return (
      <div className="voice-view idle">
        <Icon name="speaker" size={48} />
        <h2>{channel.name}</h2>
        <p className="muted">{others ? `${others} connected` : "No one is here yet."}</p>
        <button className="btn green" onClick={() => joinVoice(channel.id)} disabled={v.status === "connecting"}>
          {v.status === "connecting" ? "Connecting…" : "Join Voice"}
        </button>
        {v.error && <p className="form-error">{v.error}</p>}
      </div>
    );
  }

  const tiles: TileSpec[] = [];
  for (const p of participants()) {
    const screen = p.getTrackPublication(Track.Source.ScreenShare);
    if (screen && !screen.isMuted && screen.track) tiles.push({ key: p.identity + ":screen", participant: p, source: Track.Source.ScreenShare });
    tiles.push({ key: p.identity + ":cam", participant: p, source: Track.Source.Camera });
  }
  const focused = tiles.find((t) => t.key === focus) || tiles.find((t) => t.source === Track.Source.ScreenShare && focus === null && tiles.length > 2 && false);
  const rest = focused ? tiles.filter((t) => t !== focused) : tiles;

  return (
    <div className="voice-view">
      <header className="chat-header">
        <Icon name="speaker" size={22} className="muted" />
        <span className="chat-title">{channel.name}</span>
        <span className={"voice-label " + v.status}>{v.status === "connected" ? "Connected" : v.status === "reconnecting" ? "Reconnecting…" : "Connecting…"}</span>
      </header>
      {v.screen && (
        <div className="voice-alert sharing">
          <span>🔴 You're sharing your screen</span>
          <button className="btn small red" onClick={stopScreenShare}>
            Stop sharing
          </button>
        </div>
      )}
      {v.audioBlocked && (
        <button className="voice-alert clickable" onClick={enableAudio}>
          🔇 Your browser paused call sound. <b>Click here to hear everyone.</b>
        </button>
      )}
      {v.error && (
        <div className="voice-alert error">
          {v.error}
          <button className="btn small link" onClick={() => useVoice.setState({ error: null })}>
            Dismiss
          </button>
        </div>
      )}
      {focused ? (
        <div className="stage">
          <div className="stage-main">
            <Tile spec={focused} guildId={channel.guild_id} big onClick={() => setFocus(null)} />
          </div>
          <div className="stage-strip">
            {rest.map((t) => (
              <Tile key={t.key} spec={t} guildId={channel.guild_id} onClick={() => setFocus(t.key)} />
            ))}
          </div>
        </div>
      ) : (
        <div className={"tile-grid n" + Math.min(tiles.length, 9)}>
          {tiles.map((t) => (
            <Tile key={t.key} spec={t} guildId={channel.guild_id} onClick={() => setFocus(t.key)} />
          ))}
        </div>
      )}
      <div className="call-controls">
        <button className={"call-btn" + (v.camera ? " on" : "")} onClick={toggleCamera} disabled={!v.canVideo} title="Camera">
          <Icon name={v.camera ? "video" : "videoOff"} size={22} />
        </button>
        <button
          className={"call-btn" + (v.screen ? " on" : "")}
          disabled={!v.canVideo}
          onClick={() => (v.screen ? stopScreenShare() : window.llambleNative ? openModal({ kind: "screenPicker" }) : startScreenShare("", true, "1080p30"))}
          title={v.screen ? "Stop sharing your screen" : "Share screen"}
        >
          <Icon name={v.screen ? "x" : "screen"} size={22} />
        </button>
        <OverlayButton />
        <button className={"call-btn" + (v.muted ? " off" : "")} onClick={toggleMute} title="Mute">
          <Icon name={v.muted ? "micOff" : "mic"} size={22} />
        </button>
        <button className={"call-btn" + (v.deafened ? " off" : "")} onClick={toggleDeafen} title="Deafen">
          <Icon name={v.deafened ? "deaf" : "headphones"} size={22} />
        </button>
        <button className="call-btn hang" onClick={() => leaveVoice()} title="Disconnect">
          <Icon name="phoneOff" size={22} />
        </button>
      </div>
    </div>
  );
}

function Tile({ spec, guildId, big, onClick }: { spec: TileSpec; guildId: string | null; big?: boolean; onClick: () => void }) {
  useVoice((s) => s.version);
  const speaking = useVoice((s) => s.speaking.includes(spec.participant.identity));
  const user = useStore((s) => s.users[spec.participant.identity]);
  const vs = useStore((s) => s.voiceStates[spec.participant.identity]);
  const videoRef = useRef<HTMLVideoElement>(null);
  const pub = spec.participant.getTrackPublication(spec.source);
  const track = pub && !pub.isMuted ? pub.track : undefined;
  const isScreen = spec.source === Track.Source.ScreenShare;

  useEffect(() => {
    const el = videoRef.current;
    if (!el || !track) return;
    track.attach(el);
    return () => {
      track.detach(el);
    };
  }, [track]);

  const fullscreen = (e: React.MouseEvent) => {
    e.stopPropagation();
    videoRef.current?.requestFullscreen?.();
  };
  const local = spec.participant.identity === getRoom()?.localParticipant.identity;

  return (
    <div className={"tile" + (speaking && !isScreen ? " speaking" : "") + (big ? " big" : "")} onClick={onClick} onContextMenu={(e) => userMenu(e, spec.participant.identity, guildId)}>
      {track ? (
        <video ref={videoRef} autoPlay playsInline muted className={isScreen ? "contain" : local ? "mirror" : ""} />
      ) : (
        <div className="tile-avatar">
          <Avatar user={user} size={big ? 120 : 80} speaking={speaking} />
        </div>
      )}
      <div className="tile-name">
        {isScreen && <span className="live-tag">LIVE</span>}
        {vs?.muted && !isScreen && <Icon name="micOff" size={14} className="red" />}
        {memberName(guildId, user)}
        {isScreen ? "'s screen" : ""}
      </div>
      {track && (
        <button className="tile-fs icon-btn" onClick={fullscreen} title="Fullscreen">
          <Icon name="expand" size={16} />
        </button>
      )}
    </div>
  );
}

export function ScreenPicker({ onClose }: { onClose: () => void }) {
  const [sources, setSources] = useState<Awaited<ReturnType<NonNullable<typeof window.llambleNative>["getScreenSources"]>> | null>(null);
  const [tab, setTab] = useState<"screen" | "window">("screen");
  const [picked, setPicked] = useState<string | null>(null);
  const [audio, setAudio] = useState(true);
  const [quality, setQuality] = useState<ShareQuality>((localStorage.getItem("llamble.shareQuality") as ShareQuality) || "1080p30");

  useEffect(() => {
    window.llambleNative?.getScreenSources().then((s) => {
      setSources(s);
      setPicked(s.find((x) => x.kind === "screen")?.id ?? s[0]?.id ?? null);
    });
  }, []);

  const go = async () => {
    if (!picked) return;
    localStorage.setItem("llamble.shareQuality", quality);
    onClose();
    await startScreenShare(picked, audio, quality);
  };

  return (
    <div className="screen-picker">
      <div className="tabs">
        <button className={tab === "screen" ? "on" : ""} onClick={() => setTab("screen")}>
          Screens
        </button>
        <button className={tab === "window" ? "on" : ""} onClick={() => setTab("window")}>
          Applications
        </button>
      </div>
      <div className="source-grid">
        {sources === null && <div className="muted">Loading…</div>}
        {sources
          ?.filter((s) => s.kind === tab)
          .map((s) => (
            <div key={s.id} className={"source" + (picked === s.id ? " picked" : "")} onClick={() => setPicked(s.id)} onDoubleClick={go}>
              {s.thumbnail ? <img src={s.thumbnail} alt="" /> : <div className="source-blank" />}
              <div className="source-name ellipsis">
                {s.icon && <img src={s.icon} alt="" width={16} />} {s.name}
              </div>
            </div>
          ))}
      </div>
      <div className="share-opts">
        <label>
          Quality
          <select value={quality} onChange={(e) => setQuality(e.target.value as ShareQuality)}>
            <option value="720p30" disabled={!shareAllowed("720p30")}>
              720p · 30 fps
              {!shareAllowed("720p30") ? " (above server limit)" : ""}
            </option>
            <option value="1080p30" disabled={!shareAllowed("1080p30")}>
              1080p · 30 fps (text & code)
              {!shareAllowed("1080p30") ? " (above server limit)" : ""}
            </option>
            <option value="1080p60" disabled={!shareAllowed("1080p60")}>
              1080p · 60 fps (games & video)
              {!shareAllowed("1080p60") ? " (above server limit)" : ""}
            </option>
            <option value="1440p30" disabled={!shareAllowed("1440p30")}>
              1440p · 30 fps
              {!shareAllowed("1440p30") ? " (above server limit)" : ""}
            </option>
          </select>
        </label>
        <label className="check">
          <input type="checkbox" checked={audio} onChange={(e) => setAudio(e.target.checked)} /> Share system audio
        </label>
        <div className="grow" />
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn primary" disabled={!picked} onClick={go}>
          Go Live
        </button>
      </div>
    </div>
  );
}

/** Overlay on/off: the screen overlay in the Windows app, a pop-out window in browsers. */
function OverlayButton() {
  const enabled = useOverlayPrefs((s) => s.enabled);
  const pop = usePopout((s) => s.win);
  const native = !!window.llambleNative?.overlay;
  if (!native && !popoutSupported()) return null;
  const on = native ? enabled : !!pop;
  return (
    <button
      className={"call-btn" + (on ? " on" : "")}
      title={native ? (on ? "Turn off overlay (Ctrl+Shift+O moves it)" : "Show overlay on top of games") : on ? "Close the pop-out overlay" : "Pop out an always-on-top overlay"}
      onClick={async () => {
        if (native) {
          setOverlayPrefs({ enabled: !on });
          if (!on) toast("Overlay on. Press Ctrl+Shift+O to move the widgets.");
          return;
        }
        if (on) return closePopout();
        try {
          await openPopout();
        } catch (e: any) {
          toast(e.message, "error");
        }
      }}
    >
      <Icon name="expand" size={22} />
    </button>
  );
}
