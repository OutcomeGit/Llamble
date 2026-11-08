import { useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { api } from "../api";
import { loadBoard, loadHighlights } from "../notes";
import { notesForMe, selectChannel, useStore } from "../store";
import { openModal, toast } from "../ui";
import { joinVoice, useVoice } from "../voice";
import { Avatar, Icon } from "./common";
import { HighlightCard } from "./Highlights";
import { NoteCard, NoteComposer } from "./Notes";

/** What a server's board is called everywhere in the app (one place, so it's easy to rename). */
export { BOARD_NAME } from "../names";
import { BOARD_NAME } from "../names";

/** "@home" = everything across my servers; a guild id = that one server. */
type Scope = string;

/** Unread notes for me (the badge on the llama logo). */
export function useUnreadNotes(): number {
  return useStore((s) => notesForMe(s).filter((n) => !n.read).length);
}

type BoardStyle = "cork" | "chalkboard" | "plain";
const STYLES: [BoardStyle, string][] = [
  ["cork", "Cork"],
  ["chalkboard", "Chalkboard"],
  ["plain", "Plain"],
];

function savedStyle(): BoardStyle {
  try {
    const v = localStorage.getItem("llamble.homeBoard");
    if (v === "cork" || v === "chalkboard" || v === "plain") return v;
  } catch {}
  return "cork";
}

function greeting(): string {
  const h = new Date().getHours();
  return h < 5 ? "Up late" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

/** The board: Home (scope "@home", all my servers) or one server's board (scope = guild id). */
export function Board({ scope }: { scope: Scope }) {
  const home = scope === "@home";
  const [style, setStyle] = useState<BoardStyle>(savedStyle);
  const name = useStore((s) => s.me?.display_name || "");
  const guild = useStore((s) => (home ? undefined : s.guilds[scope]));
  const section = useStore((s) => s.boardSection);
  const scroller = useRef<HTMLDivElement>(null);
  // what the board shows: everything, or just one kind (News joins this list when it exists)
  const [show, setShow] = useState<"all" | "notes" | "highlights">("all");
  const pick = (v: BoardStyle) => {
    setStyle(v);
    try {
      localStorage.setItem("llamble.homeBoard", v);
    } catch {}
  };
  // a server's board loads its notes and highlights when it opens
  useEffect(() => {
    if (home) return;
    loadBoard(scope).catch(() => {});
    loadHighlights(scope).catch(() => {});
  }, [scope, home]);
  // a different board starts on "Everything" (the effect below may then narrow it)
  useEffect(() => setShow("all"), [scope]);
  // openGuildView(g, "notes" | "highlights") scrolls to that section
  useEffect(() => {
    if (!section) return;
    if (section === "notes" || section === "highlights") setShow(section);
    const t = window.setTimeout(() => {
      scroller.current?.querySelector(`[data-hb-section="${section}"]`)?.scrollIntoView({ block: "start", behavior: "smooth" });
      useStore.setState({ boardSection: null });
    }, 250);
    return () => clearTimeout(t);
  }, [section]);
  return (
    <div ref={scroller} className={"hb-board hb-" + style}>
      <div className="hb-frame">
        <header className="hb-header">
          <div>
            <h1 className="hb-title">{home ? "Home" : `${guild?.name ?? ""} · ${BOARD_NAME}`}</h1>
            <div className="hb-greet">
              {greeting()}
              {name ? `, ${name}` : ""}
            </div>
          </div>
          <div className="hb-style" role="radiogroup" aria-label="Board style">
            {STYLES.map(([v, label]) => (
              <button key={v} role="radio" aria-checked={style === v} className={"hb-style-btn" + (style === v ? " on" : "")} onClick={() => pick(v)}>
                {label}
              </button>
            ))}
          </div>
        </header>

        <div className="hb-filter" role="tablist" aria-label="Show">
          {(
            [
              ["all", "Everything"],
              ["notes", "Notes"],
              ["highlights", "Highlights"],
            ] as const
          ).map(([v, label]) => (
            <button key={v} role="tab" aria-selected={show === v} className={"hb-filter-btn" + (show === v ? " on" : "")} onClick={() => setShow(v)}>
              {label}
            </button>
          ))}
        </div>

        {show === "all" && (
          <div className="hb-top">
            <RightNow scope={scope} />
            {home && <ChatWithBot />}
          </div>
        )}

        {/* reserved for News (Llamble, instance and server news) */}
        {show === "all" && <div className="hb-news" />}

        {show !== "highlights" && (home ? <ForYou /> : <ServerNotes guildId={scope} />)}
        {show !== "notes" && <Highlights scope={scope} />}
      </div>
    </div>
  );
}

/** Small filter chips, shown when there's more than one server. */
function ServerChips({ ids, only, setOnly }: { ids: string[]; only: string | null; setOnly: (g: string | null) => void }) {
  const guilds = useStore((s) => s.guilds);
  if (ids.length < 2) return null;
  return (
    <div className="hb-chips">
      <button className={"hb-chip" + (!only ? " on" : "")} onClick={() => setOnly(null)}>
        All
      </button>
      {ids.map((g) => (
        <button key={g} className={"hb-chip" + (only === g ? " on" : "")} onClick={() => setOnly(only === g ? null : g)}>
          {guilds[g]?.name}
        </button>
      ))}
    </div>
  );
}

function ForYou() {
  // unread first, then newest (store objects are stable, so useShallow is enough here)
  const notes = useStore(useShallow((s) => notesForMe(s).sort((a, b) => Number(a.read) - Number(b.read) || b.created_at - a.created_at)));
  const guilds = useStore((s) => s.guilds);
  const [only, setOnly] = useState<string | null>(null);
  const servers = useMemo(() => [...new Set(notes.map((n) => n.guild_id))], [notes]);
  const list = only ? notes.filter((n) => n.guild_id === only) : notes;
  const unread = notes.filter((n) => !n.read).length;
  return (
    <section className="hb-section" data-hb-section="notes">
      <h2 className="hb-label">
        Notes for you{unread ? <span className="hb-count">{unread} new</span> : null}
      </h2>
      <ServerChips ids={servers} only={only} setOnly={setOnly} />
      <div className="hb-notes">
        {list.map((n) => (
          <NoteCard key={n.id} note={n} onHome pinned serverName={guilds[n.guild_id]?.name} />
        ))}
        {!list.length && (
          <div className="hb-empty note-card note-yellow hb-pinned">
            <span className="hb-pin hb-pin-red" />
            <div className="note-body">No notes for you right now. When someone leaves you one on a server's 📌 Notes board, it gets pinned here.</div>
          </div>
        )}
      </div>
    </section>
  );
}

/** A server's notes: mine-to-read pinned first (until dismissed), then the rest; plus "New note". */
function ServerNotes({ guildId }: { guildId: string }) {
  const me = useStore((s) => s.me?.id);
  const notes = useStore(
    useShallow((s) => {
      const now = Date.now();
      const forMe = (n: (typeof s.notes)[string]) => n.author.id !== me && !n.dismissed && (n.audience === "everyone" || n.to.includes(me || ""));
      return Object.values(s.notes)
        .filter((n) => n.guild_id === guildId && (!n.expires_at || n.expires_at > now))
        .sort(
          (a, b) =>
            Number(!forMe(a)) - Number(!forMe(b)) || Number(a.read) - Number(b.read) || Number(a.dismissed) - Number(b.dismissed) || b.created_at - a.created_at,
        );
    }),
  );
  const [composing, setComposing] = useState(false);
  const unread = notes.filter((n) => n.author.id !== me && !n.read && !n.dismissed).length;
  return (
    <section className="hb-section" data-hb-section="notes">
      <div className="hb-section-head">
        <h2 className="hb-label">
          Notes{unread ? <span className="hb-count">{unread} new</span> : null}
        </h2>
        <button className="hb-new" onClick={() => setComposing((v) => !v)}>
          {composing ? "Close" : "+ New note"}
        </button>
      </div>
      {composing && (
        <div className="hb-composer">
          <NoteComposer guildId={guildId} onPosted={() => setComposing(false)} />
        </div>
      )}
      <div className="hb-notes">
        {notes.map((n) => (
          <NoteCard key={n.id} note={n} pinned />
        ))}
        {!notes.length && (
          <div className="hb-empty note-card note-yellow hb-pinned">
            <span className="hb-pin hb-pin-red" />
            <div className="note-body">No notes here yet. Pin the first one with “+ New note”.</div>
          </div>
        )}
      </div>
    </section>
  );
}

function Highlights({ scope }: { scope: Scope }) {
  const home = scope === "@home";
  const all = useStore(
    useShallow((s) =>
      Object.values(s.highlights)
        .filter((h) => (home ? !!s.guilds[h.guild_id] : h.guild_id === scope))
        .sort((a, b) => b.created_at - a.created_at)
        .slice(0, home ? 30 : 500),
    ),
  );
  const [only, setOnly] = useState<string | null>(null);
  const [more, setMore] = useState(!home);
  const servers = useMemo(() => [...new Set(all.map((h) => h.guild_id))], [all]);
  const list = only ? all.filter((h) => h.guild_id === only) : all;
  const older = async () => {
    try {
      const l = await loadHighlights(scope, all[all.length - 1]?.id);
      setMore(l.length >= 30);
    } catch (e: any) {
      toast(e.message, "error");
    }
  };
  return (
    <section className="hb-section" data-hb-section="highlights">
      <h2 className="hb-label">Highlights</h2>
      {home && <ServerChips ids={servers} only={only} setOnly={setOnly} />}
      <div className="hb-photos">
        {list.map((h) => (
          <HighlightCard key={h.id} h={h} showServer={home} polaroid />
        ))}
        {!list.length && (
          <div className="hb-empty hl-card hb-polaroid">
            <span className="hb-tape" />
            <div className="hb-empty-photo">✨</div>
            <div className="hl-info">Nothing highlighted yet. Pick a great moment from any message's ⋯ menu → Add to Highlights.</div>
          </div>
        )}
      </div>
      {more && all.length >= 30 && (
        <button className="hb-new hb-older" onClick={older}>
          Load older
        </button>
      )}
    </section>
  );
}

function RightNow({ scope }: { scope: Scope }) {
  const home = scope === "@home";
  const me = useStore((s) => s.me?.id);
  // people who share a server with me and are online (an array of ids: safe with useShallow)
  const online = useStore(
    useShallow((s) => {
      const ids = new Set<string>();
      for (const g of home ? s.guildOrder : [scope]) for (const uid of Object.keys(s.members[g] || {})) ids.add(uid);
      return [...ids]
        .filter((u) => u !== me && s.presences[u] && s.presences[u] !== "offline" && !s.users[u]?.is_bot)
        .sort((a, b) => (s.users[a]?.display_name || "").localeCompare(s.users[b]?.display_name || ""));
    }),
  );
  // raw store objects (stable); the call list is built only when they change
  // (building new objects inside a selector makes React re-render forever, error #185)
  const voiceStates = useStore((s) => s.voiceStates);
  const users = useStore((s) => s.users);
  const channels = useStore((s) => s.channels);
  const calls = useMemo(() => {
    const by: Record<string, string[]> = {};
    for (const v of Object.values(voiceStates)) {
      const g = channels[v.channel_id]?.guild_id;
      if (g && (home || g === scope)) (by[v.channel_id] ||= []).push(v.user_id);
    }
    return Object.entries(by).map(([cid, inIt]) => ({ cid, users: inIt }));
  }, [voiceStates, channels, home, scope]);
  const guilds = useStore((s) => s.guilds);
  const games = useStore((s) => s.games);
  const inCall = useVoice((v) => v.channelId);
  const profile = (userId: string) => openModal({ kind: "profile", userId, guildId: null });

  return (
    <section className="hb-index">
      <h2 className="hb-index-title">Right now</h2>
      {calls.map(({ cid, users: inIt }) => {
        const ch = channels[cid];
        if (!ch) return null;
        return (
          <div key={cid} className="hb-call">
            <Icon name="speaker" size={14} />
            <b className="ellipsis">{ch.name}</b>
            {home && <span className="hb-muted ellipsis">{guilds[ch.guild_id!]?.name}</span>}
            <span className="hb-call-people">
              {inIt.map((u) => (
                <span key={u} title={users[u]?.display_name}>
                  <Avatar user={users[u]} size={20} />
                </span>
              ))}
            </span>
            {inCall === cid ? (
              <span className="hb-in">You're in</span>
            ) : (
              <button
                className="hb-join"
                onClick={() => {
                  selectChannel(ch.guild_id!, cid);
                  joinVoice(cid);
                }}
              >
                Join
              </button>
            )}
          </div>
        );
      })}
      <div className="hb-people">
        {online.map((u) => (
          <button key={u} className="hb-person" onClick={() => profile(u)} title={users[u]?.display_name}>
            <Avatar user={users[u]} size={30} status />
            <span className="hb-person-text">
              <span className="ellipsis">{users[u]?.display_name}</span>
              {games[u] && <span className="hb-playing ellipsis">🎮 {games[u]}</span>}
            </span>
          </button>
        ))}
      </div>
      {!online.length && !calls.length && <div className="hb-muted">Nobody else is online right now.</div>}
    </section>
  );
}

function ChatWithBot() {
  const bot = useStore((s) => s.config.bot);
  if (!bot) return null;
  return (
    <button
      className="hb-bot"
      onClick={async () => {
        try {
          const dm = await api("/api/bot/dm", { method: "POST" });
          selectChannel("@me", dm.id);
        } catch (e: any) {
          toast(e.message, "error");
        }
      }}
    >
      <img src="./icon-192.png" alt="" draggable={false} />
      <span>
        <b>Chat with {bot.name}</b>
        <span className="hb-muted">Ask anything, draw a picture, check the weather</span>
      </span>
    </button>
  );
}
