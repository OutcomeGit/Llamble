import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api } from "../api";
import { can, memberName, setMessages, useStore } from "../store";
import { P, type Channel, type Message } from "../types";
import { useUI } from "../ui";
import { Composer, type ComposerHandle } from "./Composer";
import { Avatar, BotTag, Icon, formatDay } from "./common";
import { MessageItem } from "./MessageItem";
import { joinVoice, useVoice } from "../voice";

const EMPTY: Message[] = [];

export function ChatView({ channel }: { channel: Channel }) {
  const me = useStore((s) => s.me)!;
  const other = useStore((s) => (channel.kind === "dm" ? channel.recipients?.find((r) => r.id !== me.id) : undefined));
  const otherUser = useStore((s) => (other ? s.users[other.id] || other : undefined));
  const memberListOpen = useStore((s) => s.memberListOpen);
  const [dragging, setDragging] = useState(false);
  const composer = useRef<ComposerHandle>(null);
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<Message[] | null>(null);
  const inCall = useVoice((v) => v.channelId === channel.id);

  const runSearch = async (q: string) => {
    if (q.trim().length < 2) return setResults(null);
    setResults(await api(`/api/channels/${channel.id}/search?q=${encodeURIComponent(q)}`));
  };

  const title = channel.kind === "dm" ? otherUser?.display_name ?? "Direct Message" : channel.name;

  return (
    <div
      className="chat"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        if (e.dataTransfer.files.length) composer.current?.addFiles(Array.from(e.dataTransfer.files));
      }}
    >
      <header className="chat-header">
        {channel.kind === "dm" ? <Avatar user={otherUser} size={24} status /> : <Icon name="hash" size={22} className="muted" />}
        <span className="chat-title">{title}</span>
        {otherUser?.is_bot && <BotTag />}
        {channel.topic && <span className="chat-topic ellipsis">{channel.topic}</span>}
        <div className="grow" />
        {channel.kind === "dm" && !otherUser?.is_bot && (
          <button
            className={"icon-btn" + (inCall ? " green" : "")}
            title="Start voice call"
            onClick={() => {
              joinVoice(channel.id);
              api(`/api/channels/${channel.id}/ring`, { method: "POST" }).catch(() => {});
            }}
          >
            <Icon name="speaker" size={20} />
          </button>
        )}
        {channel.guild_id && (
          <button className={"icon-btn" + (memberListOpen ? " on" : "")} title="Member list" onClick={() => useStore.setState({ memberListOpen: !memberListOpen })}>
            <Icon name="users" size={20} />
          </button>
        )}
        <div className="search-box">
          <input
            placeholder="Search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") runSearch(search);
              if (e.key === "Escape") {
                setSearch("");
                setResults(null);
              }
            }}
          />
          <Icon name="search" size={14} />
        </div>
      </header>
      <div className="chat-body">
        <div className="chat-col">
          <MessageList channel={channel} />
          <TypingBar channelId={channel.id} guildId={channel.guild_id} />
          <Composer ref={composer} channel={channel} placeholder={channel.kind === "dm" ? `Message @${title}` : `Message #${channel.name}`} />
        </div>
        {results && (
          <div className="search-results">
            <div className="search-results-head">
              {results.length} results
              <button className="icon-btn" onClick={() => setResults(null)}>
                <Icon name="x" size={16} />
              </button>
            </div>
            {results.map((m) => (
              <div key={m.id} className="search-hit" onClick={() => useUI.setState({ jumpTo: m.id })}>
                <MessageItem msg={m} guildId={channel.guild_id} compact={false} readOnly />
              </div>
            ))}
          </div>
        )}
      </div>
      {dragging && (
        <div className="drop-overlay">
          <div>
            <Icon name="attach" size={40} />
            <h3>Upload to {channel.kind === "dm" ? title : "#" + channel.name}</h3>
          </div>
        </div>
      )}
    </div>
  );
}

function TypingBar({ channelId, guildId }: { channelId: string; guildId: string | null }) {
  const typing = useStore((s) => s.typing[channelId]);
  const users = useStore((s) => s.users);
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((x) => x + 1), 2000);
    return () => clearInterval(t);
  }, []);
  const now = Date.now();
  const ids = Object.entries(typing || {})
    .filter(([, exp]) => exp > now)
    .map(([id]) => id);
  if (!ids.length) return <div className="typing-bar" />;
  const names = ids.map((id) => memberName(guildId, users[id]));
  const text = names.length === 1 ? `${names[0]} is typing…` : names.length === 2 ? `${names[0]} and ${names[1]} are typing…` : "Several people are typing…";
  return (
    <div className="typing-bar">
      <span className="dots">
        <i />
        <i />
        <i />
      </span>
      {text}
    </div>
  );
}

function shouldGroup(prev: Message | undefined, m: Message) {
  return !!prev && prev.author.id === m.author.id && !m.reply_to && m.created_at - prev.created_at < 7 * 60 * 1000 && new Date(prev.created_at).toDateString() === new Date(m.created_at).toDateString();
}

function MessageList({ channel }: { channel: Channel }) {
  const msgs = useStore((s) => s.messages[channel.id]) || EMPTY;
  const hasMore = useStore((s) => s.hasMore[channel.id] ?? true);
  const loaded = useStore((s) => !!s.messages[channel.id]);
  const scroller = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const loadingOlder = useRef(false);
  const prevHeight = useRef<number | null>(null);
  const [firstUnread] = useState(() => useStore.getState().readStates[channel.id] || null);
  const jumpTo = useUI((s) => s.jumpTo);

  const load = useCallback(
    async (before?: string) => {
      const q = before ? `?before=${before}&limit=50` : "?limit=50";
      const page: Message[] = await api(`/api/channels/${channel.id}/messages${q}`);
      setMessages(channel.id, page.reverse(), page.length === 50, !before);
    },
    [channel.id],
  );

  useEffect(() => {
    if (!loaded) load().catch(() => {});
  }, [loaded, load]);

  // acknowledge (mark read) while viewing
  const lastId = msgs.length ? msgs[msgs.length - 1].id : null;
  useEffect(() => {
    if (!lastId || lastId.startsWith("pending")) return;
    const read = useStore.getState().readStates[channel.id];
    if (read && read >= lastId) return;
    const t = setTimeout(() => {
      if (document.hasFocus()) api(`/api/channels/${channel.id}/ack`, { body: { message_id: lastId } }).catch(() => {});
    }, 400);
    return () => clearTimeout(t);
  }, [lastId, channel.id]);
  useEffect(() => {
    const f = () => {
      const s = useStore.getState();
      const l = s.messages[channel.id]?.at(-1);
      if (l && !l.pending && (!s.readStates[channel.id] || s.readStates[channel.id] < l.id)) api(`/api/channels/${channel.id}/ack`, { body: { message_id: l.id } }).catch(() => {});
    };
    window.addEventListener("focus", f);
    return () => window.removeEventListener("focus", f);
  }, [channel.id]);

  // keep pinned to bottom, preserve position when prepending
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (prevHeight.current !== null) {
      el.scrollTop = el.scrollHeight - prevHeight.current;
      prevHeight.current = null;
      loadingOlder.current = false;
    } else if (atBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [msgs]);

  useEffect(() => {
    const el = scroller.current;
    const content = inner.current;
    if (!el || !content) return;
    const ro = new ResizeObserver(() => {
      if (atBottom.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!jumpTo) return;
    const node = document.getElementById("msg-" + jumpTo);
    if (node) {
      node.scrollIntoView({ block: "center" });
      node.classList.add("flash");
      setTimeout(() => node.classList.remove("flash"), 1500);
    }
    useUI.setState({ jumpTo: null });
  }, [jumpTo]);

  const onScroll = () => {
    const el = scroller.current!;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    if (el.scrollTop < 300 && hasMore && !loadingOlder.current && msgs.length) {
      loadingOlder.current = true;
      prevHeight.current = el.scrollHeight;
      const oldest = msgs.find((m) => !m.pending);
      load(oldest?.id).catch(() => {
        loadingOlder.current = false;
        prevHeight.current = null;
      });
    }
  };

  const canSend = can(channel.guild_id, P.SEND);
  let lastDay = "";
  let unreadShown = false;
  return (
    <div className="messages" ref={scroller} onScroll={onScroll}>
      <div ref={inner} className="messages-inner">
        {!hasMore && <ChannelStart channel={channel} />}
        {hasMore && loaded && <div className="loading-more">Loading…</div>}
        {msgs.map((m, i) => {
          const day = new Date(m.created_at).toDateString();
          const showDay = day !== lastDay;
          lastDay = day;
          const showUnread = !unreadShown && firstUnread && !m.pending && m.id > firstUnread && m.author.id !== useStore.getState().me?.id;
          if (showUnread) unreadShown = true;
          return (
            <div key={m.nonce && m.pending ? "p" + m.nonce : m.id}>
              {showDay && (
                <div className="day-sep">
                  <span>{formatDay(m.created_at)}</span>
                </div>
              )}
              {showUnread && (
                <div className="unread-sep">
                  <span>NEW</span>
                </div>
              )}
              <MessageItem msg={m} guildId={channel.guild_id} compact={!showDay && !showUnread && shouldGroup(msgs[i - 1], m)} />
            </div>
          );
        })}
        {!canSend && <div className="muted small pad">You can read this channel but can't send messages here.</div>}
      </div>
    </div>
  );
}

function ChannelStart({ channel }: { channel: Channel }) {
  const me = useStore((s) => s.me);
  const other = channel.recipients?.find((r) => r.id !== me?.id);
  const bot = useStore((s) => s.config.bot);
  return (
    <div className="channel-start">
      {channel.kind === "dm" ? (
        <>
          <Avatar user={other} size={80} />
          <h1>{other?.display_name}</h1>
          <p className="muted">
            This is the beginning of your direct message history with <b>{other?.display_name}</b>.
            {other?.is_bot && " It's an AI — just type to chat. Replies are generated with llama.cpp on a lent GPU or the server."}
          </p>
        </>
      ) : (
        <>
          <div className="channel-start-icon">
            <Icon name="hash" size={40} />
          </div>
          <h1>Welcome to #{channel.name}!</h1>
          <p className="muted">This is the start of the #{channel.name} channel.{bot ? ` Mention @${bot.name} to ask the AI (if it's enabled here).` : ""}</p>
        </>
      )}
    </div>
  );
}
