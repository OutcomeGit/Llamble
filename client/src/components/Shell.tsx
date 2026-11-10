import { useEffect, useState } from "react";
import { api, media as mediaSrc } from "../api";
import { can, currentChannelId, isUnread, onEvent, openGuildView, openHome, selectChannel, showMobileNav, useStore } from "../store";
import { useIsPhone } from "../phone";
import { Board, useUnreadNotes } from "./Home";
import { P } from "../types";
import { copy, openMenu, openModal, toast, useUI } from "../ui";
import { useVoice } from "../voice";
import { ChatView } from "./ChatView";
import { ContextMenu, GuildIcon, Icon, Toasts } from "./common";
import { MemberList } from "./MemberList";
import { PopoutOverlay } from "./Overlay";
import { Popouts } from "./Popouts";
import { ShowPrompts } from "./Show";
import { Modals } from "./Modals";
import { notifyResetRequest } from "./Recovery";
import { Sidebar } from "./Sidebar";
import { VoiceView } from "./VoiceView";
import { Library } from "./Library";
import { androidSend, isAndroidApp, useAndroidUpdate } from "../android";

export function Shell() {
  const ready = useStore((s) => s.ready);
  const conn = useStore((s) => s.conn);
  const channelId = useStore((s) => currentChannelId(s));
  const channel = useStore((s) => (channelId ? s.channels[channelId] : undefined));
  const memberListOpen = useStore((s) => s.memberListOpen);
  const selectedGuild = useStore((s) => s.selectedGuild);
  const homePage = useStore((s) => s.homePage);
  const mobileMain = useStore((s) => s.mobileMain);
  const mobile = useIsPhone();
  // phones: the member list slides over the chat when asked for, so it starts closed
  useEffect(() => {
    if (mobile) useStore.setState({ memberListOpen: false });
  }, [mobile]);
  const guildView = useStore((s) => s.guildView[s.selectedGuild]);
  const ringing = useStore((s) => s.ringing);
  const [update, setUpdate] = useState<string | null>(null);
  // family & account notices
  useEffect(
    () =>
      onEvent((t, d) => {
        const me = useStore.getState().me;
        if (t === "KID_REQUEST") {
          const what = d.kind === "dm" ? `wants to chat with ${d.target?.display_name}` : `wants to join ${d.target?.name}`;
          toast(`${d.kid?.display_name} ${what}. Open Settings → Family to answer.`);
        }
        if (t === "KID_REQUEST_DONE" && d.kid?.id === me?.id) {
          const what = d.kind === "dm" ? `chat with ${d.target?.display_name}` : `join ${d.target?.name}`;
          toast(d.status === "approved" ? `A parent said yes: you can ${what} now!` : `A parent said no to: ${what}.`);
        }
        if (t === "RESET_REQUEST") notifyResetRequest(d);
      }),
    [],
  );
  useEffect(() => window.llambleNative?.onUpdateReady((v) => setUpdate(v ?? "")), []);

  useEffect(() => {
    if (!ringing) return;
    const t = setTimeout(() => useStore.setState({ ringing: null }), 30000);
    return () => clearTimeout(t);
  }, [ringing]);

  if (!ready) {
    return (
      <div className="loading-screen">
        <div className="titlebar-drag" />
        <div className="spinner" />
        <div className="muted">{conn === "closed" ? "Reconnecting to server…" : "Connecting…"}</div>
      </div>
    );
  }

  return (
    <div className={"shell" + (mobile ? (mobileMain ? " m-main" : " m-nav") : "")}>
      <div className="titlebar">
        {mobile && mobileMain && (
          <button className="m-menu" aria-label="Servers and channels" onClick={() => showMobileNav(true)}>
            ☰
          </button>
        )}
        <span className="titlebar-name">Llamble</span>
        {conn !== "open" && <span className="conn-warn">Reconnecting…</span>}
        {update !== null ? (
          <button className="update-pill" onClick={() => window.llambleNative?.installUpdate()} title="Restart to update">
            Update {update} ready — restart
          </button>
        ) : (
          <VersionNotice />
        )}
      </div>
      <div className="layout">
        {/* phones: picking something in the list opens it full screen */}
        <div
          className="nav-pane"
          onClickCapture={(e) => {
            const row = (e.target as Element).closest(".channel, .dm-row");
            if (mobile && row && !row.querySelector(".soon-tag")) setTimeout(() => showMobileNav(false), 0);
          }}
        >
          <GuildBar />
          <Sidebar />
        </div>
        <main className="main">
          {selectedGuild === "@home" ? (
            homePage === "library" ? (
              <Library />
            ) : (
              <Board key="@home" scope="@home" />
            )
          ) : guildView ? (
            <Board key={selectedGuild} scope={selectedGuild} />
          ) : channel ? (
            channel.kind === "voice" ? (
              <VoiceView channel={channel} />
            ) : (
              <ChatView key={channel.id} channel={channel} />
            )
          ) : (
            <EmptyMain home={selectedGuild === "@me"} />
          )}
        </main>
        {mobile && channel && channel.kind === "text" && memberListOpen && <div className="member-backdrop" onClick={() => useStore.setState({ memberListOpen: false })} />}
        {channel && channel.guild_id && channel.kind === "text" && memberListOpen && <MemberList guildId={channel.guild_id} />}
      </div>
      {ringing && <RingBanner />}
      <Modals />
      <ContextMenu />
      <Toasts />
      <PopoutOverlay />
      <Popouts />
      <ShowPrompts />
      <Lightbox />
    </div>
  );
}

function RingBanner() {
  const ringing = useStore((s) => s.ringing)!;
  const from = useStore((s) => s.users[ringing.from]);
  return (
    <div className="ring-banner">
      <span>📞 {from?.display_name ?? "Someone"} is calling you</span>
      <button
        className="btn green"
        onClick={() => {
          useStore.setState({ ringing: null });
          selectChannel("@me", ringing.channel_id);
          import("../voice").then((v) => v.joinVoice(ringing.channel_id));
        }}
      >
        Join
      </button>
      <button className="btn" onClick={() => useStore.setState({ ringing: null })}>
        Ignore
      </button>
    </div>
  );
}

function EmptyMain({ home }: { home: boolean }) {
  const bot = useStore((s) => s.config.bot);
  return (
    <div className="empty-main">
      <div className="empty-art">💬</div>
      <h2>{home ? "No conversation selected" : "No channels yet"}</h2>
      <p className="muted">{home ? "Pick a friend from the list, or start a chat from someone's profile." : "Create a channel to get started."}</p>
      {home && bot && (
        <button
          className="btn primary"
          onClick={async () => {
            const dm = await api("/api/bot/dm", { method: "POST" });
            selectChannel("@me", dm.id);
          }}
        >
          <Icon name="bot" size={16} /> Chat with {bot.name}
        </button>
      )}
    </div>
  );
}

function GuildBar() {
  const order = useStore((s) => s.guildOrder);
  const guilds = useStore((s) => s.guilds);
  const selected = useStore((s) => s.selectedGuild);
  const me = useStore((s) => s.me);
  const cfg = useStore((s) => s.config);
  const unreadByGuild = useStore((s) => {
    const out: Record<string, { unread: boolean; mentions: number }> = {};
    for (const ch of Object.values(s.channels)) {
      const key = ch.guild_id || "@me";
      const o = (out[key] ||= { unread: false, mentions: 0 });
      if (ch.kind !== "voice" && ch.kind !== "category" && isUnread(ch, s)) o.unread = true;
      o.mentions += s.mentions[ch.id] || 0;
    }
    return JSON.stringify(out);
  });
  const unread = JSON.parse(unreadByGuild) as Record<string, { unread: boolean; mentions: number }>;
  // conversations with anything unread (not just mentions), so new DMs are noticeable
  const unreadDms = useStore((s) => Object.values(s.channels).filter((c) => !c.guild_id && c.kind !== "voice" && c.kind !== "category" && isUnread(c, s)).length);
  const voiceGuild = useStore((s) => {
    const cid = useVoice.getState().channelId;
    return cid ? s.channels[cid]?.guild_id : null;
  });
  useVoice((v) => v.channelId);

  const canCreate = cfg.guild_create === "all" || me?.is_admin;
  const unreadNotes = useUnreadNotes();

  return (
    <nav className="guildbar">
      <div className="guild-wrap">
        <span className={"guild-pill" + (selected === "@home" ? " active" : "")} />
        <button className={"guild-logo" + (selected === "@home" ? " active" : "")} title="Home: notes for you, who's around, highlights" onClick={() => openHome()}>
          <img src="./icon-192.png" alt="Llamble" draggable={false} />
          {unreadNotes ? <span className="badge">{unreadNotes}</span> : null}
        </button>
      </div>
      <div className="guild-sep" />
      <div className="guild-wrap">
        <span className={"guild-pill" + (selected === "@me" ? " active" : unreadDms ? " unread" : "")} />
        <button
          className={"guild-btn dms" + (selected === "@me" ? " active" : "") + (unreadDms ? " has-unread" : "")}
          onClick={() => selectChannel("@me", null)}
          title={unreadDms ? `Direct Messages · ${unreadDms} unread` : "Direct Messages"}
        >
          <Icon name="chat" size={22} />
          {unreadDms || unread["@me"]?.mentions ? <span className="badge">{Math.max(unreadDms, unread["@me"]?.mentions || 0)}</span> : null}
        </button>
      </div>
      <div className="guild-sep" />
      {order.map((id) => {
        const g = guilds[id];
        if (!g) return null;
        const u = unread[id];
        return (
          <div key={id} className="guild-wrap">
            <span className={"guild-pill" + (selected === id ? " active" : u?.unread ? " unread" : "")} />
            <button
              className={"guild-btn" + (selected === id ? " active" : "") + (g.icon_file_id ? " has-img" : "")}
              title={g.name}
              onClick={() => openGuildView(id)}
              onContextMenu={(e) =>
                openMenu(e, [
                  { label: "Invite People", onClick: () => openModal({ kind: "invite", guildId: id }), disabled: !can(id, P.CREATE_INVITE) },
                  { label: "Mark As Read", onClick: () => markGuildRead(id) },
                  { separator: true, label: "" },
                  { label: "Server Settings", onClick: () => openModal({ kind: "serverSettings", guildId: id }), disabled: !can(id, P.MANAGE_GUILD) && !can(id, P.MANAGE_ROLES) },
                  { label: "Copy Server ID", onClick: () => copy(id, "ID copied") },
                ])
              }
            >
              <GuildIcon name={g.name} iconId={g.icon_file_id} />
              {voiceGuild === id && <span className="voice-dot" title="You're in voice here"><Icon name="speaker" size={10} stroke={3} /></span>}
              {u?.mentions ? <span className="badge">{u.mentions}</span> : null}
            </button>
          </div>
        );
      })}
      {canCreate && (
        <button className="guild-btn add" title="Create a server" onClick={() => openModal({ kind: "createGuild" })}>
          <Icon name="plus" size={22} />
        </button>
      )}
      <button className="guild-btn add" title="Join with an invite" onClick={() => openModal({ kind: "joinInvite" })}>
        <Icon name="link" size={20} />
      </button>
    </nav>
  );
}

export function markGuildRead(guildId: string) {
  const s = useStore.getState();
  for (const ch of Object.values(s.channels)) {
    if (ch.guild_id === guildId && ch.last_message_id && isUnread(ch, s)) {
      api(`/api/channels/${ch.id}/ack`, { body: { message_id: ch.last_message_id } }).catch(() => {});
    }
  }
}

function Lightbox() {
  const lb = useUI((s) => s.lightbox);
  useEffect(() => {
    if (!lb) return;
    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape") useUI.setState({ lightbox: null });
      if (e.key === "ArrowRight") useUI.setState({ lightbox: { ...lb, index: (lb.index + 1) % lb.items.length } });
      if (e.key === "ArrowLeft") useUI.setState({ lightbox: { ...lb, index: (lb.index - 1 + lb.items.length) % lb.items.length } });
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [lb]);
  if (!lb) return null;
  const f = lb.items[lb.index];
  return (
    <div className="lightbox" onClick={() => useUI.setState({ lightbox: null })}>
      <img src={mediaSrc(f.url)} alt={f.filename} onClick={(e) => e.stopPropagation()} />
      <div className="lightbox-bar" onClick={(e) => e.stopPropagation()}>
        <span>{f.filename}</span>
        <a href={mediaSrc(f.url)} download={f.filename} className="btn small">
          <Icon name="download" size={14} /> Open original
        </a>
        {lb.items.length > 1 && (
          <span className="muted">
            {lb.index + 1} / {lb.items.length}
          </span>
        )}
      </div>
    </div>
  );
}


/** "1.2.10" > "1.2.9"; non-numeric parts count as 0 */
export function newer(a?: string, b?: string) {
  if (!a || !b) return false;
  const pa = a.split(".").map((x) => parseInt(x) || 0);
  const pb = b.split(".").map((x) => parseInt(x) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}

/** The server announces its version; anyone on an older app (or an old cached web page) is told to update. */
function VersionNotice() {
  const config = useStore((s) => s.config);
  const isAdmin = useStore((s) => !!s.me?.is_admin);
  const [mine, setMine] = useState<string>(window.llambleNative ? "" : __APP_VERSION__);
  const [status, setStatus] = useState<{ state: string; percent?: number; message?: string } | null>(null);
  const [hidden, setHidden] = useState("");
  const androidUpdate = useAndroidUpdate();
  useEffect(() => {
    window.llambleNative?.version().then(setMine).catch(() => {});
    return window.llambleNative?.onUpdateStatus?.(setStatus);
  }, []);
  const server = config.version;
  if (!mine || !server || server === "0.0.0" || mine === "0.0.0" || hidden === server) return null;
  if (isAndroidApp) {
    // the phone app updates from its own downloads, not the server's: only when one exists
    return androidUpdate ? (
      <button className="update-pill" onClick={() => androidSend("check-update")}>
        Llamble {androidUpdate} is out — update
      </button>
    ) : null;
  }
  if (newer(server, mine)) {
    if (!window.llambleNative) {
      // web: the server already has the new page, the browser just has an old copy
      return (
        <button
          className="update-pill"
          onClick={async () => {
            try {
              const regs = await navigator.serviceWorker?.getRegistrations();
              await Promise.all((regs || []).map((r) => r.unregister()));
              const keys = await caches?.keys();
              await Promise.all((keys || []).map((k) => caches.delete(k)));
            } catch {}
            location.reload();
          }}
        >
          New version {server} — reload
        </button>
      );
    }
    if (status?.state === "error") {
      return (
        <a className="update-pill" href={config.client_download} target="_blank" rel="noreferrer" title={status.message}>
          Llamble {server} is out — download it
        </a>
      );
    }
    if (status?.state === "downloading" || status?.state === "checking") {
      return <span className="update-pill">Updating to {server}… {status.percent ? `${status.percent}%` : ""}</span>;
    }
    return (
      <button className="update-pill" onClick={() => window.llambleNative?.checkUpdate?.()}>
        Llamble {server} is out — update now
      </button>
    );
  }
  if (isAdmin && newer(mine, server)) {
    return (
      <button className="update-pill subtle" title="Click to hide" onClick={() => setHidden(server)}>
        Your server is on {server}; update the Llamble server to get {mine}
      </button>
    );
  }
  return null;
}
