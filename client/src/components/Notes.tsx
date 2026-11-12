import { BOARD_NAME } from "../names";
import { useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { api } from "../api";
import { Markdown } from "../markdown";
import { ago, deleteNote, dismissNote, editNote, expiresText, markNoteRead, noteReads, postNote } from "../notes";
import { can, memberName, openGuildView, selectChannel, useStore } from "../store";
import { P, type Note, type NoteColor, type User } from "../types";
import { openModal, toast } from "../ui";
import { Avatar, Icon } from "./common";

export const NOTE_COLORS: NoteColor[] = ["yellow", "pink", "blue", "green", "purple"];

/** Open (or create) a DM with someone and go there. */
export async function replyTo(user: User) {
  try {
    const dm = user.is_bot ? await api("/api/bot/dm", { method: "POST" }) : await api("/api/users/@me/channels", { body: { recipient_id: user.id } });
    selectChannel("@me", dm.id);
  } catch (e: any) {
    toast(e.message, "error");
  }
}

/** A sticky note. `onHome` adds the "Open board" button and marks it read once seen. */
export function NoteCard({ note, onHome, pinned, serverName }: { note: Note; onHome?: boolean; pinned?: boolean; serverName?: string }) {
  const me = useStore((s) => s.me?.id);
  const mine = note.author.id === me;
  const canDelete = mine || can(note.guild_id, P.MANAGE_MESSAGES);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(note.content);
  const [reads, setReads] = useState<{ user: User; read_at: number | null; dismissed_at: number | null }[] | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const tilt = useMemo(() => ((parseInt(note.id.slice(-4), 36) || 0) % 5) - 2, [note.id]);

  // mark read once it has actually been on screen for a moment
  useEffect(() => {
    if (mine || note.read || !ref.current) return;
    let timer: number | undefined;
    const io = new IntersectionObserver(([e]) => {
      clearTimeout(timer);
      if (e.isIntersecting) timer = window.setTimeout(() => markNoteRead(note.id), 1500);
    });
    io.observe(ref.current);
    return () => {
      clearTimeout(timer);
      io.disconnect();
    };
  }, [note.id, note.read, mine]);

  const save = async () => {
    try {
      await editNote(note.id, { content: text.trim() });
      setEditing(false);
    } catch (e: any) {
      toast(e.message, "error");
    }
  };

  return (
    <div
      ref={ref}
      className={`note-card note-${note.color}` + (note.dismissed ? " dismissed" : "") + (!mine && !note.read ? " unread" : "") + (pinned ? " hb-pinned" : "")}
      style={{ transform: `rotate(${tilt * (pinned ? 1.1 : 0.6)}deg)` }}
    >
      {pinned && <span className={"hb-pin hb-pin-" + ["red", "blue", "green", "yellow"][Math.abs(parseInt(note.id.slice(-3), 36) || 0) % 4]} />}
      {pinned && serverName && <div className="hb-note-server">{serverName}</div>}
      <div className="note-head">
        <Avatar user={note.author} size={22} />
        <span className="bold ellipsis">{note.author.display_name}</span>
        {mine && <span className="note-you">you</span>}
        <span className="note-time" title={new Date(note.created_at).toLocaleString()}>
          {ago(note.created_at)}
          {note.edited_at ? " · edited" : ""}
        </span>
      </div>
      {note.audience === "people" && (
        <div className="note-to">
          To: <NoteRecipients guildId={note.guild_id} ids={note.to} />
        </div>
      )}
      {editing ? (
        <textarea className="note-edit" value={text} maxLength={1000} autoFocus onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && (e.ctrlKey || e.metaKey) && save()} />
      ) : (
        <div className="note-body">
          <Markdown text={note.content} guildId={note.guild_id} />
        </div>
      )}
      {note.expires_at && <div className="note-expires">{expiresText(note.expires_at)}</div>}
      <div className="note-actions">
        {editing ? (
          <>
            <button className="btn small primary" onClick={save} disabled={!text.trim()}>
              Save
            </button>
            <button className="btn small" onClick={() => (setEditing(false), setText(note.content))}>
              Cancel
            </button>
          </>
        ) : (
          <>
            {!mine &&
              (note.dismissed ? (
                <button className="btn small" onClick={() => dismissNote(note.id, true).catch((e) => toast(e.message, "error"))}>
                  Undismiss
                </button>
              ) : (
                <button className="btn small" title="Take it off your Home" onClick={() => dismissNote(note.id).catch((e) => toast(e.message, "error"))}>
                  ✓ Dismiss
                </button>
              ))}
            {!mine && (
              <button className="btn small" onClick={() => replyTo(note.author)}>
                Reply
              </button>
            )}
            {onHome && (
              <button className="btn small" onClick={() => openGuildView(note.guild_id, "notes")}>
                Open {BOARD_NAME}
              </button>
            )}
            {mine && (
              <>
                <button className="btn small" onClick={() => setEditing(true)}>
                  Edit
                </button>
                <button className="btn small note-seen" onClick={() => noteReads(note.id).then(setReads).catch((e) => toast(e.message, "error"))}>
                  Seen by {note.read_count} of {note.target_count}
                </button>
              </>
            )}
            {canDelete && (
              <button
                className="btn small danger-text"
                onClick={() =>
                  openModal({
                    kind: "confirm",
                    title: "Delete this note?",
                    body: "It disappears for everyone it was left for.",
                    danger: true,
                    confirmLabel: "Delete",
                    onConfirm: () => deleteNote(note.id),
                  })
                }
              >
                Delete
              </button>
            )}
          </>
        )}
      </div>
      {reads && (
        <div className="note-reads">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <b>Who's seen it</b>
            <button className="icon-btn tiny" onClick={() => setReads(null)} title="Close">
              <Icon name="x" size={14} />
            </button>
          </div>
          {reads.length === 0 && <div className="muted small">Nobody yet.</div>}
          {reads.map((r) => (
            <div key={r.user.id} className="row gap center-v small">
              <Avatar user={r.user} size={18} />
              <span className="ellipsis">{r.user.display_name}</span>
              <span className="muted">{r.dismissed_at ? "dismissed" : r.read_at ? "seen " + ago(r.read_at) : "not yet"}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function NoteRecipients({ guildId, ids }: { guildId: string; ids: string[] }) {
  const names = useStore(useShallow((s) => ids.map((id) => memberName(guildId, s.users[id] || s.members[guildId]?.[id]?.user) || "someone")));
  return <span>{names.join(", ")}</span>;
}

const EXPIRY: [string, string][] = [
  ["never", "Never"],
  ["today", "End of today"],
  ["day", "24 hours"],
  ["week", "1 week"],
];

function expiryAt(k: string): number | null {
  const now = Date.now();
  if (k === "today") {
    const d = new Date();
    d.setHours(23, 59, 59, 0);
    return d.getTime();
  }
  if (k === "day") return now + 86_400_000;
  if (k === "week") return now + 7 * 86_400_000;
  return null;
}

export function NoteComposer({ guildId, onPosted }: { guildId: string; onPosted?: () => void }) {
  const me = useStore((s) => s.me?.id);
  const members = useStore(
    useShallow((s) =>
      Object.values(s.members[guildId] || {})
        .map((m) => m.user)
        .filter((u) => u && u.id !== me && !u.is_bot),
    ),
  );
  const [text, setText] = useState("");
  const [color, setColor] = useState<NoteColor>("yellow");
  const [who, setWho] = useState<"everyone" | "people">("everyone");
  const [picked, setPicked] = useState<string[]>([]);
  const [q, setQ] = useState("");
  const [expiry, setExpiry] = useState("never");
  const [busy, setBusy] = useState(false);
  const list = members.filter((u) => !q.trim() || (memberName(guildId, u) || u.username).toLowerCase().includes(q.trim().toLowerCase()));
  // quick picks: your friends and your parties (only the ones in this server can see the note)
  const friendsMap = useStore((s) => s.friends);
  const channels = useStore((s) => s.channels);
  const groups = useMemo(() => {
    const here = new Set(members.map((u) => u.id));
    const out: { label: string; ids: string[] }[] = [];
    const fr = Object.values(friendsMap).filter((f) => f.state === "friend" && here.has(f.user.id)).map((f) => f.user.id);
    if (fr.length) out.push({ label: "All my friends", ids: fr });
    for (const c of Object.values(channels))
      if (c.kind === "party") {
        const ids = (c.recipients || []).map((r) => r.id).filter((id) => here.has(id));
        if (ids.length) out.push({ label: c.name, ids });
      }
    return out;
  }, [friendsMap, channels, members]);

  const post = async () => {
    if (!text.trim() || (who === "people" && !picked.length)) return;
    setBusy(true);
    try {
      await postNote(guildId, { content: text.trim(), color, to: who === "people" ? picked : [], expires_at: expiryAt(expiry) });
      setText("");
      setPicked([]);
      toast("Note posted");
      onPosted?.();
    } catch (e: any) {
      toast(e.message, "error");
    }
    setBusy(false);
  };

  return (
    <div className={`note-composer note-${color}`}>
      <textarea
        placeholder="Leave a note… e.g. “I'll be on around 10 pm tonight”"
        value={text}
        maxLength={1000}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && (e.ctrlKey || e.metaKey) && post()}
      />
      <div className="row gap center-v" style={{ flexWrap: "wrap" }}>
        <span className="note-swatches">
          {NOTE_COLORS.map((c) => (
            <button key={c} className={`note-swatch note-${c}` + (c === color ? " on" : "")} title={c} onClick={() => setColor(c)} />
          ))}
        </span>
        <select value={who} onChange={(e) => setWho(e.target.value as "everyone" | "people")}>
          <option value="everyone">Everyone in this server</option>
          <option value="people">Pick people…</option>
        </select>
        <label className="row gap center-v small">
          Hide after
          <select value={expiry} onChange={(e) => setExpiry(e.target.value)}>
            {EXPIRY.map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <button className="btn primary" disabled={busy || !text.trim() || (who === "people" && !picked.length)} onClick={post}>
          Post note
        </button>
      </div>
      {who === "people" && (
        <div className="note-people">
          {groups.length > 0 && (
            <div className="note-groups">
              {groups.map((g) => (
                <button key={g.label} className="btn small" title={`Pick ${g.ids.length} ${g.ids.length === 1 ? "person" : "people"} in this server`} onClick={() => setPicked((p) => [...new Set([...p, ...g.ids])])}>
                  + {g.label}
                </button>
              ))}
            </div>
          )}
          <input placeholder="Search people" value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="note-people-list">
            {list.map((u) => (
              <label key={u.id} className="check">
                <input type="checkbox" checked={picked.includes(u.id)} onChange={() => setPicked((p) => (p.includes(u.id) ? p.filter((x) => x !== u.id) : [...p, u.id]))} />
                <Avatar user={u} size={18} /> {memberName(guildId, u)}
              </label>
            ))}
            {!list.length && <div className="muted small">Nobody matches.</div>}
          </div>
          <div className="muted small">{picked.length} picked</div>
        </div>
      )}
    </div>
  );
}

