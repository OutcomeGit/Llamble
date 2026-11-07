import { api } from "../api";
import { sendGateway } from "../gateway";
import { can, channelSort, currentChannelId, isUnread, memberName, selectChannel, useStore } from "../store";
import { P, type Channel } from "../types";
import { copy, openMenu, openModal, toggleCollapsed, toast, useUI } from "../ui";
import { joinVoice, leaveVoice, stopScreenShare, toggleCamera, toggleDeafen, toggleMute, useVoice } from "../voice";
import { Avatar, BotTag, Icon } from "./common";
import { markGuildRead } from "./Shell";
import { logout } from "../App";

export function Sidebar() {
  const gid = useStore((s) => s.selectedGuild);
  return (
    <aside className="sidebar">
      {gid === "@me" ? <DmList /> : <ChannelList guildId={gid} />}
      <VoicePanel />
      <UserPanel />
    </aside>
  );
}

function GuildHeader({ guildId }: { guildId: string }) {
  const guild = useStore((s) => s.guilds[guildId]);
  const me = useStore((s) => s.me);
  if (!guild) return null;
  const items = [
    { label: "Invite People", onClick: () => openModal({ kind: "invite", guildId }), disabled: !can(guildId, P.CREATE_INVITE) },
    { label: "Server Settings", onClick: () => openModal({ kind: "serverSettings", guildId }), disabled: !can(guildId, P.MANAGE_GUILD) && !can(guildId, P.MANAGE_ROLES) && !can(guildId, P.BAN) },
    { label: "AI Bot", onClick: () => openModal({ kind: "serverSettings", guildId, tab: "bot" }), disabled: !can(guildId, P.MANAGE_GUILD) },
    { separator: true, label: "" },
    { label: "Create Channel", onClick: () => openModal({ kind: "createChannel", guildId }), disabled: !can(guildId, P.MANAGE_CHANNELS) },
    { label: "Create Category", onClick: () => openModal({ kind: "createChannel", guildId, channelKind: "category" }), disabled: !can(guildId, P.MANAGE_CHANNELS) },
    { label: "Mark As Read", onClick: () => markGuildRead(guildId) },
    { separator: true, label: "" },
    {
      label: "Leave Server",
      danger: true,
      disabled: guild.owner_id === me?.id,
      onClick: () =>
        openModal({
          kind: "confirm",
          title: `Leave '${guild.name}'`,
          body: "You won't be able to rejoin unless you are re-invited.",
          danger: true,
          confirmLabel: "Leave Server",
          onConfirm: () => api(`/api/guilds/${guildId}/members/@me`, { method: "DELETE" }),
        }),
    },
  ];
  return (
    <button className="sidebar-header" onClick={(e) => openMenu({ clientX: e.currentTarget.getBoundingClientRect().left + 8, clientY: e.currentTarget.getBoundingClientRect().bottom + 4 }, items)}>
      <span className="ellipsis">{guild.name}</span>
      <Icon name="chevron" size={18} />
    </button>
  );
}

function ChannelList({ guildId }: { guildId: string }) {
  const channels = useStore((s) => s.channels);
  const sort = channelSort(useStore.getState());
  const list = Object.values(channels).filter((c) => c.guild_id === guildId).sort(sort);
  const cats = list.filter((c) => c.kind === "category").sort((a, b) => a.position - b.position);
  const loose = list.filter((c) => c.kind !== "category" && (!c.parent_id || !channels[c.parent_id]));
  const collapsed = useUI((s) => s.collapsed);
  const manage = can(guildId, P.MANAGE_CHANNELS);

  return (
    <>
      <GuildHeader guildId={guildId} />
      <div className="channel-scroll">
        {loose.map((c) => (
          <ChannelRow key={c.id} ch={c} />
        ))}
        {cats.map((cat) => {
          const kids = list.filter((c) => c.parent_id === cat.id).sort((a, b) => a.position - b.position);
          const isCollapsed = collapsed[cat.id];
          return (
            <div key={cat.id} className="category">
              <div
                className="category-head"
                onClick={() => toggleCollapsed(cat.id)}
                onContextMenu={(e) =>
                  manage &&
                  openMenu(e, [
                    { label: "Create Channel", onClick: () => openModal({ kind: "createChannel", guildId, parentId: cat.id }) },
                    { label: "Edit Category", onClick: () => openModal({ kind: "editChannel", channelId: cat.id }) },
                  ])
                }
              >
                <Icon name="chevron" size={12} className={isCollapsed ? "rot" : ""} />
                <span>{cat.name}</span>
                {manage && (
                  <button
                    className="icon-btn tiny"
                    title="Create Channel"
                    onClick={(e) => {
                      e.stopPropagation();
                      openModal({ kind: "createChannel", guildId, parentId: cat.id });
                    }}
                  >
                    <Icon name="plus" size={16} />
                  </button>
                )}
              </div>
              {kids
                .filter((c) => !isCollapsed || c.id === currentChannelId() || isUnread(c) || c.kind === "voice")
                .map((c) => (
                  <ChannelRow key={c.id} ch={c} />
                ))}
            </div>
          );
        })}
      </div>
    </>
  );
}

function ChannelRow({ ch }: { ch: Channel }) {
  const active = useStore((s) => currentChannelId(s) === ch.id);
  const unread = useStore((s) => ch.kind === "text" && isUnread(ch, s));
  const mentions = useStore((s) => s.mentions[ch.id] || 0);
  const manage = can(ch.guild_id, P.MANAGE_CHANNELS);
  const voiceStates = useStore((s) => s.voiceStates);
  const voiceUsers = ch.kind === "voice" ? Object.values(voiceStates).filter((v) => v.channel_id === ch.id) : [];
  const inThis = useVoice((v) => v.channelId === ch.id);
  const speaking = useVoice((v) => v.speaking);
  const users = useStore((s) => s.users);

  const onClick = () => {
    selectChannel(ch.guild_id!, ch.id);
    if (ch.kind === "voice" && !inThis) joinVoice(ch.id);
  };
  const menu = (e: React.MouseEvent) =>
    openMenu(e, [
      { label: "Mark As Read", onClick: () => ch.last_message_id && api(`/api/channels/${ch.id}/ack`, { body: { message_id: ch.last_message_id } }), disabled: ch.kind !== "text" },
      { label: "Edit Channel", onClick: () => openModal({ kind: "editChannel", channelId: ch.id }), disabled: !manage },
      {
        label: "Delete Channel",
        danger: true,
        disabled: !manage,
        onClick: () =>
          openModal({
            kind: "confirm",
            title: "Delete Channel",
            body: `Are you sure you want to delete ${ch.kind === "text" ? "#" : ""}${ch.name}? This can't be undone.`,
            danger: true,
            confirmLabel: "Delete Channel",
            onConfirm: () => api(`/api/channels/${ch.id}`, { method: "DELETE" }),
          }),
      },
      { separator: true, label: "" },
      { label: "Copy Channel ID", onClick: () => copy(ch.id, "ID copied") },
    ]);

  return (
    <>
      <div className={"channel" + (active ? " active" : "") + (unread ? " unread" : "")} onClick={onClick} onContextMenu={menu}>
        {unread && !active && <span className="unread-pip" />}
        <Icon name={ch.kind === "voice" ? "speaker" : "hash"} size={18} className="channel-icon" />
        <span className="ellipsis">{ch.name}</span>
        {mentions > 0 && <span className="badge inline">{mentions}</span>}
        {manage && (
          <button
            className="icon-btn tiny hover-only"
            title="Edit Channel"
            onClick={(e) => {
              e.stopPropagation();
              openModal({ kind: "editChannel", channelId: ch.id });
            }}
          >
            <Icon name="gear" size={14} />
          </button>
        )}
      </div>
      {voiceUsers.length > 0 && (
        <div className="voice-users">
          {voiceUsers.map((v) => (
            <div key={v.user_id} className="voice-user" onContextMenu={(e) => userMenu(e, v.user_id, ch.guild_id)}>
              <Avatar user={users[v.user_id]} size={22} speaking={inThis && speaking.includes(v.user_id)} />
              <span className="ellipsis">{memberName(ch.guild_id, users[v.user_id])}</span>
              {v.screen && <span className="live-tag">LIVE</span>}
              {v.video && <Icon name="video" size={14} />}
              {v.muted && <Icon name="micOff" size={14} className="red" />}
              {v.deafened && <Icon name="deaf" size={14} className="red" />}
            </div>
          ))}
        </div>
      )}
    </>
  );
}

export function userMenu(e: React.MouseEvent, userId: string, guildId: string | null) {
  const s = useStore.getState();
  const me = s.me!;
  const user = s.users[userId];
  const items: any[] = [
    { label: "Profile", onClick: () => openModal({ kind: "profile", userId, guildId }) },
  ];
  if (userId !== me.id) {
    items.push({
      label: "Message",
      onClick: async () => {
        try {
          const dm = user?.is_bot ? await api("/api/bot/dm", { method: "POST" }) : await api("/api/users/@me/channels", { body: { recipient_id: userId } });
          selectChannel("@me", dm.id);
        } catch (err: any) {
          toast(err.message, "error");
        }
      },
    });
  }
  const inVoice = useVoice.getState().channelId && s.voiceStates[userId]?.channel_id === useVoice.getState().channelId;
  if (inVoice && userId !== me.id) {
    const vol = Number(localStorage.getItem("parley.vol." + userId) || "1");
    items.push({
      label: "",
      render: () => <VolumeSlider userId={userId} initial={vol} />,
    });
  }
  if (guildId && userId !== me.id) {
    const g = s.guilds[guildId];
    items.push({ separator: true, label: "" });
    if (can(guildId, P.MANAGE_ROLES)) items.push({ label: "Roles…", onClick: () => openModal({ kind: "profile", userId, guildId }) });
    if (can(guildId, P.KICK) && g.owner_id !== userId)
      items.push({
        label: `Kick ${user?.display_name}`,
        danger: true,
        onClick: () =>
          openModal({ kind: "confirm", title: `Kick ${user?.display_name}`, body: "They can rejoin with a new invite.", danger: true, confirmLabel: "Kick", onConfirm: () => api(`/api/guilds/${guildId}/members/${userId}`, { method: "DELETE" }) }),
      });
    if (can(guildId, P.BAN) && g.owner_id !== userId)
      items.push({
        label: `Ban ${user?.display_name}`,
        danger: true,
        onClick: () =>
          openModal({ kind: "confirm", title: `Ban ${user?.display_name}`, body: "They will be removed and can't rejoin.", danger: true, confirmLabel: "Ban", onConfirm: () => api(`/api/guilds/${guildId}/bans/${userId}`, { method: "PUT", body: {} }) }),
      });
  }
  items.push({ separator: true, label: "" }, { label: "Copy User ID", onClick: () => copy(userId, "ID copied") });
  openMenu(e, items);
}

function VolumeSlider({ userId, initial }: { userId: string; initial: number }) {
  return (
    <label className="ctx-volume" onMouseDown={(e) => e.stopPropagation()}>
      User Volume
      <input
        type="range"
        min={0}
        max={2}
        step={0.05}
        defaultValue={initial}
        onChange={(e) => import("../voice").then((v) => v.setUserVolume(userId, Number(e.target.value)))}
      />
    </label>
  );
}

function DmList() {
  const channels = useStore((s) => s.channels);
  const me = useStore((s) => s.me);
  const bot = useStore((s) => s.config.bot);
  const selected = useStore((s) => currentChannelId(s));
  const dms = Object.values(channels)
    .filter((c) => c.kind === "dm")
    .sort((a, b) => (b.last_message_id || b.id).localeCompare(a.last_message_id || a.id));
  const hasBotDm = dms.some((d) => d.recipients?.some((r) => r.is_bot));
  return (
    <>
      <div className="sidebar-header static">Direct Messages</div>
      <div className="channel-scroll">
        {bot && !hasBotDm && (
          <div
            className="dm-row"
            onClick={async () => {
              const dm = await api("/api/bot/dm", { method: "POST" });
              selectChannel("@me", dm.id);
            }}
          >
            <div className="avatar-fallback round bot-av">
              <Icon name="bot" size={18} />
            </div>
            <span>Chat with {bot.name}</span>
          </div>
        )}
        {dms.map((dm) => {
          const other = dm.recipients?.find((r) => r.id !== me?.id) || dm.recipients?.[0];
          return <DmRow key={dm.id} ch={dm} active={selected === dm.id} other={other} />;
        })}
        {dms.length === 0 && <p className="muted small pad">Right-click anyone in a server and choose Message to start a conversation.</p>}
      </div>
    </>
  );
}

function DmRow({ ch, active, other }: { ch: Channel; active: boolean; other: any }) {
  const unread = useStore((s) => isUnread(ch, s));
  const mentions = useStore((s) => s.mentions[ch.id] || 0);
  const user = useStore((s) => (other ? s.users[other.id] || other : undefined));
  return (
    <div className={"dm-row" + (active ? " active" : "") + (unread ? " unread" : "")} onClick={() => selectChannel("@me", ch.id)} onContextMenu={(e) => user && userMenu(e, user.id, null)}>
      <Avatar user={user} size={32} status />
      <span className="ellipsis">{user?.display_name ?? "Unknown"}</span>
      {user?.is_bot && <BotTag />}
      {mentions > 0 && <span className="badge inline">{mentions}</span>}
    </div>
  );
}

function VoicePanel() {
  const v = useVoice();
  const channel = useStore((s) => (v.channelId ? s.channels[v.channelId] : undefined));
  const guild = useStore((s) => (channel?.guild_id ? s.guilds[channel.guild_id] : undefined));
  const recipient = useStore((s) => (channel?.kind === "dm" ? channel.recipients?.find((r) => r.id !== s.me?.id) : undefined));
  if (v.status === "idle" && !v.error) return null;
  if (v.status === "idle" && v.error) {
    return (
      <div className="voice-panel error">
        <span>{v.error}</span>
        <button className="icon-btn" onClick={() => useVoice.setState({ error: null })}>
          <Icon name="x" size={16} />
        </button>
      </div>
    );
  }
  const label = v.status === "connected" ? "Voice Connected" : v.status === "reconnecting" ? "Reconnecting…" : "Connecting…";
  return (
    <div className="voice-panel">
      <div className="voice-panel-top">
        <div className="voice-status" onClick={() => channel && selectChannel(channel.guild_id || "@me", channel.id)}>
          <div className={"voice-label " + v.status}>
            <Icon name="speaker" size={14} /> {label}
          </div>
          <div className="muted small ellipsis">{channel?.kind === "dm" ? `Call with ${recipient?.display_name ?? ""}` : `${channel?.name ?? ""} / ${guild?.name ?? ""}`}</div>
        </div>
        <button className="icon-btn" title="Disconnect" onClick={() => leaveVoice()}>
          <Icon name="phoneOff" size={20} />
        </button>
      </div>
      {v.error && <div className="voice-error small">{v.error}</div>}
      <div className="voice-panel-btns">
        <button className={"vbtn" + (v.camera ? " on" : "")} disabled={!v.canVideo} onClick={toggleCamera} title="Camera">
          <Icon name={v.camera ? "video" : "videoOff"} size={18} /> Video
        </button>
        <button
          className={"vbtn" + (v.screen ? " on" : "")}
          disabled={!v.canVideo}
          onClick={() => (v.screen ? stopScreenShare() : window.parleyNative ? openModal({ kind: "screenPicker" }) : import("../voice").then((m) => m.startScreenShare("", true, "1080p30")))}
          title="Share your screen"
        >
          <Icon name="screen" size={18} /> {v.screen ? "Stop" : "Screen"}
        </button>
      </div>
    </div>
  );
}

function UserPanel() {
  const me = useStore((s) => s.me);
  const v = useVoice();
  const statusMenu = (e: React.MouseEvent) =>
    openMenu(
      e,
      (["online", "idle", "dnd", "invisible"] as const).map((st) => ({
        label: { online: "🟢 Online", idle: "🌙 Idle", dnd: "⛔ Do Not Disturb", invisible: "⚪ Invisible" }[st],
        onClick: () => {
          localStorage.setItem("parley.status", st);
          sendGateway("presence", { status: st });
          useStore.setState((s) => ({ presences: { ...s.presences, [me!.id]: st === "invisible" ? "offline" : st } }));
        },
      })).concat([{ separator: true, label: "" } as any, { label: "Log Out", onClick: logout, danger: true } as any]),
    );
  if (!me) return null;
  return (
    <div className="user-panel">
      <div className="user-panel-me" onClick={statusMenu}>
        <Avatar user={me} size={32} status />
        <div className="user-panel-names">
          <div className="ellipsis bold">{me.display_name}</div>
          <div className="ellipsis muted small">@{me.username}</div>
        </div>
      </div>
      <button className={"icon-btn" + (v.muted ? " red" : "")} title={v.muted ? "Unmute (Ctrl+Shift+M)" : "Mute (Ctrl+Shift+M)"} onClick={toggleMute}>
        <Icon name={v.muted ? "micOff" : "mic"} size={18} />
      </button>
      <button className={"icon-btn" + (v.deafened ? " red" : "")} title={v.deafened ? "Undeafen (Ctrl+Shift+D)" : "Deafen (Ctrl+Shift+D)"} onClick={toggleDeafen}>
        <Icon name={v.deafened ? "deaf" : "headphones"} size={18} />
      </button>
      <button className="icon-btn" title="User Settings" onClick={() => openModal({ kind: "userSettings" })}>
        <Icon name="gear" size={18} />
      </button>
    </div>
  );
}
