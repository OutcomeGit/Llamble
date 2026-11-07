import { useShallow } from "zustand/react/shallow";
import { useEffect, useRef, useState } from "react";
import { api, upload } from "../api";
import { chosenGpu, refreshGpus, saveAiConfig, setLending, startLocalModel, stopLocalModel, useAi, type AiConfig } from "../aiWorker";
import { can, guildPerms, memberName, useStore } from "../store";
import { P, PERM_LABELS, type Role, type User } from "../types";
import { closeModal, copy, openModal, toast } from "../ui";
import { applyDevicePrefs, prefs } from "../voice";
import { Avatar, BotTag, GuildIcon, Icon, Toggle } from "./common";
import { inviteLink } from "./Modals";
import { logout } from "../App";

function SettingsFrame({ tabs, tab, setTab, children, title }: { tabs: { id: string; label: string; hidden?: boolean; danger?: boolean }[]; tab: string; setTab: (t: string) => void; children: React.ReactNode; title: string }) {
  return (
    <div className="settings">
      <nav className="settings-nav">
        <div className="settings-nav-title">{title}</div>
        {tabs
          .filter((t) => !t.hidden)
          .map((t) => (
            <button key={t.id} className={(tab === t.id ? "on " : "") + (t.danger ? "danger" : "")} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
      </nav>
      <section className="settings-body">
        <button className="settings-close" onClick={closeModal} title="Close (Esc)">
          <Icon name="x" size={22} />
        </button>
        {children}
      </section>
    </div>
  );
}

// =================== Server settings ===================

export function ServerSettings({ guildId, tab: initial }: { guildId: string; tab?: string }) {
  const [tab, setTab] = useState(initial || "overview");
  const guild = useStore((s) => s.guilds[guildId]);
  const me = useStore((s) => s.me)!;
  useStore((s) => s.roles[guildId]);
  if (!guild) return null;
  const isOwner = guild.owner_id === me.id;
  return (
    <SettingsFrame
      title={guild.name}
      tab={tab}
      setTab={setTab}
      tabs={[
        { id: "overview", label: "Overview", hidden: !can(guildId, P.MANAGE_GUILD) },
        { id: "roles", label: "Roles", hidden: !can(guildId, P.MANAGE_ROLES) },
        { id: "members", label: "Members" },
        { id: "invites", label: "Invites", hidden: !can(guildId, P.MANAGE_GUILD) },
        { id: "bans", label: "Bans", hidden: !can(guildId, P.BAN) },
        { id: "bot", label: "AI Bot", hidden: !can(guildId, P.MANAGE_GUILD) },
        { id: "delete", label: "Delete Server", hidden: !isOwner && !me.is_admin, danger: true },
      ]}
    >
      {tab === "overview" && <Overview guildId={guildId} />}
      {tab === "roles" && <Roles guildId={guildId} />}
      {tab === "members" && <Members guildId={guildId} />}
      {tab === "invites" && <Invites guildId={guildId} />}
      {tab === "bans" && <Bans guildId={guildId} />}
      {tab === "bot" && <BotSettings guildId={guildId} />}
      {tab === "delete" && (
        <div>
          <h2>Delete '{guild.name}'</h2>
          <p className="muted">This permanently deletes every channel, message and file reference in this server.</p>
          <button
            className="btn red"
            onClick={() =>
              openModal({
                kind: "confirm",
                title: "Delete server permanently?",
                body: `Type-free confirmation: '${guild.name}' and all its messages will be gone.`,
                danger: true,
                confirmLabel: "Delete Server",
                onConfirm: async () => {
                  await api(`/api/guilds/${guildId}`, { method: "DELETE" });
                  closeModal();
                },
              })
            }
          >
            Delete Server
          </button>
        </div>
      )}
    </SettingsFrame>
  );
}

function Overview({ guildId }: { guildId: string }) {
  const guild = useStore((s) => s.guilds[guildId])!;
  const [name, setName] = useState(guild.name);
  const fileRef = useRef<HTMLInputElement>(null);
  const save = () => api(`/api/guilds/${guildId}`, { method: "PATCH", body: { name } }).then(() => toast("Saved")).catch((e) => toast(e.message, "error"));
  const setIcon = async (f: File) => {
    try {
      const fo = await upload(f, f.name);
      await api(`/api/guilds/${guildId}`, { method: "PATCH", body: { icon_file_id: fo.id } });
    } catch (e: any) {
      toast(e.message, "error");
    }
  };
  return (
    <div>
      <h2>Server Overview</h2>
      <div className="row gap">
        <div className="guild-icon-edit" onClick={() => fileRef.current?.click()} title="Change icon">
          <GuildIcon name={guild.name} iconId={guild.icon_file_id} size={96} />
          <span>CHANGE</span>
        </div>
        <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => e.target.files?.[0] && setIcon(e.target.files[0])} />
        <div className="grow">
          <label>
            Server name
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <div className="row gap">
            <button className="btn primary" onClick={save} disabled={name === guild.name}>
              Save Changes
            </button>
            {guild.icon_file_id && (
              <button className="btn" onClick={() => api(`/api/guilds/${guildId}`, { method: "PATCH", body: { icon_file_id: null } })}>
                Remove icon
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

const hex = (c: number) => "#" + c.toString(16).padStart(6, "0");

function Roles({ guildId }: { guildId: string }) {
  const roles = useStore((s) => s.roles[guildId]) || [];
  const sorted = [...roles].sort((a, b) => b.position - a.position);
  const [sel, setSel] = useState<string>(sorted.find((r) => r.id !== guildId)?.id || guildId);
  const role = roles.find((r) => r.id === sel);
  const mine = guildPerms(guildId);

  const patch = (body: Partial<Role>) => api(`/api/guilds/${guildId}/roles/${sel}`, { method: "PATCH", body }).catch((e) => toast(e.message, "error"));
  const create = async () => {
    const r = await api(`/api/guilds/${guildId}/roles`, { body: { name: "new role", permissions: 0 } });
    setSel(r.id);
  };
  return (
    <div>
      <h2>Roles</h2>
      <p className="muted small">Members get every permission from @everyone plus the roles they have. Higher roles show first in the member list when "display separately" is on.</p>
      <div className="roles-layout">
        <div className="roles-list">
          <button className="btn primary small" onClick={create}>
            <Icon name="plus" size={14} /> Create Role
          </button>
          {sorted.map((r) => (
            <button key={r.id} className={"role-item" + (r.id === sel ? " on" : "")} onClick={() => setSel(r.id)}>
              <span className="role-dot" style={{ background: r.color ? hex(r.color) : "#99aab5" }} />
              {r.name}
            </button>
          ))}
        </div>
        {role && (
          <div className="role-edit" key={role.id}>
            {role.id !== guildId && (
              <>
                <label>
                  Role name
                  <input defaultValue={role.name} onBlur={(e) => e.target.value !== role.name && patch({ name: e.target.value })} />
                </label>
                <div className="row gap center-v">
                  <label>
                    Color
                    <input type="color" defaultValue={role.color ? hex(role.color) : "#99aab5"} onChange={(e) => patch({ color: parseInt(e.target.value.slice(1), 16) })} />
                  </label>
                  <label className="check">
                    <input type="checkbox" checked={role.hoist} onChange={(e) => patch({ hoist: e.target.checked })} /> Display separately in member list
                  </label>
                  <label>
                    Position
                    <input type="number" style={{ width: 70 }} defaultValue={role.position} onBlur={(e) => patch({ position: Number(e.target.value) })} />
                  </label>
                </div>
              </>
            )}
            <div className="perm-list">
              {PERM_LABELS.map(([bit, label, desc]) => (
                <div key={bit} className="perm-row">
                  <div>
                    <div className="bold">{label}</div>
                    <div className="muted small">{desc}</div>
                  </div>
                  <Toggle on={(role.permissions & bit) !== 0} disabled={(mine & bit) === 0} onChange={(on) => patch({ permissions: on ? role.permissions | bit : role.permissions & ~bit })} />
                </div>
              ))}
            </div>
            {role.id !== guildId && (
              <button
                className="btn red"
                onClick={() =>
                  openModal({ kind: "confirm", title: `Delete '${role.name}'`, body: "Members lose this role's permissions.", danger: true, confirmLabel: "Delete Role", onConfirm: () => api(`/api/guilds/${guildId}/roles/${role.id}`, { method: "DELETE" }).then(() => setSel(guildId)) })
                }
              >
                Delete Role
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Members({ guildId }: { guildId: string }) {
  const members = useStore((s) => s.members[guildId]) || {};
  const roles = useStore((s) => s.roles[guildId]) || [];
  const guild = useStore((s) => s.guilds[guildId])!;
  const [q, setQ] = useState("");
  const list = Object.values(members)
    .filter((m) => !q || memberName(guildId, m.user).toLowerCase().includes(q.toLowerCase()) || m.user.username.includes(q.toLowerCase()))
    .sort((a, b) => a.joined_at - b.joined_at);
  return (
    <div>
      <h2>Members — {Object.keys(members).length}</h2>
      <input placeholder="Search members" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="member-table">
        {list.map((m) => (
          <div key={m.user.id} className="member-trow">
            <Avatar user={m.user} size={32} />
            <div className="grow">
              <div className="bold">
                {memberName(guildId, m.user)} {m.user.is_bot && <BotTag />} {guild.owner_id === m.user.id && "👑"}
              </div>
              <div className="muted small">@{m.user.username} · joined {new Date(m.joined_at).toLocaleDateString()}</div>
            </div>
            <div className="role-chips">
              {m.roles.map((rid) => {
                const r = roles.find((x) => x.id === rid);
                return r ? (
                  <span key={rid} className="role-chip has">
                    <span className="role-dot" style={{ background: r.color ? hex(r.color) : "#99aab5" }} />
                    {r.name}
                  </span>
                ) : null;
              })}
            </div>
            <button className="btn small" onClick={() => openModal({ kind: "profile", userId: m.user.id, guildId })}>
              Manage
            </button>
            {can(guildId, P.MANAGE_GUILD) && (
              <button
                className="btn small"
                onClick={() => {
                  const nick = prompt("Nickname (empty to clear)", m.nickname || "");
                  if (nick !== null) api(`/api/guilds/${guildId}/members/${m.user.id}`, { method: "PATCH", body: { nickname: nick || null } }).catch((e) => toast(e.message, "error"));
                }}
              >
                Nickname
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function Invites({ guildId }: { guildId: string }) {
  const [list, setList] = useState<any[]>([]);
  const users = useStore((s) => s.users);
  const load = () => api(`/api/guilds/${guildId}/invites`).then(setList);
  useEffect(() => {
    load();
  }, []);
  return (
    <div>
      <h2>Invites</h2>
      <button className="btn primary" onClick={() => openModal({ kind: "invite", guildId })}>
        Create Invite
      </button>
      <div className="member-table">
        {list.map((i) => (
          <div key={i.code} className="member-trow">
            <code className="grow">{i.code}</code>
            <span className="muted small">by {users[i.creator_id]?.display_name ?? "?"}</span>
            <span className="muted small">
              {i.uses}/{i.max_uses || "∞"} uses
            </span>
            <span className="muted small">{i.expires_at ? "expires " + new Date(i.expires_at).toLocaleString() : "never expires"}</span>
            <button className="btn small" onClick={() => copy(inviteLink(i.code), "Invite copied")}>
              Copy
            </button>
            <button className="btn small red" onClick={() => api(`/api/invites/${i.code}`, { method: "DELETE" }).then(load)}>
              Revoke
            </button>
          </div>
        ))}
        {!list.length && <p className="muted">No active invites.</p>}
      </div>
    </div>
  );
}

function Bans({ guildId }: { guildId: string }) {
  const [list, setList] = useState<any[]>([]);
  const load = () => api(`/api/guilds/${guildId}/bans`).then(setList);
  useEffect(() => {
    load();
  }, []);
  return (
    <div>
      <h2>Bans</h2>
      <div className="member-table">
        {list.map((b) => (
          <div key={b.user_id} className="member-trow">
            <span className="grow bold">{b.username ?? b.user_id}</span>
            <span className="muted small">{b.reason}</span>
            <button className="btn small" onClick={() => api(`/api/guilds/${guildId}/bans/${b.user_id}`, { method: "DELETE" }).then(load)}>
              Unban
            </button>
          </div>
        ))}
        {!list.length && <p className="muted">No one is banned.</p>}
      </div>
    </div>
  );
}

function BotSettings({ guildId }: { guildId: string }) {
  const [s, setS] = useState<any>(null);
  const [status, setStatus] = useState<any>(null);
  const channels = useStore(useShallow((st) => Object.values(st.channels).filter((c) => c.guild_id === guildId && c.kind === "text")));
  const users = useStore((st) => st.users);
  useEffect(() => {
    api(`/api/guilds/${guildId}/bot`).then(setS);
    const poll = () => api("/api/bot").then(setStatus).catch(() => {});
    poll();
    const t = setInterval(poll, 5000);
    return () => clearInterval(t);
  }, [guildId]);
  const save = async (patch: any) => {
    try {
      setS(await api(`/api/guilds/${guildId}/bot`, { method: "PATCH", body: patch }));
    } catch (e: any) {
      toast(e.message, "error");
    }
  };
  if (!s) return <div className="muted">Loading…</div>;
  const backends = (status?.workers?.length || 0) + (status?.server_backend ? 1 : 0);
  return (
    <div>
      <h2>AI Bot — {s.bot_name}</h2>
      <div className="perm-row">
        <div>
          <div className="bold">Enable {s.bot_name} in this server</div>
          <div className="muted small">
            It answers when someone @mentions it, replies to it, or starts a message with its name ("{s.bot_name}, …"). It reads recent channel messages for context.
          </div>
        </div>
        <Toggle on={s.enabled} onChange={(v) => save({ enabled: v })} />
      </div>
      <label>
        Personality / instructions
        <textarea
          rows={5}
          defaultValue={s.system_prompt}
          placeholder={`e.g. You help our clients with questions about their projects. Be friendly and brief. Never share pricing.`}
          onBlur={(e) => e.target.value !== s.system_prompt && save({ system_prompt: e.target.value })}
        />
      </label>
      <div className="profile-section">Always-on channels</div>
      <p className="muted small">In these channels it answers every message, no mention needed.</p>
      <div className="chan-checks">
        {channels.map((c) => (
          <label key={c.id} className="check">
            <input
              type="checkbox"
              checked={s.always_channels.includes(c.id)}
              onChange={(e) => save({ always_channels: e.target.checked ? [...s.always_channels, c.id] : s.always_channels.filter((x: string) => x !== c.id) })}
            />
            #{c.name}
          </label>
        ))}
      </div>
      <div className="profile-section">Where replies are generated</div>
      {status && (
        <div className="backend-list">
          {status.workers.map((w: any, i: number) => (
            <div key={i} className="backend ok">
              <Icon name="cpu" size={16} /> <b>{w.gpu}</b> · {w.model || "model"} · lent by {users[w.user_id]?.display_name ?? "a member"}
              {w.vram_mb ? ` · ${(w.vram_mb / 1024).toFixed(0)} GB` : ""} {w.active_jobs ? "· busy" : ""}
            </div>
          ))}
          <div className={"backend " + (status.server_backend ? "ok" : "off")}>
            <Icon name="cpu" size={16} /> Server llama.cpp {status.server_backend ? "(fallback, configured)" : "— not configured (set PARLEY_LLAMA_URL)"}
          </div>
          {!backends && <div className="form-error">No model available right now. Lend a GPU from User Settings → AI &amp; GPU, or configure the server model.</div>}
          <p className="muted small">
            Lent GPUs are tried first (most free VRAM), then the server. GPU lending is limited to {status.worker_policy === "members" ? "any member" : "instance admins"}; a lent GPU only receives conversations from channels its owner can already read.
          </p>
        </div>
      )}
    </div>
  );
}

// =================== User settings ===================

export function UserSettings({ tab: initial }: { tab?: string }) {
  const [tab, setTab] = useState(initial || "account");
  const me = useStore((s) => s.me)!;
  return (
    <SettingsFrame
      title="User Settings"
      tab={tab}
      setTab={setTab}
      tabs={[
        { id: "account", label: "My Account" },
        { id: "voice", label: "Voice & Video" },
        { id: "ai", label: "AI & GPU", hidden: !window.parleyNative },
        { id: "notifications", label: "Notifications" },
        { id: "sessions", label: "Devices" },
        { id: "admin", label: "Instance Admin", hidden: !me.is_admin },
        { id: "logout", label: "Log Out", danger: true },
      ]}
    >
      {tab === "account" && <Account />}
      {tab === "voice" && <VoiceSettings />}
      {tab === "ai" && <AiSettings />}
      {tab === "notifications" && <NotifSettings />}
      {tab === "sessions" && <Sessions />}
      {tab === "admin" && <Admin />}
      {tab === "logout" && (
        <div>
          <h2>Log out</h2>
          <button className="btn red" onClick={logout}>
            Log Out
          </button>
        </div>
      )}
    </SettingsFrame>
  );
}

function Account() {
  const me = useStore((s) => s.me)!;
  const [name, setName] = useState(me.display_name);
  const [cur, setCur] = useState("");
  const [pw, setPw] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const setAvatar = async (f: File) => {
    try {
      const fo = await upload(f, f.name);
      await api("/api/users/@me", { method: "PATCH", body: { avatar_file_id: fo.id } });
    } catch (e: any) {
      toast(e.message, "error");
    }
  };
  return (
    <div>
      <h2>My Account</h2>
      <div className="row gap center-v">
        <div className="clickable" onClick={() => fileRef.current?.click()} title="Change avatar">
          <Avatar user={me} size={80} />
        </div>
        <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => e.target.files?.[0] && setAvatar(e.target.files[0])} />
        <div>
          <div className="bold big">{me.display_name}</div>
          <div className="muted">@{me.username}</div>
          {me.avatar_file_id && (
            <button className="btn small" onClick={() => api("/api/users/@me", { method: "PATCH", body: { avatar_file_id: null } })}>
              Remove avatar
            </button>
          )}
        </div>
      </div>
      <label>
        Display name
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={32} />
      </label>
      <button className="btn primary" disabled={name === me.display_name || !name.trim()} onClick={() => api("/api/users/@me", { method: "PATCH", body: { display_name: name } }).then(() => toast("Saved"))}>
        Save
      </button>
      <div className="profile-section">Change password</div>
      <label>
        Current password
        <input type="password" value={cur} onChange={(e) => setCur(e.target.value)} />
      </label>
      <label>
        New password
        <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} />
      </label>
      <button
        className="btn"
        disabled={pw.length < 8}
        onClick={() =>
          api("/api/users/@me", { method: "PATCH", body: { current_password: cur, new_password: pw } })
            .then(() => {
              toast("Password changed. Other devices were signed out.");
              setCur("");
              setPw("");
            })
            .catch((e) => toast(e.message, "error"))
        }
      >
        Change Password
      </button>
    </div>
  );
}

function VoiceSettings() {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [, force] = useState(0);
  const [level, setLevel] = useState(0);
  const [testing, setTesting] = useState(false);
  useEffect(() => {
    navigator.mediaDevices
      .getUserMedia({ audio: true })
      .then((s) => s.getTracks().forEach((t) => t.stop()))
      .catch(() => {})
      .finally(() => navigator.mediaDevices.enumerateDevices().then(setDevices));
  }, []);
  useEffect(() => {
    if (!testing) return;
    let stop = false;
    let stream: MediaStream;
    const ctx = new AudioContext();
    navigator.mediaDevices.getUserMedia({ audio: { deviceId: prefs.get("audioInput") || undefined, noiseSuppression: prefs.bool("noiseSuppression"), echoCancellation: prefs.bool("echoCancellation") } }).then((s) => {
      stream = s;
      const an = ctx.createAnalyser();
      ctx.createMediaStreamSource(s).connect(an);
      const buf = new Uint8Array(an.fftSize);
      const tick = () => {
        if (stop) return;
        an.getByteTimeDomainData(buf);
        let peak = 0;
        for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
        setLevel(peak / 128);
        requestAnimationFrame(tick);
      };
      tick();
    });
    return () => {
      stop = true;
      stream?.getTracks().forEach((t) => t.stop());
      ctx.close();
    };
  }, [testing]);
  const set = (k: string, v: string) => {
    prefs.set(k, v);
    force((x) => x + 1);
    applyDevicePrefs();
  };
  const sel = (kind: MediaDeviceKind, key: string, label: string) => (
    <label>
      {label}
      <select value={prefs.get(key)} onChange={(e) => set(key, e.target.value)}>
        <option value="">Default</option>
        {devices
          .filter((d) => d.kind === kind && d.deviceId !== "default")
          .map((d) => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.label || d.deviceId.slice(0, 8)}
            </option>
          ))}
      </select>
    </label>
  );
  const flag = (k: string, label: string, desc: string) => (
    <div className="perm-row">
      <div>
        <div className="bold">{label}</div>
        <div className="muted small">{desc}</div>
      </div>
      <Toggle on={prefs.bool(k)} onChange={(v) => set(k, v ? "1" : "0")} />
    </div>
  );
  return (
    <div>
      <h2>Voice & Video</h2>
      <div className="row gap">
        <div className="grow">{sel("audioinput", "audioInput", "Input device")}</div>
        <div className="grow">{sel("audiooutput", "audioOutput", "Output device")}</div>
      </div>
      <div className="row gap center-v">
        <button className="btn" onClick={() => setTesting(!testing)}>
          {testing ? "Stop test" : "Let's check"}
        </button>
        <div className="meter grow">
          <div style={{ width: `${Math.min(100, level * 140)}%` }} />
        </div>
      </div>
      {sel("videoinput", "videoInput", "Camera")}
      <label>
        Voice quality
        <select value={prefs.get("audioBitrate", "96000")} onChange={(e) => set("audioBitrate", e.target.value)}>
          <option value="32000">32 kbps (low bandwidth)</option>
          <option value="64000">64 kbps (Discord default)</option>
          <option value="96000">96 kbps (high)</option>
          <option value="128000">128 kbps (studio)</option>
          <option value="256000">256 kbps (music)</option>
        </select>
      </label>
      {flag("noiseSuppression", "Noise suppression", "Filter background noise (keyboard, fans)")}
      {flag("echoCancellation", "Echo cancellation", "Turn off if you use headphones and want the most natural sound")}
      {flag("autoGainControl", "Automatic gain control", "Keep your volume level consistent")}
      <p className="muted small">Changes to processing apply the next time you join voice. Global hotkeys: Ctrl+Shift+M mute, Ctrl+Shift+D deafen.</p>
    </div>
  );
}

function AiSettings() {
  const ai = useAi();
  const c = ai.config;
  const [showLog, setShowLog] = useState(false);
  useEffect(() => {
    refreshGpus();
  }, []);
  const set = (patch: Partial<AiConfig>) => saveAiConfig({ ...c, ...patch });
  const gpu = chosenGpu(ai);
  const pick = async (key: "serverPath" | "modelPath") => {
    const p = await window.parleyNative?.pickFile(
      key === "serverPath"
        ? { title: "Select llama-server.exe", filters: [{ name: "llama-server", extensions: ["exe", ""] }] }
        : { title: "Select a GGUF model", filters: [{ name: "GGUF model", extensions: ["gguf"] }] },
    );
    if (p) set({ [key]: p } as any);
  };
  const st = ai.status.state;

  if (!c.consent) {
    return (
      <div>
        <h2>AI & GPU</h2>
        <div className="consent-box">
          <h3>Lend this PC's graphics card to the server's AI bot?</h3>
          <ul>
            <li>Parley will run <b>llama.cpp</b> on your best GPU{gpu ? ` (${gpu.name}${gpu.vram_mb ? `, ${(gpu.vram_mb / 1024).toFixed(0)} GB` : ""})` : ""} using a model file you choose.</li>
            <li>When someone talks to the bot, the server sends the recent conversation to <b>this PC</b> to write the reply. Only conversations from channels you can already read are sent here.</li>
            <li>It uses VRAM, power and some GPU time while answering. Games may stutter if a reply is generating.</li>
            <li>Nothing leaves your network except through your own Parley server. You can turn it off anytime.</li>
          </ul>
          <div className="row gap">
            <button className="btn primary" onClick={() => set({ consent: true })}>
              I agree — set it up
            </button>
            <button className="btn" onClick={closeModal}>
              Not now
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <h2>AI & GPU</h2>
      <div className="perm-row">
        <div>
          <div className="bold">Lend my GPU to the AI bot</div>
          <div className="muted small">
            {ai.registered ? `Serving the bot · ${ai.served} replies this session${ai.active ? " · generating now" : ""}` : ai.rejected ? ai.rejected : st === "ready" ? "Model loaded — connecting to server…" : "Starts llama-server when the app launches."}
          </div>
        </div>
        <Toggle on={c.enabled} onChange={(v) => setLending(v)} />
      </div>

      <div className="kind-pick">
        {(["managed", "external"] as const).map((m) => (
          <label key={m} className={"kind-opt" + (c.mode === m ? " on" : "")}>
            <input type="radio" checked={c.mode === m} onChange={() => set({ mode: m })} />
            <Icon name={m === "managed" ? "cpu" : "link"} size={20} />
            <div>
              <b>{m === "managed" ? "Parley runs llama-server" : "Use my running llama-server"}</b>
              <div className="muted small">{m === "managed" ? "Pick the exe + model; pinned to your best GPU" : "Point at a server you already run (LM setups, custom flags)"}</div>
            </div>
          </label>
        ))}
      </div>

      {c.mode === "managed" ? (
        <>
          <label>
            GPU
            <select value={c.gpuIndex ?? ""} onChange={(e) => set({ gpuIndex: e.target.value === "" ? null : Number(e.target.value) })}>
              <option value="">Auto — best card{ai.gpus[0] ? ` (${ai.gpus[0].name})` : ""}</option>
              {ai.gpus.map((g) => (
                <option key={g.index} value={g.index}>
                  #{g.index} {g.name} {g.vram_mb ? `· ${(g.vram_mb / 1024).toFixed(0)} GB${g.approximate ? "?" : ""}` : ""}
                </option>
              ))}
            </select>
          </label>
          <label>
            llama-server executable
            <div className="copy-row">
              <input value={c.serverPath} onChange={(e) => set({ serverPath: e.target.value })} placeholder="C:\llama.cpp\llama-server.exe" />
              <button className="btn" onClick={() => pick("serverPath")}>
                Browse
              </button>
            </div>
          </label>
          <p className="muted small">Use the CUDA build of llama.cpp for NVIDIA cards (llama-…-bin-win-cuda-x64.zip from the llama.cpp releases page).</p>
          <label>
            Model (.gguf)
            <div className="copy-row">
              <input value={c.modelPath} onChange={(e) => set({ modelPath: e.target.value })} placeholder="D:\models\Qwen3-14B-Q4_K_M.gguf" />
              <button className="btn" onClick={() => pick("modelPath")}>
                Browse
              </button>
            </div>
          </label>
          <div className="row gap">
            <label className="grow">
              Context size
              <select value={c.ctx} onChange={(e) => set({ ctx: Number(e.target.value) })}>
                {[4096, 8192, 16384, 32768, 65536].map((n) => (
                  <option key={n} value={n}>
                    {n.toLocaleString()} tokens
                  </option>
                ))}
              </select>
            </label>
            <label className="grow">
              Local port
              <input type="number" value={c.port} onChange={(e) => set({ port: Number(e.target.value) })} />
            </label>
          </div>
          <label className="check">
            <input type="checkbox" checked={c.flashAttn} onChange={(e) => set({ flashAttn: e.target.checked })} /> Flash attention (faster, less VRAM)
          </label>
          <label className="check">
            <input type="checkbox" checked={c.jinja} onChange={(e) => set({ jinja: e.target.checked })} /> Use the model's chat template (--jinja)
          </label>
          <label>
            Extra arguments <span className="muted small">(advanced)</span>
            <input value={c.extraArgs} onChange={(e) => set({ extraArgs: e.target.value })} placeholder="--threads 8 --cache-type-k q8_0" />
          </label>
        </>
      ) : (
        <label>
          llama-server URL
          <input value={c.externalUrl} onChange={(e) => set({ externalUrl: e.target.value })} placeholder="http://127.0.0.1:8080" />
        </label>
      )}

      <div className="row gap center-v">
        <span className={"llm-state " + st}>
          ● {st === "ready" ? `Ready — ${ai.status.model}` : st === "starting" ? "Loading model…" : st === "error" ? "Error" : "Stopped"}
        </span>
        <div className="grow" />
        {st === "off" || st === "error" ? (
          <button className="btn primary" onClick={startLocalModel}>
            Start
          </button>
        ) : (
          <button className="btn" onClick={stopLocalModel}>
            Stop
          </button>
        )}
        <button className="btn" onClick={() => setShowLog(!showLog)}>
          {showLog ? "Hide log" : "Show log"}
        </button>
      </div>
      {ai.status.error && <div className="form-error">{ai.status.error}</div>}
      {showLog && <pre className="llm-log">{ai.log.join("\n") || "(no output yet)"}</pre>}
      <button className="btn link small" onClick={() => (setLending(false), set({ consent: false, enabled: false }))}>
        Withdraw consent
      </button>
    </div>
  );
}

function NotifSettings() {
  const [, force] = useState(0);
  const flag = (k: string, label: string, desc: string) => (
    <div className="perm-row">
      <div>
        <div className="bold">{label}</div>
        <div className="muted small">{desc}</div>
      </div>
      <Toggle
        on={localStorage.getItem("parley." + k) !== "off"}
        onChange={(v) => {
          localStorage.setItem("parley." + k, v ? "on" : "off");
          force((x) => x + 1);
        }}
      />
    </div>
  );
  return (
    <div>
      <h2>Notifications</h2>
      {flag("notifications", "Desktop notifications", "For direct messages and @mentions when you're not looking at that channel")}
      {flag("sounds", "Sounds", "Message, join/leave, and mute sounds")}
      <p className="muted small">Set your status to Do Not Disturb (click your avatar) to silence everything.</p>
      {window.parleyNative && (
        <div className="perm-row">
          <div>
            <div className="bold">Open Parley when Windows starts</div>
          </div>
          <Toggle
            on={localStorage.getItem("parley.autostart") === "1"}
            onChange={(v) => {
              localStorage.setItem("parley.autostart", v ? "1" : "0");
              window.parleyNative!.setAutostart(v);
              force((x) => x + 1);
            }}
          />
        </div>
      )}
    </div>
  );
}

function Sessions() {
  const [list, setList] = useState<any[]>([]);
  useEffect(() => {
    api("/api/users/@me/sessions").then(setList);
  }, []);
  return (
    <div>
      <h2>Devices</h2>
      <p className="muted small">Places you're signed in. Changing your password signs out all other devices.</p>
      <div className="member-table">
        {list.map((s) => (
          <div key={s.id} className="member-trow">
            <span className="grow bold">{s.device_name || "Unknown device"}</span>
            {s.current && <span className="role-chip has">This device</span>}
            <span className="muted small">last active {new Date(s.last_seen).toLocaleString()}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Admin() {
  const [users, setUsers] = useState<User[]>([]);
  const [code, setCode] = useState("");
  const load = () => api("/api/admin/users").then(setUsers);
  useEffect(() => {
    load();
  }, []);
  return (
    <div>
      <h2>Instance Admin</h2>
      <div className="profile-section">Account invites</div>
      <p className="muted small">Creates an account invite that doesn't join any server (single use).</p>
      <div className="row gap">
        <button className="btn" onClick={() => api("/api/admin/invites", { body: { max_uses: 1 } }).then((r) => setCode(r.code))}>
          New account invite
        </button>
        <button className="btn" onClick={() => api("/api/admin/invites", { body: { max_uses: 1, grants_admin: true } }).then((r) => setCode(r.code))}>
          New admin invite
        </button>
        {code && (
          <button className="btn primary" onClick={() => copy(inviteLink(code), "Invite copied")}>
            Copy {code}
          </button>
        )}
      </div>
      <div className="profile-section">Users — {users.length}</div>
      <div className="member-table">
        {users.map((u) => (
          <div key={u.id} className="member-trow">
            <Avatar user={u} size={28} />
            <span className="grow">
              <b>{u.display_name}</b> <span className="muted">@{u.username}</span> {u.is_admin && <span className="role-chip has">admin</span>} {u.is_bot && <BotTag />}
            </span>
            {!u.is_bot && (
              <>
                <button
                  className="btn small"
                  onClick={() =>
                    api(`/api/admin/users/${u.id}/reset-password`, { method: "POST" }).then((r) =>
                      openModal({ kind: "confirm", title: "Temporary password", body: `Give ${u.username} this password: ${r.temporary_password}`, confirmLabel: "Copy & close", onConfirm: () => copy(r.temporary_password) }),
                    )
                  }
                >
                  Reset password
                </button>
                <button
                  className="btn small red"
                  onClick={() => openModal({ kind: "confirm", title: `Delete ${u.username}?`, body: "Their messages stay (as Deleted User); they can't sign in.", danger: true, confirmLabel: "Delete", onConfirm: () => api(`/api/admin/users/${u.id}`, { method: "DELETE" }).then(load) })}
                >
                  Delete
                </button>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
