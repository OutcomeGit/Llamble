import { useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { api } from "../api";
import { notesForMe, openGuildView, selectChannel, useStore } from "../store";
import type { Note } from "../types";
import { openModal, toast } from "../ui";
import { joinVoice, useVoice } from "../voice";
import { Avatar, GuildIcon, Icon } from "./common";
import { HighlightCard } from "./Highlights";
import { NoteCard } from "./Notes";

/** Unread notes for me (the badge on the llama logo). */
export function useUnreadNotes(): number {
  return useStore((s) => notesForMe(s).filter((n) => !n.read).length);
}

/** Home: notes for you, who's around right now, recent highlights. */
export function HomeView() {
  return (
    <div className="home">
      <div className="home-main">
        <ForYou />
        <Highlights />
      </div>
      <div className="home-side">
        <RightNow />
        <ChatWithBot />
      </div>
    </div>
  );
}

function ForYou() {
  const notes = useStore(useShallow((s) => notesForMe(s).sort((a, b) => b.created_at - a.created_at)));
  const guilds = useStore((s) => s.guilds);
  const order = useStore((s) => s.guildOrder);
  const groups = useMemo(() => {
    const by: Record<string, Note[]> = {};
    for (const n of notes) (by[n.guild_id] ||= []).push(n);
    return order.filter((g) => by[g]).map((g) => [g, by[g]] as const);
  }, [notes, order]);
  return (
    <section className="home-section">
      <h2>For you</h2>
      {!groups.length && <p className="muted">No notes for you right now. Notes people leave you on any server's 📌 Notes board show up here.</p>}
      {groups.map(([gid, list]) => (
        <div key={gid} className="home-group">
          <button className="home-group-head" onClick={() => openGuildView(gid, "notes")} title="Open this server's Notes board">
            <span className="hl-guild-icon">
              <GuildIcon name={guilds[gid]?.name || "?"} iconId={guilds[gid]?.icon_file_id ?? null} size={20} />
            </span>
            <b>{guilds[gid]?.name}</b>
            <span className="muted small">{list.length} note{list.length > 1 ? "s" : ""}</span>
          </button>
          <div className="note-grid">
            {list.map((n) => (
              <NoteCard key={n.id} note={n} onHome />
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}

function Highlights() {
  const all = useStore(
    useShallow((s) =>
      Object.values(s.highlights)
        .filter((h) => s.guilds[h.guild_id])
        .sort((a, b) => b.created_at - a.created_at)
        .slice(0, 30),
    ),
  );
  const guilds = useStore((s) => s.guilds);
  const [only, setOnly] = useState<string | null>(null);
  const servers = [...new Set(all.map((h) => h.guild_id))];
  const list = only ? all.filter((h) => h.guild_id === only) : all;
  return (
    <section className="home-section">
      <h2>Highlights</h2>
      {servers.length > 1 && (
        <div className="chips">
          <button className={"chip" + (!only ? " on" : "")} onClick={() => setOnly(null)}>
            All
          </button>
          {servers.map((g) => (
            <button key={g} className={"chip" + (only === g ? " on" : "")} onClick={() => setOnly(g)}>
              {guilds[g]?.name}
            </button>
          ))}
        </div>
      )}
      {!list.length && <p className="muted">Nothing highlighted yet. Add a great moment from any message's ⋯ menu → Add to Highlights.</p>}
      <div className="hl-grid">
        {list.map((h) => (
          <HighlightCard key={h.id} h={h} showServer />
        ))}
      </div>
    </section>
  );
}

function RightNow() {
  const me = useStore((s) => s.me?.id);
  // people who share a server with me and are online
  const online = useStore(
    useShallow((s) => {
      const ids = new Set<string>();
      for (const g of s.guildOrder) for (const uid of Object.keys(s.members[g] || {})) ids.add(uid);
      return [...ids]
        .filter((u) => u !== me && s.presences[u] && s.presences[u] !== "offline" && !s.users[u]?.is_bot)
        .sort((a, b) => (s.users[a]?.display_name || "").localeCompare(s.users[b]?.display_name || ""));
    }),
  );
  // select the raw store objects (stable) and build the call list only when they change;
  // building new objects inside the selector makes React re-render forever (error #185)
  const voiceStates = useStore((s) => s.voiceStates);
  const users = useStore((s) => s.users);
  const channels = useStore((s) => s.channels);
  const calls = useMemo(() => {
    const by: Record<string, string[]> = {};
    for (const v of Object.values(voiceStates)) if (channels[v.channel_id]?.guild_id) (by[v.channel_id] ||= []).push(v.user_id);
    return Object.entries(by).map(([cid, users]) => ({ cid, users }));
  }, [voiceStates, channels]);
  const guilds = useStore((s) => s.guilds);
  const games = useStore((s) => s.games);
  const inCall = useVoice((v) => v.channelId);
  const profile = (userId: string) => openModal({ kind: "profile", userId, guildId: null });

  return (
    <section className="home-section">
      <h2>Right now</h2>
      {calls.length > 0 && (
        <div className="home-calls">
          {calls.map(({ cid, users: inIt }) => {
            const ch = channels[cid];
            return (
              <button
                key={cid}
                className={"home-call" + (inCall === cid ? " on" : "")}
                title={inCall === cid ? "You're in this call" : "Join this call"}
                onClick={() => {
                  selectChannel(ch.guild_id!, cid);
                  if (inCall !== cid) joinVoice(cid);
                }}
              >
                <div className="row gap center-v">
                  <Icon name="speaker" size={14} />
                  <b className="ellipsis">{ch.name}</b>
                  <span className="muted small ellipsis">{guilds[ch.guild_id!]?.name}</span>
                </div>
                <div className="home-call-people">
                  {inIt.map((u) => (
                    <span key={u} title={users[u]?.display_name}>
                      <Avatar user={users[u]} size={22} />
                    </span>
                  ))}
                </div>
              </button>
            );
          })}
        </div>
      )}
      {!online.length && !calls.length && <p className="muted small">Nobody else is online right now.</p>}
      <div className="home-online">
        {online.map((u) => (
          <button key={u} className="home-person" onClick={() => profile(u)}>
            <Avatar user={users[u]} size={28} status />
            <span className="member-text">
              <span className="ellipsis">{users[u]?.display_name}</span>
              {games[u] && (
                <span className="playing ellipsis">
                  Playing <b className="ellipsis">{games[u]}</b>
                </span>
              )}
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}

function ChatWithBot() {
  const bot = useStore((s) => s.config.bot);
  if (!bot) return null;
  return (
    <section className="home-section home-bot">
      <button
        className="btn"
        onClick={async () => {
          try {
            const dm = await api("/api/bot/dm", { method: "POST" });
            selectChannel("@me", dm.id);
          } catch (e: any) {
            toast(e.message, "error");
          }
        }}
      >
        <Icon name="bot" size={16} /> Chat with {bot.name}
      </button>
    </section>
  );
}

/** Sidebar while Home is open: each server's Notes and Highlights. */
export function HomeSidebar() {
  const order = useStore((s) => s.guildOrder);
  const guilds = useStore((s) => s.guilds);
  const unread = useStore(
    useShallow((s) => {
      const by: Record<string, number> = {};
      for (const n of notesForMe(s)) if (!n.read) by[n.guild_id] = (by[n.guild_id] || 0) + 1;
      return by;
    }),
  );
  return (
    <>
      <div className="sidebar-header static">
        <span className="ellipsis">Home</span>
      </div>
      <div className="channel-scroll">
        {order.map((g) =>
          guilds[g] ? (
            <div key={g} className="home-side-server">
              <div className="category-head static" style={{ marginTop: 10 }}>
                <span className="ellipsis">{guilds[g].name}</span>
              </div>
              <div className="channel" onClick={() => openGuildView(g, "notes")}>
                <span className="channel-emoji">📌</span>
                <span className="ellipsis">Notes</span>
                {unread[g] ? <span className="badge inline">{unread[g]}</span> : null}
              </div>
              <div className="channel" onClick={() => openGuildView(g, "highlights")}>
                <span className="channel-emoji">✨</span>
                <span className="ellipsis">Highlights</span>
              </div>
            </div>
          ) : null,
        )}
      </div>
    </>
  );
}
