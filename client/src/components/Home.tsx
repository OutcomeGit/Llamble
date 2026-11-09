import { useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { api } from "../api";
import { highlightType, loadBoard, loadGuildNews, loadHighlights, loadInstanceNews } from "../notes";
import { notesForMe, selectChannel, useStore } from "../store";
import { openModal, toast } from "../ui";
import { joinVoice, useVoice } from "../voice";
import { Avatar, Icon } from "./common";
import { HighlightCard } from "./Highlights";
import { NoteCard, NoteComposer } from "./Notes";
import { FeaturedLlambleNews, NewsSection } from "./News";
import { BoardCustomize, HIGHLIGHT_TYPES } from "./BoardCustomize";
import type { HighlightType } from "../types";

/** What a server's board is called everywhere in the app (one place, so it's easy to rename). */
export { BOARD_NAME } from "../names";
import { BOARD_NAME } from "../names";
import { fmtTime, fmtWhen, nextAlarm, useAlarms } from "../alarms";

/** "@home" = everything across my servers; a guild id = that one server. */
type Scope = string;

/** Unread notes for me (the badge on the llama logo). */
export function useUnreadNotes(): number {
  return useStore((s) => notesForMe(s).filter((n) => !n.read).length);
}

// Board looks. Felt boards borrow cork's paper labels and only swap the color.
const STYLES = [
  { id: "cork", label: "Cork", swatch: "#b9895a", cls: "hb-cork" },
  { id: "spit", label: "Llama green", swatch: "#7fc458", cls: "hb-cork hb-felt hb-felt-spit" },
  { id: "sky", label: "Sky", swatch: "#8ec9f0", cls: "hb-cork hb-felt hb-felt-sky" },
  { id: "lavender", label: "Lavender", swatch: "#b7a2ea", cls: "hb-cork hb-felt hb-felt-lavender" },
  { id: "sunset", label: "Sunset", swatch: "#f2a25b", cls: "hb-cork hb-felt hb-felt-sunset" },
  { id: "midnight", label: "Midnight", swatch: "#22335c", cls: "hb-cork hb-felt hb-felt-midnight" },
  { id: "chalkboard", label: "Chalkboard", swatch: "#233229", cls: "hb-chalkboard" },
  { id: "plain", label: "Plain", swatch: "var(--bg-2, #2b2d31)", cls: "hb-plain" },
] as const;
type BoardStyle = (typeof STYLES)[number]["id"];

function savedStyle(): BoardStyle {
  try {
    const v = localStorage.getItem("llamble.homeBoard");
    if (STYLES.some((x) => x.id === v)) return v as BoardStyle;
  } catch {}
  return "cork";
}

const FILTER_TITLES: Record<string, string> = {
  notes: "Notes",
  highlights: "Highlights",
  news: "News",
};

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
  // what the board shows: picked in the left column (Board / Notes / Highlights)
  const show = useStore((s) => s.boardFilter[scope] ?? "all");
  const [customizing, setCustomizing] = useState(false);
  const pick = (v: BoardStyle) => {
    setStyle(v);
    try {
      localStorage.setItem("llamble.homeBoard", v);
    } catch {}
  };
  // a server's board loads its notes and highlights when it opens
  useEffect(() => {
    if (home) {
      loadInstanceNews().catch(() => {});
      return;
    }
    loadBoard(scope).catch(() => {});
    loadHighlights(scope).catch(() => {});
    loadGuildNews(scope).catch(() => {});
  }, [scope, home]);
  // openGuildView(g, "notes" | "highlights") scrolls to that section
  useEffect(() => {
    if (!section) return;
    const t = window.setTimeout(() => {
      scroller.current?.querySelector(`[data-hb-section="${section}"]`)?.scrollIntoView({ block: "start", behavior: "smooth" });
      useStore.setState({ boardSection: null });
    }, 250);
    return () => clearTimeout(t);
  }, [section]);
  return (
    <div ref={scroller} className={"hb-board " + (STYLES.find((x) => x.id === style)?.cls ?? "hb-cork")}>
      <div className="hb-frame">
        <header className="hb-header">
          <div>
            <h1 className="hb-title">
              {home ? "Home" : `${guild?.name ?? ""} · ${BOARD_NAME}`}
              {show !== "all" && <span className="hb-title-sub"> · {FILTER_TITLES[show]}</span>}
            </h1>
            <div className="hb-greet">
              {greeting()}
              {name ? `, ${name}` : ""}
            </div>
          </div>
          <div className="hb-header-tools">
          {home && (
            <button className="hb-gear" title="Customize what's on your board" onClick={() => setCustomizing(true)}>
              ⚙ Customize
            </button>
          )}
          <div className="hb-style" role="radiogroup" aria-label="Board color">
            {STYLES.map((x) => (
              <button
                key={x.id}
                role="radio"
                aria-checked={style === x.id}
                aria-label={x.label}
                title={x.label}
                className={"hb-swatch" + (style === x.id ? " on" : "")}
                style={{ background: x.swatch }}
                onClick={() => pick(x.id)}
              />
            ))}
          </div>
          </div>
        </header>
        {customizing && <BoardCustomize onClose={() => setCustomizing(false)} />}

        {show === "all" && (
          <div className="hb-top">
            <RightNow scope={scope} />
            {home && <ChatWithBot />}
          </div>
        )}

        {home && show === "all" && <FeaturedLlambleNews />}
        {(show === "all" || show === "news") && (
          <div className="hb-news">
            <NewsSection scope={scope} />
          </div>
        )}

        {(show === "all" || show === "notes") && (home ? <ForYou /> : <ServerNotes guildId={scope} />)}
        {(show === "all" || show === "highlights") && <Highlights scope={scope} />}
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
  const highlights = useStore((s) => s.highlights);
  const guilds = useStore((s) => s.guilds);
  const prefs = useStore((s) => s.boardPrefs);
  const [type, setType] = useState<HighlightType | null>(null);
  // Home follows my Customize choices (servers and types); a server's board shows all of its own
  const all = useMemo(() => {
    const wanted = (gid: string, t: HighlightType) => {
      if (!home) return true;
      const p = prefs.guilds[gid];
      if (!p) return true;
      return p.highlights && (p.highlight_types === "all" || p.highlight_types.includes(t));
    };
    return Object.values(highlights)
      .filter((h) => (home ? !!guilds[h.guild_id] : h.guild_id === scope) && wanted(h.guild_id, highlightType(h)))
      .sort((a, b) => b.created_at - a.created_at)
      .slice(0, home ? 30 : 500);
  }, [highlights, guilds, prefs, home, scope]);
  const [only, setOnly] = useState<string | null>(null);
  const [more, setMore] = useState(!home);
  const servers = useMemo(() => [...new Set(all.map((h) => h.guild_id))], [all]);
  const list = all.filter((h) => (!only || h.guild_id === only) && (!type || highlightType(h) === type));
  const pickType = (t: HighlightType | null) => {
    setType(t);
    // a server's board asks the server for more of that type
    if (!home && t) loadHighlights(scope, undefined, 30, t).then((l) => setMore(l.length >= 30)).catch(() => {});
  };
  const older = async () => {
    try {
      const l = await loadHighlights(scope, all[all.length - 1]?.created_at, 30, type ?? undefined);
      setMore(l.length >= 30);
    } catch (e: any) {
      toast(e.message, "error");
    }
  };
  return (
    <section className="hb-section" data-hb-section="highlights">
      <h2 className="hb-label">Highlights</h2>
      <div className="hb-chips">
        <button className={"hb-chip" + (!type ? " on" : "")} onClick={() => pickType(null)}>
          All
        </button>
        {HIGHLIGHT_TYPES.map(([t, label]) => (
          <button key={t} className={"hb-chip" + (type === t ? " on" : "")} onClick={() => pickType(type === t ? null : t)}>
            {label}
          </button>
        ))}
      </div>
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
  const alarmList = useAlarms((s) => s.list);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 60_000);
    return () => clearInterval(t);
  }, []);
  const soon = useMemo(() => (home ? nextAlarm(alarmList, 12) : null), [alarmList, home, tick]);

  return (
    <section className="hb-index">
      <h2 className="hb-index-title">Right now</h2>
      {soon && soon.next_at && (
        <button className="al-chip" title="Schedule & alarms settings" onClick={() => openModal({ kind: "userSettings", tab: "schedule" })}>
          ⏰ Next alarm: {fmtWhen(soon.next_at).startsWith("Today") ? fmtTime(soon.next_at) : fmtWhen(soon.next_at)} — {soon.label || "Alarm"}
        </button>
      )}
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
