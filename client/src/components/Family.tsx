// Family: kid accounts and their parents. Also the password-reset approvals list.
import { useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { api } from "../api";
import { can, onEvent, useStore } from "../store";
import { P, type User } from "../types";
import { closeModal, openModal, toast } from "../ui";
import { Avatar, Icon, Toggle } from "./common";

interface Kid {
  user: User;
  guardians: User[];
  contacts: User[];
  guilds: { id: string; name: string; owner_id: string }[];
  settings: {
    dm_mode: "approved" | "anyone";
    join_approval: boolean;
    auto_approve_owners: string[];
    kid_safe_bot: boolean;
    can_delete: boolean;
    quiet: { enabled: boolean; start: string; end: string; days: number[]; utc_offset_min: number };
  };
  requests: { id: string; kind: "dm" | "join"; target: any; created_at: number }[];
  quiet_now: string | null;
  mine: boolean;
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Password reset requests this person can approve (admins, or a kid's parents). */
export function ResetRequests() {
  const [list, setList] = useState<{ id: string; user: User; created_at: number }[]>([]);
  const load = () => api("/api/reset-requests").then(setList).catch(() => {});
  useEffect(() => {
    load();
    return onEvent((t) => {
      if (t === "RESET_REQUEST" || t === "RESET_REQUEST_DONE") load();
    });
  }, []);
  if (!list.length) return null;
  const decide = (id: string, approve: boolean) => api(`/api/reset-requests/${id}`, { body: { approve } }).then(load).catch((e) => toast(e.message, "error"));
  return (
    <div className="request-box">
      <div className="profile-section">Password reset requests</div>
      {list.map((r) => (
        <div key={r.id} className="member-trow">
          <Avatar user={r.user} size={28} />
          <span className="grow">
            <b>{r.user.display_name}</b> <span className="muted">@{r.user.username}</span> forgot their password · {new Date(r.created_at).toLocaleString()}
            <div className="muted small">Approve only if you know it's really them. Their waiting screen then lets them choose a new password.</div>
          </span>
          <button className="btn small primary" onClick={() => decide(r.id, true)}>
            Approve
          </button>
          <button className="btn small" onClick={() => decide(r.id, false)}>
            Deny
          </button>
        </div>
      ))}
    </div>
  );
}

export function Family() {
  const me = useStore((s) => s.me)!;
  const [kids, setKids] = useState<Kid[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const load = () =>
    api("/api/kids")
      .then((k: Kid[]) => {
        setKids(k);
        if (!open && k.length === 1) setOpen(k[0].user.id);
      })
      .catch((e) => toast(e.message, "error"));
  useEffect(() => {
    load();
    return onEvent((t) => {
      if (t === "KID_REQUEST" || t === "KID_REQUEST_DONE") load();
    });
  }, []);
  if (!kids) return <div className="muted">Loading…</div>;
  const mine = kids.filter((k) => k.mine);
  const others = kids.filter((k) => !k.mine);
  const pending = kids.flatMap((k) => k.requests.map((r) => ({ ...r, kid: k.user })));
  return (
    <div>
      <h2>Family</h2>
      <p className="muted small">
        Kid accounts are made here, with no invite needed. As their parent you can read all their chats, approve who they talk to and which servers they join, and set quiet hours. A kid can have more than one parent account.
      </p>
      <ResetRequests />
      {pending.length > 0 && (
        <div className="request-box">
          <div className="profile-section">Waiting for you</div>
          {pending.map((r) => (
            <RequestRow key={r.id} r={r} onDone={load} />
          ))}
        </div>
      )}
      <div className="row gap" style={{ margin: "12px 0" }}>
        <button className="btn primary" onClick={() => setAdding(!adding)}>
          <Icon name="plus" size={14} /> Add a kid account
        </button>
      </div>
      {adding && (
        <NewKid
          onDone={(k) => {
            setAdding(false);
            setOpen(k.user.id);
            load();
          }}
        />
      )}
      {mine.length === 0 && !adding && <p className="muted">No kid accounts yet.</p>}
      {mine.map((k) => (
        <KidCard key={k.user.id} k={k} open={open === k.user.id} onToggle={() => setOpen(open === k.user.id ? null : k.user.id)} onChange={load} me={me} />
      ))}
      {others.length > 0 && (
        <>
          <div className="profile-section">Other kid accounts (admin view)</div>
          {others.map((k) => (
            <KidCard key={k.user.id} k={k} open={open === k.user.id} onToggle={() => setOpen(open === k.user.id ? null : k.user.id)} onChange={load} me={me} />
          ))}
        </>
      )}
    </div>
  );
}

function RequestRow({ r, onDone }: { r: any; onDone: () => void }) {
  const decide = (approve: boolean) => api(`/api/kid-requests/${r.id}`, { body: { approve } }).then(onDone).catch((e) => toast(e.message, "error"));
  const what =
    r.kind === "dm" ? (
      <>
        wants to chat with <b>{r.target?.display_name}</b> <span className="muted">@{r.target?.username}</span>
      </>
    ) : (
      <>
        wants to join the server <b>{r.target?.name}</b>
        {r.target?.owner && <span className="muted"> (run by {r.target.owner.display_name})</span>}
      </>
    );
  return (
    <div className="member-trow">
      <Avatar user={r.kid} size={28} />
      <span className="grow">
        <b>{r.kid.display_name}</b> {what}
      </span>
      <button className="btn small primary" onClick={() => decide(true)}>
        Allow
      </button>
      <button className="btn small" onClick={() => decide(false)}>
        No
      </button>
    </div>
  );
}

function NewKid({ onDone }: { onDone: (k: Kid) => void }) {
  const [username, setUsername] = useState("");
  const [display, setDisplay] = useState("");
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr("");
    try {
      onDone(await api("/api/kids", { body: { username, display_name: display || undefined, password: pw } }));
      toast(`Made ${display || username}'s account. Sign them in with that username and password.`);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="kid-card open" onSubmit={submit}>
      <div className="row gap">
        <label className="grow">
          Username <span className="muted">(what they type to sign in)</span>
          <input value={username} onChange={(e) => setUsername(e.target.value.replace(/\s/g, ""))} autoFocus />
        </label>
        <label className="grow">
          Name shown in chat
          <input value={display} onChange={(e) => setDisplay(e.target.value)} placeholder={username} />
        </label>
      </div>
      <label>
        Password <span className="muted">(at least 8 characters; you can change it any time)</span>
        <input type="text" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="off" />
      </label>
      {err && <div className="form-error">{err}</div>}
      <button className="btn primary" disabled={busy || !username || pw.length < 8}>
        Create kid account
      </button>
    </form>
  );
}

function KidCard({ k, open, onToggle, onChange, me }: { k: Kid; open: boolean; onToggle: () => void; onChange: () => void; me: User }) {
  const s = k.settings;
  const kidId = k.user.id;
  const myGuilds = useStore(useShallow((st) => st.guildOrder.map((g) => st.guilds[g]).filter(Boolean)));
  const users = useStore((st) => st.users);
  const set = (patch: Partial<Kid["settings"]>) =>
    api(`/api/kids/${kidId}/settings`, { body: patch })
      .then(onChange)
      .catch((e) => toast(e.message, "error"));
  const setQuiet = (patch: Partial<Kid["settings"]["quiet"]>) => set({ quiet: { ...s.quiet, ...patch, utc_offset_min: -new Date().getTimezoneOffset() } });
  const addBy = (path: string, title: string, label: string) =>
    openModal({
      kind: "prompt",
      title,
      label,
      placeholder: "username",
      confirmLabel: "Add",
      onSubmit: (v: string) => api(`/api/kids/${kidId}/${path}`, { body: { user: v } }).then(onChange),
    });
  const notIn = myGuilds.filter((g) => !k.guilds.some((x) => x.id === g.id) && can(g.id, P.CREATE_INVITE));
  const autoNames = s.auto_approve_owners.map((id) => users[id]?.display_name || id);
  return (
    <div className={"kid-card" + (open ? " open" : "")}>
      <div className="kid-head" onClick={onToggle}>
        <Avatar user={k.user} size={36} />
        <span className="grow">
          <b>{k.user.display_name}</b> <span className="muted">@{k.user.username}</span>
          {k.quiet_now && <span className="role-chip kid"> quiet hours until {k.quiet_now}</span>}
          {k.requests.length > 0 && <span className="role-chip has"> {k.requests.length} waiting</span>}
        </span>
        <button
          className="btn small"
          onClick={(e) => {
            e.stopPropagation();
            openModal({ kind: "kidChats", kidId, name: k.user.display_name });
          }}
        >
          View chats
        </button>
        <span style={{ display: "inline-flex", transform: open ? "rotate(180deg)" : undefined }}>
          <Icon name="chevron" size={16} />
        </span>
      </div>
      {open && (
        <div className="kid-body">
          <div className="profile-section">Rules</div>
          <Row title="Chat only with approved people" desc="They can always message their parents. Anyone else needs your OK first. They ask, and you get a notice.">
            <Toggle on={s.dm_mode === "approved"} onChange={(on) => set({ dm_mode: on ? "approved" : "anyone" })} />
          </Row>
          <Row title="Joining servers needs my OK" desc="Servers run by their parents, or by people you list below, are OK'd automatically.">
            <Toggle on={s.join_approval} onChange={(on) => set({ join_approval: on })} />
          </Row>
          {s.join_approval && (
            <div className="sub-row">
              <span className="muted small">Auto-OK servers made by: </span>
              {autoNames.length ? autoNames.join(", ") : <span className="muted small">nobody else yet</span>}
              <select
                value=""
                onChange={(e) => e.target.value && set({ auto_approve_owners: [...s.auto_approve_owners, e.target.value] })}
                style={{ width: 200, marginLeft: 8 }}
              >
                <option value="">+ add someone…</option>
                {Object.values(users)
                  .filter((u) => !u.is_bot && u.id !== kidId && !s.auto_approve_owners.includes(u.id))
                  .map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.display_name} (@{u.username})
                    </option>
                  ))}
              </select>
              {s.auto_approve_owners.length > 0 && (
                <button className="btn small link" onClick={() => set({ auto_approve_owners: [] })}>
                  clear
                </button>
              )}
            </div>
          )}
          <Row title="Kid-safe AI" desc="The AI bot keeps its answers age-appropriate whenever this kid is in the conversation.">
            <Toggle on={s.kid_safe_bot} onChange={(on) => set({ kid_safe_bot: on })} />
          </Row>
          <Row title="Can delete their own messages" desc="Off: their messages stay, so you can always see them.">
            <Toggle on={s.can_delete} onChange={(on) => set({ can_delete: on })} />
          </Row>
          <Row title="Quiet hours" desc="No chatting or calls during these hours.">
            <Toggle on={s.quiet.enabled} onChange={(on) => setQuiet({ enabled: on })} />
          </Row>
          {s.quiet.enabled && (
            <div className="sub-row">
              from <input type="time" value={s.quiet.start} onChange={(e) => setQuiet({ start: e.target.value })} style={{ width: 120 }} /> to{" "}
              <input type="time" value={s.quiet.end} onChange={(e) => setQuiet({ end: e.target.value })} style={{ width: 120 }} />
              <span className="days">
                {DAYS.map((d, i) => (
                  <label key={d} className="check">
                    <input type="checkbox" checked={s.quiet.days.includes(i)} onChange={(e) => setQuiet({ days: e.target.checked ? [...s.quiet.days, i].sort() : s.quiet.days.filter((x) => x !== i) })} />
                    {d}
                  </label>
                ))}
              </span>
              <div className="muted small">Days are the nights it starts on, e.g. Sun–Thu for school nights.</div>
            </div>
          )}

          <div className="profile-section">Servers</div>
          {k.guilds.map((g) => (
            <div key={g.id} className="member-trow">
              <span className="grow">{g.name}</span>
              <button
                className="btn small red"
                onClick={() =>
                  openModal({
                    kind: "confirm",
                    title: `Take ${k.user.display_name} out of ${g.name}?`,
                    body: "As their parent you can do this for any server, whoever runs it.",
                    confirmLabel: "Remove",
                    danger: true,
                    onConfirm: () => api(`/api/kids/${kidId}/guilds/${g.id}`, { method: "DELETE" }).then(onChange),
                  })
                }
              >
                Remove
              </button>
            </div>
          ))}
          {notIn.length > 0 && (
            <select value="" onChange={(e) => e.target.value && api(`/api/kids/${kidId}/guilds`, { body: { guild_id: e.target.value } }).then(onChange).catch((er) => toast(er.message, "error"))} style={{ width: 260 }}>
              <option value="">+ Add to one of my servers…</option>
              {notIn.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
          )}

          <div className="profile-section">Approved people to chat with</div>
          {k.contacts.length === 0 && <p className="muted small">Nobody yet besides their parents.</p>}
          {k.contacts.map((u) => (
            <div key={u.id} className="member-trow">
              <Avatar user={u} size={24} />
              <span className="grow">
                {u.display_name} <span className="muted">@{u.username}</span>
              </span>
              <button className="btn small" onClick={() => api(`/api/kids/${kidId}/contacts/${u.id}`, { method: "DELETE" }).then(onChange)}>
                Remove
              </button>
            </div>
          ))}
          <button className="btn small" onClick={() => addBy("contacts", `Who can ${k.user.display_name} chat with?`, "Their username")}>
            + Approve someone
          </button>

          <div className="profile-section">Parents</div>
          {k.guardians.map((u) => (
            <div key={u.id} className="member-trow">
              <Avatar user={u} size={24} />
              <span className="grow">
                {u.display_name} <span className="muted">@{u.username}</span> {u.id === me.id && <span className="muted">(you)</span>}
              </span>
              {k.guardians.length > 1 && (
                <button className="btn small" onClick={() => api(`/api/kids/${kidId}/guardians/${u.id}`, { method: "DELETE" }).then(onChange).catch((e) => toast(e.message, "error"))}>
                  Remove
                </button>
              )}
            </div>
          ))}
          <button className="btn small" onClick={() => addBy("guardians", "Add a parent", "Their username (any regular account)")}>
            + Add a parent
          </button>

          <div className="profile-section">Sign-in</div>
          <button
            className="btn small"
            onClick={() =>
              openModal({
                kind: "prompt",
                title: `New password for ${k.user.display_name}`,
                label: "Password (at least 8 characters)",
                confirmLabel: "Set password",
                onSubmit: (v: string) => api(`/api/kids/${kidId}/password`, { body: { password: v } }).then(() => toast("Password changed")),
              })
            }
          >
            Set a new password
          </button>
        </div>
      )}
    </div>
  );
}

function Row({ title, desc, children }: { title: string; desc: string; children: React.ReactNode }) {
  return (
    <div className="perm-row">
      <div>
        <div className="bold">{title}</div>
        <div className="muted small">{desc}</div>
      </div>
      {children}
    </div>
  );
}

/** A parent's read-only view of everything their kid can read. */
export function KidChats({ kidId, name }: { kidId: string; name: string }) {
  const [list, setList] = useState<{ servers: any[]; dms: any[] } | null>(null);
  const [sel, setSel] = useState<{ id: string; label: string } | null>(null);
  const [msgs, setMsgs] = useState<any[] | null>(null);
  const [more, setMore] = useState(false);
  useEffect(() => {
    api(`/api/kids/${kidId}/channels`).then(setList).catch((e) => toast(e.message, "error"));
  }, [kidId]);
  const open = async (id: string, label: string) => {
    setSel({ id, label });
    setMsgs(null);
    if (id === "__calls") {
      // what was said in voice calls (saved only for kids), shaped like messages
      const lines = await api(`/api/kids/${kidId}/calls`).catch(() => []);
      setMsgs(
        lines.map((l: any, i: number) => ({
          id: "c" + i,
          author: { id: l.speaker_id, display_name: l.speaker + (l.channel_name ? `  · 🔊 ${l.channel_name}` : "") },
          content: l.text,
          created_at: l.at,
          attachments: [],
        })),
      );
      setMore(false);
      return;
    }
    const m = await api(`/api/channels/${id}/messages?limit=100`);
    setMsgs(m);
    setMore(m.length === 100);
  };
  const older = async () => {
    if (!sel || !msgs?.length) return;
    const m = await api(`/api/channels/${sel.id}/messages?limit=100&before=${msgs[0].id}`);
    setMsgs([...m, ...msgs]);
    setMore(m.length === 100);
  };
  return (
    <div className="modal wide kid-chats">
      <div className="row center-v">
        <h2 className="grow">{name}'s chats</h2>
        <span className="muted small">read-only</span>
        <button className="btn link" onClick={closeModal}>
          Close
        </button>
      </div>
      <div className="kid-chats-body">
        <div className="kid-chats-list">
          {!list && <div className="muted">Loading…</div>}
          {list && (
            <>
              <div className="profile-section">Voice calls</div>
              <button className={"role-item" + (sel?.id === "__calls" ? " on" : "")} onClick={() => open("__calls", "What was said in voice calls")}>
                🔊 Call transcripts
              </button>
              <div className="profile-section">Direct messages</div>
              {list.dms.length === 0 && <div className="muted small">None</div>}
              {list.dms.map((d) => {
                const label = d.with.map((u: User) => u.display_name).join(", ") || "(empty)";
                return (
                  <button key={d.id} className={"role-item" + (sel?.id === d.id ? " on" : "")} onClick={() => open(d.id, label)}>
                    {label}
                  </button>
                );
              })}
              {list.servers.map((s) => (
                <div key={s.guild.id}>
                  <div className="profile-section">{s.guild.name}</div>
                  {s.channels.map((c: any) => (
                    <button key={c.id} className={"role-item" + (sel?.id === c.id ? " on" : "")} onClick={() => open(c.id, `#${c.name}`)}>
                      # {c.name}
                    </button>
                  ))}
                </div>
              ))}
            </>
          )}
        </div>
        <div className="kid-chats-msgs">
          {!sel && <div className="muted">Pick a conversation.</div>}
          {sel && !msgs && <div className="muted">Loading…</div>}
          {sel && msgs && (
            <>
              <div className="bold">{sel.label}</div>
              {more && (
                <button className="btn small" onClick={older}>
                  Load older
                </button>
              )}
              {msgs.length === 0 && <div className="muted">No messages.</div>}
              {msgs.map((m) => (
                <div key={m.id} className={"kid-msg" + (m.author.id === kidId ? " theirs" : "")}>
                  <span className="bold">{m.author.display_name}</span> <span className="muted small">{new Date(m.created_at).toLocaleString()}</span>
                  <div className="kid-msg-text">{m.content}</div>
                  {m.attachments?.map((a: any) => (
                    <div key={a.id} className="muted small">
                      📎 {a.filename}
                    </div>
                  ))}
                </div>
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
