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
import { ModelPicker } from "./ModelPicker";

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
            <Icon name="cpu" size={16} /> Server llama.cpp {status.server_backend ? "(fallback, configured)" : "— not configured (set LLAMBLE_LLAMA_URL)"}
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
        { id: "ai", label: "AI & GPU", hidden: !window.llambleNative },
        { id: "notifications", label: "Notifications" },
        { id: "sessions", label: "Devices" },
        { id: "admin", label: "Instance Admin", hidden: !me.is_admin },
        { id: "server", label: "Server", hidden: !me.is_admin },
        { id: "aimodel", label: "AI Model", hidden: !me.is_admin },
        { id: "remote", label: "Remote Access", hidden: !me.is_admin },
        { id: "logout", label: "Log Out", danger: true },
      ]}
    >
      {tab === "account" && <Account />}
      {tab === "voice" && <VoiceSettings />}
      {tab === "ai" && <AiSettings />}
      {tab === "notifications" && <NotifSettings />}
      {tab === "sessions" && <Sessions />}
      {tab === "admin" && <Admin />}
      {tab === "remote" && <RemoteAccess />}
      {tab === "server" && <ServerConfig />}
      {tab === "aimodel" && (
        <div>
          <h2>AI Model (on this server)</h2>
          <p className="muted small">Runs on the NAS whenever nobody is lending a GPU. Downloads come from Hugging Face once, then everything runs locally.</p>
          <ModelPicker />
          <GpuSharing />
        </div>
      )}
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
    const p = await window.llambleNative?.pickFile(
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
            <li>Llamble will run <b>llama.cpp</b> on your best GPU{gpu ? ` (${gpu.name}${gpu.vram_mb ? `, ${(gpu.vram_mb / 1024).toFixed(0)} GB` : ""})` : ""} using a model file you choose.</li>
            <li>When someone talks to the bot, the server sends the recent conversation to <b>this PC</b> to write the reply. Only conversations from channels you can already read are sent here.</li>
            <li>It uses VRAM, power and some GPU time while answering. Games may stutter if a reply is generating.</li>
            <li>Nothing leaves your network except through your own Llamble server. You can turn it off anytime.</li>
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
            {ai.rejected
              ? ai.rejected
              : !c.enabled
                ? "Off. Your GPU is never used."
                : ai.pauseReason
                  ? `Paused: ${ai.pauseReason}. The server uses the next-best GPU (or its own model) meanwhile.${st === "off" ? " Model unloaded, VRAM freed." : ""}`
                  : ai.registered
                    ? `Available to the server · ${ai.served} replies this session${ai.active ? " · generating now" : ""}`
                    : st === "starting"
                      ? "Loading the model…"
                      : "Waiting until this PC is idle…"}
          </div>
        </div>
        <Toggle on={c.enabled} onChange={(v) => setLending(v)} />
      </div>

      <div className="profile-section">When to lend</div>
      <div className="perm-row">
        <div>
          <div className="bold">Only while I'm away</div>
          <div className="muted small">Lend only after this PC has had no keyboard or mouse input for a while, or is locked.</div>
        </div>
        <div className="row gap center-v">
          {c.idleOnly && (
            <select value={c.idleMinutes} onChange={(e) => set({ idleMinutes: Number(e.target.value) })} style={{ width: 120 }}>
              {[2, 5, 10, 15, 30].map((n) => (
                <option key={n} value={n}>
                  {n} min idle
                </option>
              ))}
            </select>
          )}
          <Toggle on={c.idleOnly} onChange={(v) => set({ idleOnly: v })} />
        </div>
      </div>
      <div className="perm-row">
        <div>
          <div className="bold">Pause while my GPU is busy (games)</div>
          <div className="muted small">
            If something else is using the GPU (over {c.busyThreshold}%), pause and unload the model so the game gets all the VRAM back. Now: {ai.gpuUtil ?? "?"}% · idle {Math.floor(ai.idleSeconds / 60)} min
          </div>
        </div>
        <Toggle on={c.pauseWhenBusy} onChange={(v) => set({ pauseWhenBusy: v })} />
      </div>
      <p className="muted small">The server always uses the best GPU among everyone currently lending, and falls back to its own model when nobody is available.</p>

      <div className="profile-section">How to run the model</div>
      <div className="kind-pick">
        {(["managed", "external"] as const).map((m) => (
          <label key={m} className={"kind-opt" + (c.mode === m ? " on" : "")}>
            <input type="radio" checked={c.mode === m} onChange={() => set({ mode: m })} />
            <Icon name={m === "managed" ? "cpu" : "link"} size={20} />
            <div>
              <b>{m === "managed" ? "Llamble runs llama-server" : "Use my running llama-server"}</b>
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
        on={localStorage.getItem("llamble." + k) !== "off"}
        onChange={(v) => {
          localStorage.setItem("llamble." + k, v ? "on" : "off");
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
      {window.llambleNative && (
        <div className="perm-row">
          <div>
            <div className="bold">Open Llamble when Windows starts</div>
          </div>
          <Toggle
            on={localStorage.getItem("llamble.autostart") === "1"}
            onChange={(v) => {
              localStorage.setItem("llamble.autostart", v ? "1" : "0");
              window.llambleNative!.setAutostart(v);
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

function GpuSharing() {
  const [pool, setPool] = useState<any>(null);
  const load = () => api("/api/admin/gpu").then(setPool).catch(() => {});
  useEffect(() => {
    load();
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, []);
  if (!pool) return null;
  const setPolicy = (policy: string) => api("/api/admin/gpu", { method: "PATCH", body: { policy } }).then(load).catch((e) => toast(e.message, "error"));
  return (
    <div>
      <h2 style={{ marginTop: 28 }}>GPU sharing</h2>
      <p className="muted small">
        Members can offer their graphics card from their app (User Settings → AI &amp; GPU). The bot always uses the <b>best available</b> one, switches when its owner starts using
        their PC, starts a game, or logs off, and falls back to this server's own model when none are free.
      </p>
      <div className="perm-row">
        <div>
          <div className="bold">Who can lend a GPU</div>
          <div className="muted small">A lent GPU only ever receives conversations from channels its owner can already read.</div>
        </div>
        <select value={pool.policy} onChange={(e) => setPolicy(e.target.value)} style={{ width: 200 }}>
          <option value="off">Off (server only)</option>
          <option value="admins">Admins only</option>
          <option value="members">Any member</option>
        </select>
      </div>
      <div className="backend-list" style={{ marginTop: 12 }}>
        {pool.workers.map((w: any) => (
          <div key={w.user_id + w.gpu} className={"backend " + (w.available ? "ok" : "off")}>
            <Icon name="cpu" size={16} />
            <b>{w.gpu}</b>
            {w.vram_mb ? ` · ${(w.vram_mb / 1024).toFixed(0)} GB` : ""} · {w.name ?? "member"}
            <span className="grow" />
            {w.in_use ? <span className="role-chip has">in use</span> : w.available ? <span className="muted small">standby</span> : <span className="muted small">paused: {w.reason || "busy"}</span>}
          </div>
        ))}
        <div className={"backend " + (pool.server_model?.state === "ready" ? "ok" : "off")}>
          <Icon name="cpu" size={16} /> <b>This server</b> · {pool.server_model?.state === "ready" ? `${pool.server_model.repo?.split("/")[1]} ${pool.server_model.quant}` : "no model loaded"}
          <span className="grow" />
          {!pool.workers.some((w: any) => w.in_use) && pool.server_model?.state === "ready" && <span className="role-chip has">in use</span>}
        </div>
      </div>
    </div>
  );
}

function nasAddress() {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(location.hostname)) return location.hostname;
  try {
    const h = new URL(localStorage.getItem("llamble.server") || "").hostname;
    return /^\d+\.\d+\.\d+\.\d+$/.test(h) ? h : "";
  } catch {
    return "";
  }
}

function ServerConfig() {
  const [d, setD] = useState<any>(null);
  const [f, setF] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const load = () =>
    api("/api/admin/settings").then((x) => {
      setD(x);
      return x;
    });
  useEffect(() => {
    load().then((x) => setF({ ...x.settings, lan_ip: x.settings.lan_ip || "" }));
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, []);
  if (!d || !f) return <div className="muted">Loading…</div>;
  const set = (k: string, v: any) => setF({ ...f, [k]: v });
  const save = async () => {
    setBusy(true);
    try {
      const r = await api("/api/admin/settings", { method: "PUT", body: f });
      setF({ ...r.settings, lan_ip: r.settings.lan_ip || "" });
      toast("Saved");
      load();
    } catch (e: any) {
      toast(e.message, "error");
    } finally {
      setBusy(false);
    }
  };
  const v = d.voice || {};
  const voiceText: Record<string, string> = {
    running: `running · media at ${v.media_address}`,
    starting: "starting…",
    "no-address": "waiting for the server's home-network address (set it below)",
    external: "using an external LiveKit server (set in the server's environment)",
    error: v.error || "stopped",
    off: "not available in this build",
  };
  return (
    <div>
      <h2>Server</h2>
      <p className="muted small">Settings for the Llamble server itself (your NAS). Changes apply right away, no restart.</p>
      <div className={"rs " + (v.state === "running" || v.state === "external" ? "ok" : v.state === "error" ? "err" : "off")}>
        <b>Voice &amp; video</b> {voiceText[v.state] ?? v.state}
      </div>

      <div className="profile-section">Network</div>
      <label>
        Server's home-network address
        <input value={f.lan_ip} onChange={(e) => set("lan_ip", e.target.value)} placeholder={nasAddress() || "192.168.1.20"} />
      </label>
      <p className="muted small">Calls use this to reach the server at home. Llamble fills it in automatically the first time you connect by IP; only change it if your NAS's address changes.</p>

      <div className="profile-section">Files</div>
      <label>
        Largest upload (MB)
        <input type="number" min={1} max={20000} value={f.max_upload_mb} onChange={(e) => set("max_upload_mb", Number(e.target.value))} />
      </label>
      <div className="perm-row">
        <div>
          <div className="bold">Link previews</div>
          <div className="muted small">Show a preview card for links posted in chat (the server fetches the page).</div>
        </div>
        <input type="checkbox" className="switch" checked={f.unfurl_links} onChange={(e) => set("unfurl_links", e.target.checked)} />
      </div>

      <div className="profile-section">People</div>
      <div className="perm-row">
        <div>
          <div className="bold">Who can create new servers</div>
          <div className="muted small">Servers are the groups in the left sidebar.</div>
        </div>
        <select value={f.guild_create} onChange={(e) => set("guild_create", e.target.value)} style={{ width: 200 }}>
          <option value="admin">Admins only</option>
          <option value="all">Anyone with an account</option>
        </select>
      </div>

      <div className="profile-section">AI bot</div>
      <label>
        Bot name
        <input value={f.bot_name} maxLength={32} onChange={(e) => set("bot_name", e.target.value)} />
      </label>
      <p className="muted small">People can call it by this name in chat.</p>

      <div className="profile-section">Recording</div>
      <div className="perm-row">
        <div>
          <div className="bold">Allow recording on the server</div>
          <div className="muted small">Lets show recordings be saved on the NAS instead of a member's PC. Everyone included is always asked first.</div>
        </div>
        <input type="checkbox" className="switch" checked={f.allow_server_recording} onChange={(e) => set("allow_server_recording", e.target.checked)} />
      </div>

      <div className="row gap" style={{ marginTop: 16 }}>
        <button className="btn primary" disabled={busy} onClick={save}>
          Save changes
        </button>
      </div>
    </div>
  );
}

function PortTable({ rows, to }: { rows: [string, string, string, string][]; to: string }) {
  return (
    <table className="ports">
      <thead>
        <tr>
          <th>Outside port</th>
          <th>Protocol</th>
          <th>To</th>
          <th>For</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(([out, proto, inner, what]) => (
          <tr key={out + proto}>
            <td>{out}</td>
            <td>{proto}</td>
            <td>
              {to} : {inner}
            </td>
            <td>{what}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function RemoteAccess() {
  const [r, setR] = useState<any>(null);
  const [mode, setMode] = useState<"off" | "direct" | "relay">("off");
  const [domain, setDomain] = useState("");
  const [pw, setPw] = useState("");
  const [email, setEmail] = useState("");
  const [relayAddr, setRelayAddr] = useState("");
  const [busy, setBusy] = useState(false);
  const load = () =>
    api("/api/admin/remote").then((d) => {
      setR(d);
      return d;
    });
  useEffect(() => {
    load().then((d) => {
      setDomain(d.domain || "");
      setEmail(d.email || "");
      setRelayAddr(d.relay_addr || "");
      setMode(d.enabled ? d.mode : "off");
    });
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, []);
  if (!r) return <div className="muted">Loading…</div>;
  const nasIp = nasAddress() || "your NAS's IP";
  const p = r.ports;
  const save = async (extra: any = {}) => {
    setBusy(true);
    try {
      const on = mode !== "off";
      await api("/api/admin/remote", {
        method: "PUT",
        body: { enabled: on, mode: on ? mode : r.mode, domain: on ? domain : r.domain, ddns_password: pw || undefined, email, relay_addr: relayAddr, ...extra },
      });
      setPw("");
      toast(on ? "Saved, connecting…" : "Remote access turned off");
      load();
    } catch (e: any) {
      toast(e.message, "error");
    } finally {
      setBusy(false);
    }
  };
  const st = r.status || {};
  const active = r.enabled ? r.mode : "off";
  const dot = (state: string) => (state === "ok" || state === "ready" || state === "connected" ? "ok" : state === "error" ? "err" : "off");
  const choice = (id: "off" | "direct" | "relay", title: string, desc: string) => (
    <button className={"mode-card" + (mode === id ? " on" : "")} onClick={() => setMode(id)}>
      <div className="bold">
        {title} {active === id && <span className="role-chip has">current</span>}
      </div>
      <div className="muted small">{desc}</div>
    </button>
  );
  const domainField = (
    <>
      <label>
        Address people will use
        <input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="chat.example.com" />
      </label>
      <label>
        Your email <span className="muted">(optional; Let's Encrypt emails you only if a certificate has problems)</span>
        <input value={email} onChange={(e) => setEmail(e.target.value)} />
      </label>
    </>
  );
  return (
    <div className="remote">
      <h2>Remote Access</h2>
      <p className="muted small">How people outside your home reach this server. Everyone uses an address you own (like chat.example.com) with HTTPS.</p>
      <div className="mode-cards">
        {choice("off", "Home only", "Only devices on your home network can connect.")}
        {choice("direct", "Direct", "Forward ports on your router. Free, fastest. Your home IP is visible to people who look up your address.")}
        {choice("relay", "Through your own relay", "Rent a small server (VPS) and run one command on it. Hides your home IP, no router setup.")}
      </div>

      {mode === "off" && (
        <div className="row gap" style={{ marginTop: 12 }}>
          {active !== "off" && (
            <button className="btn primary" disabled={busy} onClick={() => save()}>
              Turn off remote access
            </button>
          )}
        </div>
      )}

      {mode === "direct" && (
        <>
          <div className="remote-step">
            <div className="step-num">1</div>
            <div className="grow">
              <div className="bold">At your domain registrar: turn on Dynamic DNS</div>
              <p className="muted small">Your internet provider changes your home IP now and then; Dynamic DNS keeps your address pointed at it. Steps for Namecheap:</p>
              <ol className="small">
                <li>Domain List → <b>Manage</b> next to your domain → <b>Advanced DNS</b>.</li>
                <li>Add New Record → <b>A + Dynamic DNS Record</b>. Host: <code>chat</code>, Value: <code>127.0.0.1</code> (Llamble replaces it) → ✓ save.</li>
                <li>Further down, switch <b>Dynamic DNS</b> on and copy the <b>Dynamic DNS Password</b>.</li>
              </ol>
            </div>
          </div>
          <div className="remote-step">
            <div className="step-num">2</div>
            <div className="grow">
              <div className="bold">Tell Llamble</div>
              {domainField}
              <label>
                Namecheap Dynamic DNS password {r.has_ddns_password && <span className="green">· saved</span>}
                <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder={r.has_ddns_password ? "(leave blank to keep the saved one)" : "paste it here"} />
              </label>
              <button className="btn primary" disabled={busy || !domain} onClick={() => save()}>
                {active === "direct" ? "Save" : "Turn on direct access"}
              </button>
            </div>
          </div>
          <div className="remote-step">
            <div className="step-num">3</div>
            <div className="grow">
              <div className="bold">On your router: forward these ports to {nasIp}</div>
              <p className="muted small">Usually under "Port Forwarding" or "Virtual Servers" in the router's settings. Spectrum and Windstream app routers have it under Advanced.</p>
              <PortTable
                to={nasIp}
                rows={[
                  ["443", "TCP", String(p.https), "Chat, files, web app, call setup, certificate"],
                  [String(p.voice_tcp), "TCP", String(p.voice_tcp), "Voice/video fallback"],
                  [String(p.voice_udp), "UDP", String(p.voice_udp), "Voice/video"],
                ]}
              />
            </div>
          </div>
        </>
      )}

      {mode === "relay" && (
        <>
          <div className="remote-step">
            <div className="step-num">1</div>
            <div className="grow">
              <div className="bold">Get a small server (VPS)</div>
              <p className="muted small">
                Any Linux VPS with Docker works. The relay only passes traffic along, so the smallest plan is plenty: Oracle Cloud's Always Free tier, or about $4–6/month from Hetzner, Vultr or DigitalOcean.
                In the provider's firewall, allow TCP {`443, ${p.relay_control}, ${p.voice_tcp}`} and UDP {p.voice_udp}.
              </p>
            </div>
          </div>
          <div className="remote-step">
            <div className="step-num">2</div>
            <div className="grow">
              <div className="bold">Run this on the VPS</div>
              <pre className="cmd" onClick={() => copy(r.relay_command, "Command copied")}>
                {r.relay_command}
              </pre>
              <div className="row gap">
                <button className="btn" onClick={() => copy(r.relay_command, "Command copied")}>
                  Copy command
                </button>
                <button
                  className="btn"
                  onClick={() =>
                    openModal({ kind: "confirm", title: "Make a new relay key?", body: "The current relay stops accepting this server until you run the new command on the VPS.", confirmLabel: "New key", onConfirm: () => save({ new_relay_token: true }) })
                  }
                >
                  New key
                </button>
              </div>
              <p className="muted small">The key in this command is what lets your server (and only yours) use the relay. Treat it like a password.</p>
            </div>
          </div>
          <div className="remote-step">
            <div className="step-num">3</div>
            <div className="grow">
              <div className="bold">Point your address at the VPS, then tell Llamble</div>
              <p className="muted small">At your registrar, add an <b>A record</b>: host <code>chat</code> → the VPS's IP address. This only needs doing once; the VPS's IP doesn't change.</p>
              <label>
                VPS address (IP)
                <input value={relayAddr} onChange={(e) => setRelayAddr(e.target.value)} placeholder="203.0.113.10" />
              </label>
              {domainField}
              <button className="btn primary" disabled={busy || !domain || !relayAddr} onClick={() => save()}>
                {active === "relay" ? "Save" : "Turn on relay"}
              </button>
            </div>
          </div>
        </>
      )}

      {r.enabled && mode === active && (
        <div className="remote-status">
          {active === "direct" ? (
            <div className={"rs " + dot(st.ddns_state)}>
              <b>Address</b> {st.ddns_state === "ok" ? `${r.domain} → ${st.ddns_ip} (checked ${new Date(st.ddns_at).toLocaleTimeString()})` : st.ddns_state === "error" ? st.ddns_error : "not set up"}
            </div>
          ) : (
            <div className={"rs " + dot(st.relay_state)}>
              <b>Relay</b> {st.relay_state === "connected" ? `connected to ${r.relay_addr}` : st.relay_state === "connecting" ? "connecting…" : st.relay_error || "not connected"}
            </div>
          )}
          <div className={"rs " + dot(r.voice?.state === "running" ? "ok" : r.voice?.state)}>
            <b>Calls</b> {r.voice?.state === "running" ? `reachable at ${r.voice.media_address}` : r.voice?.state}
          </div>
          <div className={"rs " + dot(st.tls_state)}>
            <b>HTTPS certificate</b>{" "}
            {st.tls_state === "ready"
              ? "active, renews automatically"
              : st.tls_state === "obtaining"
                ? "requesting from Let's Encrypt…"
                : st.tls_state === "error"
                  ? active === "direct"
                    ? "not yet: Let's Encrypt couldn't reach this server. Check that port 443 is forwarded (step 3). It retries automatically."
                    : "not yet: waiting for the relay and your address to point at the VPS. It retries automatically."
                  : "off"}
          </div>
          {st.tls_state === "ready" && (
            <p className="small">
              ✅ People outside can now use <b>https://{r.domain}</b> in the app or a browser (Chromebooks too). New invites use this address.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
