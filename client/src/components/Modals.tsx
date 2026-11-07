import { useShallow } from "zustand/react/shallow";
import { useEffect, useState } from "react";
import { api, media, session } from "../api";
import { can, memberName, roleColor, selectChannel, useStore } from "../store";
import { P } from "../types";
import { closeModal, copy, toast, useUI, type ModalSpec } from "../ui";
import { Avatar, BotTag, Icon } from "./common";
import { ScreenPicker } from "./VoiceView";
import { ServerSettings, UserSettings } from "./Settings";

export function Modals() {
  const modals = useUI((s) => s.modals);
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape" && useUI.getState().modals.length && !useUI.getState().menu) closeModal();
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, []);
  return (
    <>
      {modals.map((m, i) => (
        <div key={i} className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && closeModal()}>
          <ModalBody m={m} />
        </div>
      ))}
    </>
  );
}

function ModalBody({ m }: { m: ModalSpec }) {
  switch (m.kind) {
    case "createGuild":
      return <CreateGuild />;
    case "joinInvite":
      return <JoinInvite code={m.code} />;
    case "createChannel":
      return <CreateChannel guildId={m.guildId} parentId={m.parentId ?? null} kind={m.channelKind} />;
    case "editChannel":
      return <EditChannel channelId={m.channelId} />;
    case "invite":
      return <InviteModal guildId={m.guildId} />;
    case "confirm":
      return <Confirm {...m} />;
    case "profile":
      return <Profile userId={m.userId} guildId={m.guildId} />;
    case "screenPicker":
      return (
        <div className="modal wide">
          <h2>Share your screen</h2>
          <ScreenPicker onClose={closeModal} />
        </div>
      );
    case "saveGif":
      return <SaveGif fileId={m.fileId} url={m.url} preview={m.preview} />;
    case "serverSettings":
      return <ServerSettings guildId={m.guildId} tab={m.tab} />;
    case "userSettings":
      return <UserSettings tab={m.tab} />;
  }
}

function useSubmit<T>(fn: () => Promise<T>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const run = async (e?: React.FormEvent) => {
    e?.preventDefault();
    setBusy(true);
    setError("");
    try {
      await fn();
      closeModal();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

function CreateGuild() {
  const me = useStore((s) => s.me);
  const [name, setName] = useState(`${me?.display_name}'s server`);
  const { busy, error, run } = useSubmit(async () => {
    const g = await api("/api/guilds", { body: { name } });
    selectChannel(g.guild.id, null);
  });
  return (
    <form className="modal" onSubmit={run}>
      <h2>Create a server</h2>
      <p className="muted">A server is where your clients, channels, and voice rooms live.</p>
      <label>
        Server name
        <input value={name} onChange={(e) => setName(e.target.value)} autoFocus maxLength={100} />
      </label>
      {error && <div className="form-error">{error}</div>}
      <div className="modal-foot">
        <button type="button" className="btn link" onClick={closeModal}>
          Cancel
        </button>
        <button className="btn primary" disabled={busy || !name.trim()}>
          Create
        </button>
      </div>
    </form>
  );
}

function JoinInvite({ code: initial }: { code?: string }) {
  const [code, setCode] = useState((initial || "").split("@")[0]);
  const [preview, setPreview] = useState<any>(null);
  useEffect(() => {
    const c = /invite\/([^@/?#\s]+)/.exec(code)?.[1] || code.trim();
    if (c.length < 6) return setPreview(null);
    const t = setTimeout(() => api(`/api/invites/${encodeURIComponent(c)}`).then(setPreview).catch(() => setPreview(false)), 300);
    return () => clearTimeout(t);
  }, [code]);
  const { busy, error, run } = useSubmit(async () => {
    const c = /invite\/([^@/?#\s]+)/.exec(code)?.[1] || code.trim();
    const r = await api(`/api/invites/${encodeURIComponent(c)}`, { method: "POST" });
    if (r.guild_id) selectChannel(r.guild_id, null);
  });
  return (
    <form className="modal" onSubmit={run}>
      <h2>Join a server</h2>
      <label>
        Invite code or link
        <input value={code} onChange={(e) => setCode(e.target.value)} autoFocus placeholder="Xk3pQ9aB2z" />
      </label>
      {preview?.guild && (
        <div className="invite-preview">
          <b>{preview.guild.name}</b> · {preview.guild.member_count} members
        </div>
      )}
      {preview === false && <div className="form-error">Invalid or expired invite.</div>}
      {error && <div className="form-error">{error}</div>}
      <div className="modal-foot">
        <button type="button" className="btn link" onClick={closeModal}>
          Cancel
        </button>
        <button className="btn primary" disabled={busy || !preview}>
          Join Server
        </button>
      </div>
    </form>
  );
}

function CreateChannel({ guildId, parentId, kind: initialKind }: { guildId: string; parentId: string | null; kind?: "text" | "voice" | "category" }) {
  const [kind, setKind] = useState<"text" | "voice" | "category">(initialKind || "text");
  const [name, setName] = useState("");
  const [parent, setParent] = useState(parentId);
  const cats = useStore(useShallow((s) => Object.values(s.channels).filter((c) => c.guild_id === guildId && c.kind === "category")));
  const { busy, error, run } = useSubmit(async () => {
    const ch = await api(`/api/guilds/${guildId}/channels`, { body: { name, kind, parent_id: kind === "category" ? null : parent } });
    if (ch.kind === "text") selectChannel(guildId, ch.id);
  });
  return (
    <form className="modal" onSubmit={run}>
      <h2>Create {kind === "category" ? "Category" : "Channel"}</h2>
      {kind !== "category" && (
        <div className="kind-pick">
          {(["text", "voice"] as const).map((k) => (
            <label key={k} className={"kind-opt" + (kind === k ? " on" : "")}>
              <input type="radio" checked={kind === k} onChange={() => setKind(k)} />
              <Icon name={k === "text" ? "hash" : "speaker"} size={22} />
              <div>
                <b>{k === "text" ? "Text" : "Voice"}</b>
                <div className="muted small">{k === "text" ? "Messages, images, GIFs, files" : "Talk, video, and screen share"}</div>
              </div>
            </label>
          ))}
        </div>
      )}
      <label>
        Name
        <input value={name} onChange={(e) => setName(kind === "text" ? e.target.value.toLowerCase().replace(/\s+/g, "-") : e.target.value)} autoFocus maxLength={100} placeholder={kind === "text" ? "new-channel" : kind === "voice" ? "Lounge" : "PROJECTS"} />
      </label>
      {kind !== "category" && cats.length > 0 && (
        <label>
          Category
          <select value={parent || ""} onChange={(e) => setParent(e.target.value || null)}>
            <option value="">No category</option>
            {cats.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {error && <div className="form-error">{error}</div>}
      <div className="modal-foot">
        <button type="button" className="btn link" onClick={closeModal}>
          Cancel
        </button>
        <button className="btn primary" disabled={busy || !name.trim()}>
          Create
        </button>
      </div>
    </form>
  );
}

function EditChannel({ channelId }: { channelId: string }) {
  const ch = useStore((s) => s.channels[channelId]);
  const [name, setName] = useState(ch?.name || "");
  const [topic, setTopic] = useState(ch?.topic || "");
  const [position, setPosition] = useState(ch?.position ?? 0);
  const { busy, error, run } = useSubmit(() => api(`/api/channels/${channelId}`, { method: "PATCH", body: { name, topic, position } }));
  if (!ch) return null;
  return (
    <form className="modal" onSubmit={run}>
      <h2>Edit {ch.kind === "category" ? "Category" : "Channel"}</h2>
      <label>
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      </label>
      {ch.kind === "text" && (
        <label>
          Topic
          <textarea value={topic} onChange={(e) => setTopic(e.target.value)} rows={3} maxLength={1024} />
        </label>
      )}
      <label>
        Position <span className="muted small">(lower shows first)</span>
        <input type="number" value={position} onChange={(e) => setPosition(Number(e.target.value))} />
      </label>
      {error && <div className="form-error">{error}</div>}
      <div className="modal-foot">
        <button type="button" className="btn link" onClick={closeModal}>
          Cancel
        </button>
        <button className="btn primary" disabled={busy}>
          Save
        </button>
      </div>
    </form>
  );
}

export function serverAddress() {
  const d = useStore.getState().config.public_domain;
  return d ? `https://${d}` : session.server;
}

/** A normal web link: opens the sign-up page in any browser; also pasteable into the desktop app. */
export function inviteLink(code: string) {
  return `${serverAddress().replace(/\/+$/, "")}/invite/${code}`;
}

function InviteModal({ guildId }: { guildId: string }) {
  const guild = useStore((s) => s.guilds[guildId]);
  const [expires, setExpires] = useState(7 * 86400);
  const [maxUses, setMaxUses] = useState(0);
  const [inv, setInv] = useState<any>(null);
  const [error, setError] = useState("");
  const make = async () => {
    try {
      setInv(await api(`/api/guilds/${guildId}/invites`, { body: { expires_in: expires, max_uses: maxUses } }));
    } catch (e: any) {
      setError(e.message);
    }
  };
  useEffect(() => {
    make();
  }, [expires, maxUses]);
  return (
    <div className="modal">
      <h2>Invite people to {guild?.name}</h2>
      <p className="muted small">Send this link. It opens a sign-up page in any browser (phone, Chromebook, laptop). People with the desktop app can paste it into Register instead.</p>
      {inv && (
        <>
          <label>Invite link</label>
          <div className="copy-row">
            <input readOnly value={inviteLink(inv.code)} onFocus={(e) => e.target.select()} />
            <button className="btn primary" onClick={() => copy(inviteLink(inv.code), "Invite link copied")}>
              Copy
            </button>
          </div>
          <div className="muted small">
            Code <b>{inv.code}</b> · server <b>{serverAddress()}</b>
            {!useStore.getState().config.public_domain && " · this home address only works on your network until Remote Access is on"}
          </div>
        </>
      )}
      <div className="row gap">
        <label className="grow">
          Expire after
          <select value={expires} onChange={(e) => setExpires(Number(e.target.value))}>
            <option value={1800}>30 minutes</option>
            <option value={86400}>1 day</option>
            <option value={7 * 86400}>7 days</option>
            <option value={30 * 86400}>30 days</option>
            <option value={0}>Never</option>
          </select>
        </label>
        <label className="grow">
          Max uses
          <select value={maxUses} onChange={(e) => setMaxUses(Number(e.target.value))}>
            <option value={0}>No limit</option>
            <option value={1}>1 use</option>
            <option value={5}>5 uses</option>
            <option value={10}>10 uses</option>
            <option value={50}>50 uses</option>
          </select>
        </label>
      </div>
      {error && <div className="form-error">{error}</div>}
      <div className="modal-foot">
        <button className="btn primary" onClick={closeModal}>
          Done
        </button>
      </div>
    </div>
  );
}

function Confirm(m: Extract<ModalSpec, { kind: "confirm" }>) {
  const { busy, error, run } = useSubmit(async () => {
    await m.onConfirm();
  });
  return (
    <div className="modal">
      <h2>{m.title}</h2>
      <p>{m.body}</p>
      {error && <div className="form-error">{error}</div>}
      <div className="modal-foot">
        <button className="btn link" onClick={closeModal}>
          Cancel
        </button>
        <button className={"btn " + (m.danger ? "red" : "primary")} disabled={busy} onClick={() => run()} autoFocus>
          {m.confirmLabel || "Confirm"}
        </button>
      </div>
    </div>
  );
}

function Profile({ userId, guildId }: { userId: string; guildId: string | null }) {
  const user = useStore((s) => s.users[userId]);
  const member = useStore((s) => (guildId ? s.members[guildId]?.[userId] : undefined));
  const roles = useStore((s) => (guildId ? s.roles[guildId] : undefined)) || [];
  const me = useStore((s) => s.me)!;
  const presence = useStore((s) => s.presences[userId]);
  const manageRoles = guildId ? can(guildId, P.MANAGE_ROLES) : false;
  if (!user) return null;
  const toggleRole = (rid: string, has: boolean) =>
    api(`/api/guilds/${guildId}/members/${userId}/roles/${rid}`, { method: has ? "DELETE" : "PUT" }).catch((e) => toast(e.message, "error"));
  const message = async () => {
    try {
      const dm = user.is_bot ? await api("/api/bot/dm", { method: "POST" }) : await api("/api/users/@me/channels", { body: { recipient_id: userId } });
      closeModal();
      selectChannel("@me", dm.id);
    } catch (e: any) {
      toast(e.message, "error");
    }
  };
  return (
    <div className="modal profile">
      <div className="profile-banner" style={{ background: roleColor(guildId, userId) || "#5865f2" }} />
      <div className="profile-avatar">
        <Avatar user={user} size={88} status />
      </div>
      <div className="profile-body">
        <h2>
          {memberName(guildId, user)} {user.is_bot && <BotTag />}
        </h2>
        <div className="muted">@{user.username}{user.is_admin ? " · server admin" : ""}</div>
        <div className="muted small">{user.is_bot ? "AI assistant (llama.cpp)" : presence && presence !== "offline" ? presence : "offline"}</div>
        {member && (
          <>
            <div className="profile-section">Member since</div>
            <div>{new Date(member.joined_at).toLocaleDateString()}</div>
            <div className="profile-section">Roles</div>
            <div className="role-chips">
              {roles
                .filter((r) => r.id !== guildId && (member.roles.includes(r.id) || manageRoles))
                .map((r) => {
                  const has = member.roles.includes(r.id);
                  return (
                    <button key={r.id} className={"role-chip" + (has ? " has" : "")} disabled={!manageRoles} onClick={() => toggleRole(r.id, has)}>
                      <span className="role-dot" style={{ background: r.color ? "#" + r.color.toString(16).padStart(6, "0") : "#99aab5" }} />
                      {r.name}
                      {manageRoles && <span className="muted">{has ? " ✕" : " +"}</span>}
                    </button>
                  );
                })}
              {!member.roles.length && !manageRoles && <span className="muted small">No roles</span>}
            </div>
          </>
        )}
        {userId !== me.id && (
          <button className="btn primary wide" onClick={message}>
            Message
          </button>
        )}
      </div>
    </div>
  );
}

function SaveGif({ fileId, url: initialUrl, preview }: { fileId?: string; url?: string; preview?: string }) {
  const [url, setUrl] = useState(initialUrl || "");
  const [title, setTitle] = useState("");
  const [tags, setTags] = useState("");
  const { busy, error, run } = useSubmit(async () => {
    const r = await api("/api/gifs", { body: fileId ? { file_id: fileId, title, tags } : { url, title, tags } });
    toast(r.existing ? "Already in the library — added to your favorites" : "Saved to the GIF library");
  });
  return (
    <form className="modal" onSubmit={run}>
      <h2>Save GIF to library</h2>
      <p className="muted small">The GIF is stored on your server so everyone can search it. Nothing is fetched from GIF sites when people use it.</p>
      {preview && (preview.includes(".mp4") || preview.includes("video") ? <video className="gif-preview" src={media(preview)} autoPlay loop muted /> : <img className="gif-preview" src={media(preview)} alt="" />)}
      {!fileId && (
        <label>
          GIF link (Tenor/Giphy page or direct .gif/.mp4)
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" autoFocus />
        </label>
      )}
      <label>
        Title
        <input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus={!!fileId} placeholder="victory dance" />
      </label>
      <label>
        Tags <span className="muted small">(comma or space separated)</span>
        <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="happy, dance, win" />
      </label>
      {error && <div className="form-error">{error}</div>}
      <div className="modal-foot">
        <button type="button" className="btn link" onClick={closeModal}>
          Cancel
        </button>
        <button className="btn primary" disabled={busy || (!fileId && !url)}>
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
    </form>
  );
}
