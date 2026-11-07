import { useEffect } from "react";
import { api, media as mediaSrc } from "../api";
import { can, currentChannelId, isUnread, selectChannel, useStore } from "../store";
import { P } from "../types";
import { copy, openMenu, openModal, useUI } from "../ui";
import { useVoice } from "../voice";
import { ChatView } from "./ChatView";
import { ContextMenu, GuildIcon, Icon, Toasts } from "./common";
import { MemberList } from "./MemberList";
import { Modals } from "./Modals";
import { Sidebar } from "./Sidebar";
import { VoiceView } from "./VoiceView";

export function Shell() {
  const ready = useStore((s) => s.ready);
  const conn = useStore((s) => s.conn);
  const channelId = useStore((s) => currentChannelId(s));
  const channel = useStore((s) => (channelId ? s.channels[channelId] : undefined));
  const memberListOpen = useStore((s) => s.memberListOpen);
  const selectedGuild = useStore((s) => s.selectedGuild);
  const ringing = useStore((s) => s.ringing);

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
    <div className="shell">
      <div className="titlebar">
        <span className="titlebar-name">Llamble</span>
        {conn !== "open" && <span className="conn-warn">Reconnecting…</span>}
      </div>
      <div className="layout">
        <GuildBar />
        <Sidebar />
        <main className="main">
          {channel ? (
            channel.kind === "voice" ? (
              <VoiceView channel={channel} />
            ) : (
              <ChatView key={channel.id} channel={channel} />
            )
          ) : (
            <EmptyMain home={selectedGuild === "@me"} />
          )}
        </main>
        {channel && channel.guild_id && channel.kind === "text" && memberListOpen && <MemberList guildId={channel.guild_id} />}
      </div>
      {ringing && <RingBanner />}
      <Modals />
      <ContextMenu />
      <Toasts />
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
  const voiceGuild = useStore((s) => {
    const cid = useVoice.getState().channelId;
    return cid ? s.channels[cid]?.guild_id : null;
  });
  useVoice((v) => v.channelId);

  const canCreate = cfg.guild_create === "all" || me?.is_admin;

  return (
    <nav className="guildbar">
      <button className={"guild-btn home" + (selected === "@me" ? " active" : "")} onClick={() => selectChannel("@me", null)} title="Direct Messages">
        <Icon name="home" size={24} />
        {unread["@me"]?.mentions ? <span className="badge">{unread["@me"].mentions}</span> : null}
      </button>
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
              onClick={() => selectChannel(id, useStore.getState().lastChannel[id] ?? null)}
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

