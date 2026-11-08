import { useEffect, useRef, useState } from "react";
import { Track, type Participant } from "livekit-client";
import { memberName, useStore } from "../store";
import type { Channel } from "../types";
import { closePopout, openPopout, popoutSupported, setOverlayPrefs, useOverlayPrefs, usePopout } from "../overlay";
import { openModal, toast } from "../ui";
import { SHARE_LABELS, SHARE_ORDER, setWatching, shareAllowed, useWatch, watching, enableAudio, getRoom, joinVoice, leaveVoice, participants, startScreenShare, stopScreenShare, toggleCamera, toggleDeafen, toggleMute, useVoice, type ShareQuality } from "../voice";
import { Avatar, Icon } from "./common";
import { SoundboardPanel, SoundboardTicker } from "./Soundboard";
import { CameraFxPicker } from "./CameraFx";
import { DirectorPanel, ShowBanner, StartShow } from "./Show";
import { useShows } from "../show";
import { listeningIn, useBotVoice, useListen } from "../listen";
import { popOut, popoutSupported as canPopVideo } from "./Popouts";
import { userMenu } from "./Sidebar";
import { refreshGames, useGames } from "../games";

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
  const [board, setBoard] = useState(false);
  const [fxOpen, setFxOpen] = useState(false);
  const [showPanel, setShowPanel] = useState<"start" | "director" | null>(null);
  const liveShow = useShows((s) => s.live[channel.id]);
  const me = useStore((s) => s.me?.id);

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
    // shown even when you're not watching it (with a "Watch" button)
    if (screen && !screen.isMuted && (screen.track || p.identity !== getRoom()?.localParticipant.identity)) tiles.push({ key: p.identity + ":screen", participant: p, source: Track.Source.ScreenShare });
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
      <LlambleVoice channel={channel} />
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
      <ShowBanner onDirect={() => setShowPanel("director")} />
      <SoundboardTicker guildId={channel.guild_id} />
      <div className="call-controls">
        {showPanel === "start" && !liveShow && <StartShow channelId={channel.id} onClose={() => setShowPanel(null)} />}
        {showPanel === "director" && liveShow && <DirectorPanel onClose={() => setShowPanel(null)} />}
        {board && <SoundboardPanel guildId={channel.guild_id} onClose={() => setBoard(false)} />}
        {fxOpen && (
          <div className="camfx-pop">
            <div className="sb-head">
              <b>Camera effects</b>
              <button className="btn small" onClick={() => setFxOpen(false)}>
                Close
              </button>
            </div>
            <CameraFxPicker />
          </div>
        )}
        <button className={"call-btn" + (v.camera ? " on" : "")} onClick={toggleCamera} disabled={!v.canVideo} title="Camera">
          <Icon name={v.camera ? "video" : "videoOff"} size={22} />
        </button>
        {v.canVideo && (
          <button className={"call-btn" + (fxOpen ? " on" : "")} onClick={() => (setFxOpen((o) => !o), setBoard(false))} title="Camera effects and face filters">
            <span style={{ fontSize: 20 }}>✨</span>
          </button>
        )}
        <button
          className={"call-btn" + (v.screen ? " on" : "")}
          disabled={!v.canVideo}
          onClick={() => (v.screen ? stopScreenShare() : window.llambleNative ? openModal({ kind: "screenPicker" }) : startScreenShare("", true, "1080p30"))}
          title={v.screen ? "Stop sharing your screen" : "Share screen"}
        >
          <Icon name={v.screen ? "x" : "screen"} size={22} />
        </button>
        <StreamGameButton />
        <OverlayButton />
        <button
          className={"call-btn" + (liveShow?.status === "recording" ? " rec" : showPanel ? " on" : "")}
          onClick={() => {
            setBoard(false);
            setFxOpen(false);
            if (liveShow) setShowPanel(liveShow.director_id === me ? (showPanel ? null : "director") : null);
            else setShowPanel(showPanel ? null : "start");
          }}
          title={liveShow ? (liveShow.director_id === me ? "Director controls" : "A show is on") : "Record a show"}
        >
          <span style={{ fontSize: 20 }}>🎬</span>
        </button>
        {v.canSpeak && (
          <button className={"call-btn" + (board ? " on" : "")} onClick={() => setBoard((b) => !b)} title="Soundboard">
            <span style={{ fontSize: 20 }}>🎶</span>
          </button>
        )}
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
  useWatch();
  const kind = isScreen ? "screen" : "camera";
  const id = spec.participant.identity;
  const local = id === getRoom()?.localParticipant.identity;
  // they're sending video but you chose not to watch it
  const hidden = !local && !!pub && !pub.isMuted && !watching(id, kind);

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
  return (
    <div className={"tile" + (speaking && !isScreen ? " speaking" : "") + (big ? " big" : "")} onClick={onClick} onContextMenu={(e) => userMenu(e, spec.participant.identity, guildId)}>
      {track && !hidden ? (
        <video ref={videoRef} autoPlay playsInline muted className={isScreen ? "contain" : local ? "mirror" : ""} />
      ) : hidden && isScreen ? (
        <div className="tile-avatar tile-watch">
          <Avatar user={user} size={big ? 96 : 64} />
          <button
            className="btn primary"
            onClick={(e) => {
              e.stopPropagation();
              setWatching(id, "screen", true);
            }}
          >
            ▶ Watch stream
          </button>
        </div>
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
      {hidden && !isScreen && (
        <button
          className="tile-show btn small"
          onClick={(e) => {
            e.stopPropagation();
            setWatching(id, "camera", true);
          }}
          title="You hid this camera"
        >
          Show video
        </button>
      )}
      {track && !hidden && (
        <div className="tile-btns">
          {!local && (
            <button
              className="icon-btn"
              onClick={(e) => {
                e.stopPropagation();
                setWatching(id, kind, false);
              }}
              title={isScreen ? "Stop watching" : "Hide their video"}
            >
              🚫
            </button>
          )}
          {canPopVideo() && (
            <button
              className="icon-btn"
              onClick={(e) => {
                e.stopPropagation();
                popOut(spec.participant.identity, spec.source);
              }}
              title="Pop out: a floating window you can drag anywhere, even over games"
            >
              ⧉
            </button>
          )}
          <button className="icon-btn" onClick={fullscreen} title="Fullscreen">
            <Icon name="expand" size={16} />
          </button>
        </div>
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
  useStore((s) => s.config.media); // re-check the server's limits when they change

  const games = useGames((g) => g.list);
  const gameIds = new Set(games.map((g) => g.sourceId).filter(Boolean) as string[]);

  useEffect(() => {
    Promise.all([window.llambleNative!.getScreenSources(), refreshGames()]).then(([s, gs]) => {
      setSources(s);
      // a game is open: start on its window, at 60 fps if the server allows
      const game = gs.find((g) => g.sourceId && s.some((x) => x.id === g.sourceId));
      if (game) {
        setTab("window");
        setPicked(game.sourceId);
        setQuality((q) => gameQuality(q));
      } else {
        setPicked(s.find((x) => x.kind === "screen")?.id ?? s[0]?.id ?? null);
      }
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
          .sort((a, b) => Number(gameIds.has(b.id)) - Number(gameIds.has(a.id)))
          .map((s) => (
            <div key={s.id} className={"source" + (picked === s.id ? " picked" : "")} onClick={() => setPicked(s.id)} onDoubleClick={go}>
              {gameIds.has(s.id) && <span className="source-game">🎮 Game</span>}
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
            {SHARE_ORDER.map((q) => (
              <option key={q} value={q} disabled={!shareAllowed(q)}>
                {SHARE_LABELS[q]}
                {!shareAllowed(q) ? " (above server limit)" : ""}
              </option>
            ))}
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

/** Games look best at 60 fps: keep the chosen size, raise the frame rate if the server allows it. */
function gameQuality(q: ShareQuality): ShareQuality {
  if (q === "native" || q.endsWith("p60")) return q;
  const sixty = (q.replace("p30", "p60") as ShareQuality);
  if (SHARE_ORDER.includes(sixty) && shareAllowed(sixty)) return sixty;
  return shareAllowed("1080p60") ? "1080p60" : q;
}

/** One click: "Stream Roblox" — shares the game's window with its sound at 60 fps. */
function StreamGameButton() {
  const games = useGames((g) => g.list);
  const v = useVoice();
  const game = games.find((g) => g.sourceId);
  if (!game || v.screen || !v.canVideo) return null;
  return (
    <button
      className="call-btn stream-game"
      title={`Stream ${game.name} (its window and sound, 60 fps)`}
      onClick={() => {
        const q = gameQuality((localStorage.getItem("llamble.shareQuality") as ShareQuality) || "1080p30");
        startScreenShare(game.sourceId!, true, q);
      }}
    >
      <Icon name="gamepad" size={20} />
      <span className="ellipsis">Stream {game.name}</span>
    </button>
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

/** "Llamble is listening" + the first-time notice + what Llamble is saying. */
function LlambleVoice({ channel }: { channel: Channel }) {
  useStore((s) => s.config);
  const bot = useStore((s) => s.config.bot?.name || "Llamble");
  const notice = useStore((s) => (s.config as any).voice_ai?.notice as string | undefined);
  const { thinking, caption, convo } = useBotVoice();
  const users = useStore((s) => s.users);
  const myId = useStore((s) => s.me?.id);
  const listen = useListen();
  const [, force] = useState(0);
  useEffect(() => {
    const t = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  if (!listeningIn(channel.id)) return null;
  const key = "llamble.voiceNotice." + channel.guild_id;
  const seen = localStorage.getItem(key) === "1";
  return (
    <>
      {!seen && notice && (
        <div className="voice-alert listen-notice">
          <div>
            <b>👂 {bot} is listening in this server's calls.</b> {notice}
          </div>
          <button className="btn small" onClick={() => (localStorage.setItem(key, "1"), force((n) => n + 1))}>
            Got it
          </button>
        </div>
      )}
      <div className="listen-row">
        <span className="listen-badge" title={`Say "Hey ${bot}" and ask anything out loud`}>
          👂 {bot} is listening · say “Hey {bot}”
        </span>
        {thinking && !caption && <span className="listen-thinking">{bot} is thinking…</span>}
        {convo && convo.until > Date.now() && !thinking && (
          <span className="listen-convo">
            💬 {convo.user === myId ? "Talking with you — just keep talking (say “thanks” to stop)" : `Talking with ${users[convo.user]?.display_name ?? "someone"}`} · {Math.max(0, Math.round((convo.until - Date.now()) / 1000))}s
          </span>
        )}
        {listen.suspended && <span className="listen-warn">Click anywhere so {bot} can hear you</span>}
        {!listen.capturing && !listen.suspended && <span className="listen-warn">Not hearing you (muted?)</span>}
      </div>
      {listen.heard && Date.now() - listen.heard.at < 8000 && (
        <div className="listen-heard">
          {bot} heard you: “{listen.heard.text}” {listen.heard.wake ? "✓" : ""}
        </div>
      )}
      {caption && (
        <div className="bot-caption">
          <b>🦙 {bot}:</b> {caption.text}
        </div>
      )}
    </>
  );
}
