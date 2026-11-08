import { GamesSettings } from "./Games";
import { PerformanceSettings } from "./Performance";
import { CODEC_LABELS, clearBad, codecChoice, describe, hardwareEncoders, setCodecChoice, useEncoder, type CodecChoice } from "../encoder";
import { closePopout, openPopout, popoutSupported, setOverlayPrefs, setWidget, useOverlayPrefs, usePopout, type WidgetId } from "../overlay";
import { useShallow } from "zustand/react/shallow";
import React, { useEffect, useRef, useState } from "react";
import { api, formatBytes, upload } from "../api";
import { chosenGpu, preparePictures, refreshGpus, saveAiConfig, setLending, startLocalModel, stopLocalModel, useAi, type AiConfig } from "../aiWorker";
import { can, guildPerms, memberName, useStore } from "../store";
import { GUEST_DENY, P, PERM_LABELS, type Role, type User } from "../types";
import { closeModal, copy, openModal, toast } from "../ui";
import { SHARE_LABELS, SHARE_ORDER, applyDevicePrefs, cameraAllowed, defaultShareQuality, prefs, setDefaultShareQuality, shareAllowed, type ShareQuality } from "../voice";
import { Avatar, BotTag, GuildIcon, Icon, Toggle } from "./common";
import { inviteLink } from "./Modals";
import { logout } from "../App";
import { ModelPicker } from "./ModelPicker";
import { Family, ResetRequests } from "./Family";
import { RecoveryCodeSection } from "./Recovery";
import { CameraFxPicker } from "./CameraFx";
import { PicturesAdmin } from "./PicturesAdmin";
import { BotToolsAdmin, GuildVoiceListen, MicTest, VoiceAiAdmin } from "./VoiceAi";
import { Recordings } from "./Show";

/** Shows the problem instead of a blank window when a settings page crashes. */
class PageGuard extends React.Component<{ children: React.ReactNode; page: string }, { err: Error | null }> {
  state = { err: null as Error | null };
  static getDerivedStateFromError(err: Error) {
    return { err };
  }
  componentDidUpdate(prev: { page: string }) {
    if (prev.page !== this.props.page && this.state.err) this.setState({ err: null });
  }
  render() {
    if (!this.state.err) return this.props.children;
    const cfg = useStore.getState().config;
    return (
      <div>
        <h2>This page didn't load</h2>
        <p className="muted">{this.state.err.message}</p>
        {cfg.version && cfg.version !== __APP_VERSION__ && (
          <p>
            The Llamble server is on version {cfg.version} and this app is {__APP_VERSION__}. Update the server on the NAS (see Settings → Server for how), then try again.
          </p>
        )}
        <button className="btn" onClick={() => this.setState({ err: null })}>
          Try again
        </button>
      </div>
    );
  }
}

type TabSpec = { id: string; label: string; hidden?: boolean; danger?: boolean; section?: boolean };

function SettingsFrame({ tabs, tab, setTab, children, title }: { tabs: TabSpec[]; tab: string; setTab: (t: string) => void; children: React.ReactNode; title: string }) {
  return (
    <div className="settings">
      <nav className="settings-nav">
        <div className="settings-nav-title">{title}</div>
        {tabs
          .filter((t) => !t.hidden)
          .map((t) =>
            t.section ? (
              <div key={t.id} className="settings-nav-title section">
                {t.label}
              </div>
            ) : (
              <button key={t.id} className={(tab === t.id ? "on " : "") + (t.danger ? "danger" : "")} onClick={() => setTab(t.id)}>
                {t.label}
              </button>
            ),
          )}
      </nav>
      <section className="settings-body">
        <button className="settings-close" onClick={closeModal} title="Close (Esc)">
          <Icon name="x" size={22} />
        </button>
        <PageGuard page={tab}>{children}</PageGuard>
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
          {!["Admin", "Supervisor", "Moderator", "Guest"].every((n) => roles.some((r) => r.name === n)) && (
            <button
              className="btn small"
              title="Admin, Supervisor, Moderator and Guest"
              onClick={() => api(`/api/guilds/${guildId}/roles/presets`, { method: "POST" }).then((r) => toast(r.added.length ? `Added ${r.added.join(", ")}` : "Already there"))}
            >
              Add standard roles
            </button>
          )}
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
            {role.id !== guildId && (
              <div className="perm-row">
                <div>
                  <div className="bold">Guest (read & listen only)</div>
                  <div className="muted small">People with this role can read and join voice to listen, but can't post, react, talk or share video, whatever other roles they have.</div>
                </div>
                <Toggle on={((role.deny || 0) & GUEST_DENY) === GUEST_DENY} onChange={(on) => patch({ deny: on ? GUEST_DENY : 0 })} />
              </div>
            )}
            {role.name === "Supervisor" && <p className="muted small">Supervisor is meant to be tuned: switch on whichever admin powers you want your supervisors to have.</p>}
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
      <GuildVoiceListen guildId={guildId} botEnabled={s.enabled} value={!!s.voice_listen} onChange={(v) => setS({ ...s, voice_listen: v })} />
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
          {!backends && <div className="form-error">No model available right now. Lend a GPU from My Settings → Lend My GPU, or configure the server model.</div>}
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
      title="My Settings"
      tab={tab}
      setTab={setTab}
      tabs={[
        { id: "account", label: "My Account" },
        { id: "voice", label: "Voice & Video" },
        { id: "ai", label: "Lend My GPU", hidden: !window.llambleNative },
        { id: "notifications", label: "Notifications" },
        { id: "overlay", label: "Overlay" },
        { id: "games", label: "Games", hidden: !window.llambleNative?.games },
        { id: "performance", label: "Performance", hidden: !window.llambleNative?.metrics },
        { id: "recordings", label: "Recordings" },
        { id: "sessions", label: "Devices" },
        { id: "family", label: "Family", hidden: !!me.is_kid },
        // the Llamble server itself (the NAS): not the "servers" people chat in
        { id: "nas-section", label: "Llamble Server (NAS)", section: true, hidden: !me.is_admin },
        { id: "admin", label: "Accounts", hidden: !me.is_admin },
        { id: "server", label: "Settings & Updates", hidden: me.instance_role !== "master" },
        { id: "aimodel", label: "AI Model", hidden: me.instance_role !== "master" },
        { id: "remote", label: "Remote Access", hidden: me.instance_role !== "master" },
        { id: "end-section", label: "", section: true },
        { id: "logout", label: "Log Out", danger: true },
      ]}
    >
      {tab === "account" && <Account />}
      {tab === "voice" && <VoiceSettings />}
      {tab === "ai" && <AiSettings />}
      {tab === "notifications" && <NotifSettings />}
      {tab === "overlay" && <OverlaySettings />}
      {tab === "games" && <GamesSettings />}
      {tab === "performance" && <PerformanceSettings />}
      {tab === "recordings" && <Recordings />}
      {tab === "sessions" && <Sessions />}
      {tab === "admin" && <Admin />}
      {tab === "family" && <Family />}
      {tab === "remote" && <RemoteAccess />}
      {tab === "server" && <ServerConfig />}
      {tab === "aimodel" && (
        <div>
          <h2>AI Model (on this server)</h2>
          <p className="muted small">Runs on the NAS whenever nobody is lending a GPU. Downloads come from Hugging Face once, then everything runs locally.</p>
          <ModelPicker />
          <ServerModels />
          <GpuSharing />
          <BotToolsAdmin />
          <PicturesAdmin />
          <VoiceAiAdmin />
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
      <RecoveryCodeSection />
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
  const flag = (k: string, label: string, desc: string, def = true) => (
    <div className="perm-row">
      <div>
        <div className="bold">{label}</div>
        <div className="muted small">{desc}</div>
      </div>
      <Toggle on={prefs.bool(k, def)} onChange={(v) => set(k, v ? "1" : "0")} />
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
        Camera quality
        <select value={prefs.get("cameraQuality", "720p")} onChange={(e) => set("cameraQuality", e.target.value)}>
          {(["360p", "720p", "1080p", "2160p"] as const).map((q) => (
            <option key={q} value={q} disabled={!cameraAllowed(q)}>
              {q === "2160p" ? "4K" : q}
              {!cameraAllowed(q) ? " (above this server's limit)" : ""}
            </option>
          ))}
        </select>
      </label>
      <label>
        Voice quality
        <select value={prefs.get("audioBitrate", "96000")} onChange={(e) => set("audioBitrate", e.target.value)}>
          <option value="32000">32 kbps (low bandwidth)</option>
          <option value="64000">64 kbps (Discord default)</option>
          <option value="96000">96 kbps (high)</option>
          <option value="128000">128 kbps (studio)</option>
          <option value="256000">256 kbps (music)</option>
          <option value="320000">320 kbps (studio mic, stereo)</option>
          <option value="510000">510 kbps (Opus maximum)</option>
        </select>
      </label>
      <ShareDefault />
      <EncoderSetting />
      <div className="perm-row">
        <div>
          <div className="bold">Studio mic</div>
          <div className="muted small">
            Sends your mic in stereo (if it's a stereo mic), without trimming quiet moments or adding repair packets. Turning it on also switches off
            the three cleanup options below; turn any of them back on if you need it. Best with headphones and 256 kbps or more.
          </div>
        </div>
        <Toggle
          on={prefs.bool("studioMic", false)}
          onChange={(v) => {
            if (v) for (const k of ["noiseSuppression", "echoCancellation", "autoGainControl"]) prefs.set(k, "0");
            set("studioMic", v ? "1" : "0");
          }}
        />
      </div>
      {flag("noiseSuppression", "Noise suppression", "Filter background noise (keyboard, fans)")}
      {flag("echoCancellation", "Echo cancellation", "Turn off if you use headphones and want the most natural sound")}
      {flag("autoGainControl", "Automatic gain control", "Keep your volume level consistent")}
      <p className="muted small">Changes to processing apply the next time you join voice. Global hotkeys: Ctrl+Shift+M mute, Ctrl+Shift+D deafen.</p>
      {(useStore.getState().config as any).voice_ai?.available && <MicTest />}
      {flag("autoWatchStreams", "Watch screen shares automatically", "Off: a shared screen shows a Watch button first (saves bandwidth, like Discord)", false)}
      {flag("autoWatchCameras", "Show cameras automatically", "Off: cameras show a Show video button first")}
      <label>
        Llamble's voice volume (in calls)
        <input type="range" min={0} max={1} step={0.05} defaultValue={prefs.get("botVolume", "1")} onChange={(e) => set("botVolume", e.target.value)} />
      </label>
      <div className="profile-section">Camera effects</div>
      <CameraFxPicker preview />
    </div>
  );
}

function ShareDefault() {
  const [q, setQ] = useState<ShareQuality>(defaultShareQuality());
  return (
    <label>
      Screen share quality (default)
      <select
        value={q}
        onChange={(e) => {
          const v = e.target.value as ShareQuality;
          setQ(v);
          setDefaultShareQuality(v);
        }}
      >
        {SHARE_ORDER.map((x) => (
          <option key={x} value={x} disabled={!shareAllowed(x)}>
            {SHARE_LABELS[x]}
            {!shareAllowed(x) ? " (above server limit)" : ""}
          </option>
        ))}
      </select>
      <span className="muted small">Used by Share Screen and Stream game. You can still change it for one share in the picker.</span>
    </label>
  );
}

function EncoderSetting() {
  const [choice, setChoice] = useState<CodecChoice>(codecChoice());
  const enc = useEncoder();
  useEffect(() => {
    hardwareEncoders();
  }, []);
  const hw = enc.hw;
  const hwText = hw
    ? Object.entries(hw)
        .filter(([, v]) => v)
        .map(([k]) => k.toUpperCase())
        .join(", ") || "none found (video is encoded on the CPU)"
    : "checking…";
  return (
    <>
      <label>
        Video encoder (camera and screen share)
        <select
          value={choice}
          onChange={(e) => {
            const c = e.target.value as CodecChoice;
            setChoice(c);
            setCodecChoice(c);
            clearBad();
          }}
        >
          {(Object.keys(CODEC_LABELS) as CodecChoice[]).map((c) => (
            <option key={c} value={c}>
              {CODEC_LABELS[c]}
            </option>
          ))}
        </select>
      </label>
      <p className="muted small" style={{ marginTop: -6 }}>
        Hardware encoders on this {window.llambleNative ? "PC" : "device"}: {hwText}.
        {enc.screen && <> Screen share: {describe(enc.screen)}.</>}
        {enc.camera && <> Camera: {describe(enc.camera)}.</>} Viewers who can't play AV1 or VP9 automatically get a backup copy. Takes effect the next
        time you start your camera or a share.
      </p>
    </>
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
        <h2>Lend My GPU</h2>
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
      <h2>Lend My GPU</h2>
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
      <LendPictures />

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
      {flag("effects", "Screen effects", "Confetti, fireworks and the like when someone sends /confetti, /fireworks...")}
      {flag("autoEffects", "Effects from words", "\"Happy birthday\" and \"congrats\" set off confetti by themselves")}
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

function levelLabel(u: User) {
  if (u.is_bot) return null;
  if (u.instance_role === "master") return <span className="role-chip has master">Master Admin</span>;
  if (u.instance_role === "admin" || u.is_admin) return <span className="role-chip has">admin</span>;
  if (u.is_kid) return <span className="role-chip kid">kid</span>;
  return null;
}

function Admin() {
  const me = useStore((s) => s.me)!;
  const isMaster = me.instance_role === "master";
  const [users, setUsers] = useState<User[]>([]);
  const [code, setCode] = useState("");
  const load = () => api("/api/admin/users").then(setUsers);
  useEffect(() => {
    load();
  }, []);
  const setRole = (u: User, role: string) =>
    api(`/api/admin/users/${u.id}/role`, { body: { role } })
      .then(load)
      .catch((e) => toast(e.message, "error"));
  const makeKid = (u: User) =>
    openModal({
      kind: "prompt",
      title: `Make ${u.display_name} a kid account`,
      label: "Parent usernames (comma-separated)",
      placeholder: "mom, dad",
      confirmLabel: "Make kid account",
      onSubmit: (v: string) =>
        api(`/api/admin/users/${u.id}/kid`, { body: { is_kid: true, guardians: v.split(",").map((x) => x.trim()).filter(Boolean) } })
          .then(load)
          .catch((e) => toast(e.message, "error")),
    });
  return (
    <div>
      <h2>Accounts</h2>
      <p className="muted small">Everyone with an account on this Llamble server (your NAS), across all the chat servers on it.</p>
      <ResetRequests />
      <div className="profile-section">Account invites</div>
      <p className="muted small">Creates an account invite that doesn't join any server (single use). Kid accounts don't need invites: make them in Settings → Family.</p>
      <div className="row gap">
        <button className="btn" onClick={() => api("/api/admin/invites", { body: { max_uses: 1 } }).then((r) => setCode(r.code))}>
          New account invite
        </button>
        {isMaster && (
          <button className="btn" onClick={() => api("/api/admin/invites", { body: { max_uses: 1, grants_admin: true } }).then((r) => setCode(r.code))}>
            New admin invite
          </button>
        )}
        {code && (
          <button className="btn primary" onClick={() => copy(inviteLink(code), "Invite copied")}>
            Copy {code}
          </button>
        )}
      </div>
      <div className="profile-section">Users — {users.length}</div>
      <p className="muted small">
        <b>Master Admin</b> runs the server itself (Server, AI Model, Remote Access) and sets admin levels. <b>Admins</b> manage accounts, passwords and kid accounts.
      </p>
      <div className="member-table">
        {users.map((u) => (
          <div key={u.id} className="member-trow">
            <Avatar user={u} size={28} />
            <span className="grow">
              <b>{u.display_name}</b> <span className="muted">@{u.username}</span> {levelLabel(u)} {u.is_bot && <BotTag />}
            </span>
            {!u.is_bot && u.id !== me.id && (
              <>
                {isMaster && u.instance_role !== "master" && !u.is_kid && (
                  <select value={u.instance_role === "admin" ? "admin" : "user"} onChange={(e) => setRole(u, e.target.value)} style={{ width: 110 }}>
                    <option value="user">User</option>
                    <option value="admin">Admin</option>
                  </select>
                )}
                {u.instance_role === "user" &&
                  (u.is_kid ? (
                    <button className="btn small" onClick={() => api(`/api/admin/users/${u.id}/kid`, { body: { is_kid: false } }).then(load)}>
                      Not a kid
                    </button>
                  ) : (
                    <button className="btn small" onClick={() => makeKid(u)}>
                      Make kid
                    </button>
                  ))}
                {(u.instance_role !== "master" || isMaster) && (
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
                )}
                {isMaster && !u.is_kid && (
                  <button
                    className="btn small"
                    title="Hand over the Master Admin role"
                    onClick={() =>
                      openModal({
                        kind: "confirm",
                        title: `Make ${u.display_name} the Master Admin?`,
                        body: "They'll control the server itself (remote access, AI model, server settings, admin levels). You become a regular admin. They can hand it back.",
                        confirmLabel: "Hand over",
                        danger: true,
                        onConfirm: () => api("/api/admin/transfer-master", { body: { user_id: u.id } }).catch((e) => toast(e.message, "error")),
                      })
                    }
                  >
                    Make Master
                  </button>
                )}
                {u.instance_role !== "master" && (
                  <button
                    className="btn small red"
                    onClick={() => openModal({ kind: "confirm", title: `Delete ${u.username}?`, body: "Their messages stay (as Deleted User); they can't sign in.", danger: true, confirmLabel: "Delete", onConfirm: () => api(`/api/admin/users/${u.id}`, { method: "DELETE" }).then(load) })}
                  >
                    Delete
                  </button>
                )}
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function ServerModels() {
  const [d, setD] = useState<{ models: any[]; total_bytes: number } | null>(null);
  const load = () => api("/api/admin/ai/models").then(setD).catch(() => {});
  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    window.addEventListener("llamble:models-changed", load);
    return () => {
      clearInterval(t);
      window.removeEventListener("llamble:models-changed", load);
    };
  }, []);
  if (!d) return null;
  const use = (m: any) =>
    api("/api/admin/ai", { body: { repo: m.repo, quant: m.quant, ctx: 8192 } })
      .then(() => {
        toast(`Switching to ${m.repo.split("/").pop()} ${m.quant}…`);
        window.dispatchEvent(new Event("llamble:ai-changed"));
        load();
      })
      .catch((e) => toast(e.message, "error"));
  const del = (m: any) =>
    openModal({
      kind: "confirm",
      title: m.other ? "Delete leftover files?" : `Delete ${m.repo.split("/").pop()} ${m.quant}?`,
      body: `Frees ${formatBytes(m.on_disk)} on the server. You can download it again later.`,
      danger: true,
      confirmLabel: "Delete",
      onConfirm: () =>
        api(`/api/admin/ai/models?repo=${encodeURIComponent(m.repo)}${m.quant ? `&quant=${encodeURIComponent(m.quant)}` : ""}`, { method: "DELETE" })
          .then(load)
          .catch((e) => toast(e.message, "error")),
    });
  return (
    <div>
      <h2 style={{ marginTop: 28 }}>Models on this server</h2>
      <p className="muted small">
        Everything downloaded to the NAS ({formatBytes(d.total_bytes)} total). Switching to one that's already here doesn't download it again.
      </p>
      {d.models.length === 0 && <p className="muted small">No models downloaded yet.</p>}
      <div className="backend-list">
        {d.models.map((m) => (
          <div key={m.repo + (m.quant ?? "")} className={"backend " + (m.active ? "ok" : "off")}>
            <Icon name="cpu" size={16} />
            <span className="grow">
              <b>{m.repo}</b> {m.quant ? `· ${m.quant}` : "· leftover files"} · {formatBytes(m.on_disk)}
              {!m.other && !m.complete && <span className="muted small"> · partly downloaded ({Math.round((m.on_disk / Math.max(1, m.size)) * 100)}%)</span>}
            </span>
            {m.active ? (
              <span className="role-chip has">in use</span>
            ) : (
              <>
                {!m.other && (
                  <button className="btn small" onClick={() => use(m)}>
                    {m.complete ? "Use" : "Resume & use"}
                  </button>
                )}
                <button className="btn small red" onClick={() => del(m)}>
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
        Members can offer their graphics card from their app (My Settings → Lend My GPU). The bot always uses the <b>best available</b> one, switches when its owner starts using
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
      <h2>Llamble Server Settings</h2>
      <p className="muted small">Settings for the Llamble server itself (your NAS). Changes apply right away, no restart.</p>
      <ServerUpdate />
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

      <div className="profile-section">Voice &amp; video limits</div>
      <p className="muted small">The most anyone on this server can send. Each viewer automatically gets the best copy their screen and connection can handle, so a 4K share still plays smoothly for someone on a phone. The sender's own upload is what this limit protects.</p>
      <div className="perm-row">
        <div>
          <div className="bold">Screen share, highest quality</div>
        </div>
        <select value={f.max_share ?? "native"} onChange={(e) => set("max_share", e.target.value)} style={{ width: 200 }}>
          <option value="720p30">720p · 30 fps</option>
          <option value="1080p30">1080p · 30 fps</option>
          <option value="1080p60">1080p · 60 fps</option>
          <option value="1440p30">1440p · 30 fps</option>
          <option value="1440p60">1440p · 60 fps</option>
          <option value="2160p30">4K · 30 fps</option>
          <option value="2160p60">4K · 60 fps</option>
          <option value="native">Whatever their screen is (up to 4K · 60)</option>
        </select>
      </div>
      <div className="perm-row">
        <div>
          <div className="bold">Camera, highest quality</div>
        </div>
        <select value={f.max_camera ?? "720p"} onChange={(e) => set("max_camera", e.target.value)} style={{ width: 200 }}>
          <option value="360p">360p</option>
          <option value="720p">720p</option>
          <option value="1080p">1080p</option>
          <option value="2160p">4K</option>
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
      <EmailSettings />
    </div>
  );
}

function EmailSettings() {
  const [f, setF] = useState<any>(null);
  const [pw, setPw] = useState("");
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api("/api/admin/smtp").then(setF).catch(() => {});
  }, []);
  if (!f) return null;
  const set = (k: string, v: any) => setF({ ...f, [k]: v });
  const save = () =>
    api("/api/admin/smtp", { method: "PUT", body: { ...f, port: Number(f.port) || 0, password: pw } })
      .then(() => {
        setPw("");
        toast("Email settings saved");
        api("/api/admin/smtp").then(setF);
      })
      .catch((e) => toast(e.message, "error"));
  return (
    <>
      <div className="profile-section">Email (optional)</div>
      <p className="muted small">
        Lets people reset a forgotten password by email (they add their address in My Account). Use any email account that allows SMTP sign-in, e.g. a Gmail address with an
        "app password", or your email provider's SMTP settings.
      </p>
      <div className="row gap">
        <label className="grow">
          SMTP server
          <input value={f.host} onChange={(e) => set("host", e.target.value)} placeholder="smtp.gmail.com" />
        </label>
        <label style={{ width: 110 }}>
          Port
          <input value={f.port || ""} onChange={(e) => set("port", e.target.value)} placeholder={f.security === "tls" ? "465" : "587"} />
        </label>
        <label style={{ width: 170 }}>
          Security
          <select value={f.security} onChange={(e) => set("security", e.target.value)}>
            <option value="starttls">STARTTLS (587)</option>
            <option value="tls">TLS (465)</option>
            <option value="none">None (local only)</option>
          </select>
        </label>
      </div>
      <div className="row gap">
        <label className="grow">
          Username
          <input value={f.username} onChange={(e) => set("username", e.target.value)} placeholder="you@gmail.com" />
        </label>
        <label className="grow">
          Password {f.has_password && <span className="green">· saved</span>}
          <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder={f.has_password ? "(leave blank to keep)" : ""} />
        </label>
      </div>
      <label>
        Send as
        <input value={f.from} onChange={(e) => set("from", e.target.value)} placeholder="Llamble <you@gmail.com>" />
      </label>
      <div className="row gap center-v">
        <button className="btn" onClick={save}>
          Save email settings
        </button>
        <input value={to} onChange={(e) => setTo(e.target.value)} placeholder="send a test to…" style={{ width: 220 }} />
        <button
          className="btn"
          disabled={!to || busy}
          onClick={() => {
            setBusy(true);
            api("/api/admin/smtp/test", { body: { to } })
              .then(() => toast("Test email sent"))
              .catch((e) => toast(e.message, "error"))
              .finally(() => setBusy(false));
          }}
        >
          Send test
        </button>
      </div>
    </>
  );
}

const PROVIDERS: Record<string, { name: string; example: string; secret?: string; steps: React.ReactNode[] }> = {
  namecheap: {
    name: "Namecheap",
    example: "chat.example.com",
    secret: "Dynamic DNS password",
    steps: [
      <>Domain List → <b>Manage</b> next to your domain. Nameservers should be <b>Namecheap BasicDNS</b> (the default).</>,
      <><b>Advanced DNS</b> → scroll to <b>Dynamic DNS</b> → switch it on and copy the password.</>,
      <>Host Records → Add New Record → <b>A + Dynamic DNS Record</b>, Host <code>chat</code>, Value <code>127.0.0.1</code> → save. (That's only a placeholder because Namecheap won't save an empty record; Llamble swaps in your real home IP the moment you turn this on.)</>,
    ],
  },
  cloudflare: {
    name: "Cloudflare",
    example: "chat.example.com",
    secret: "API token",
    steps: [
      <>My Profile → <b>API Tokens</b> → Create Token → use the <b>Edit zone DNS</b> template.</>,
      <>Under Zone Resources pick your domain → Create, and copy the token.</>,
      <>Llamble creates the <code>chat</code> record itself. Keep it <b>DNS only</b> (grey cloud): Cloudflare's proxy doesn't carry calls.</>,
    ],
  },
  duckdns: {
    name: "DuckDNS (free, no domain needed)",
    example: "yourname.duckdns.org",
    secret: "DuckDNS token",
    steps: [
      <>Sign in at <b>duckdns.org</b> and add a subdomain, like <code>yourname</code>.</>,
      <>Copy the <b>token</b> shown at the top of the page.</>,
      <>Your address is <code>yourname.duckdns.org</code>.</>,
    ],
  },
  custom: {
    name: "Another provider (update URL)",
    example: "chat.example.com",
    steps: [
      <>Most providers (No-IP, Dynu, afraid.org, many registrars) give you an <b>update URL</b> in their Dynamic DNS settings.</>,
      <>Paste it below. If it needs your IP in it, put <code>{"{ip}"}</code> where the IP goes; otherwise the provider detects it.</>,
      <>Llamble opens that URL every 10 minutes.</>,
    ],
  },
  manual: {
    name: "I handle it myself (router or static IP)",
    example: "chat.example.com",
    steps: [
      <>Use this if your router updates Dynamic DNS itself, or your internet plan has a fixed IP.</>,
      <>Point your address (an A record) at your home's public IP at your DNS provider.</>,
      <>Llamble checks where the address points and uses that IP for calls.</>,
    ],
  },
};

function RouterSteps({ router, nasIp, ports }: { router: string; nasIp: string; ports: any }) {
  const rules: [string, string, string, string][] = [
    ["TCP", "443", String(ports.https), "Llamble web, app and HTTPS certificate"],
    ["TCP", String(ports.voice_tcp), String(ports.voice_tcp), "Llamble voice (backup)"],
    ["UDP", String(ports.voice_udp), String(ports.voice_udp), "Llamble voice"],
  ];
  const table = (
    <table className="ports">
      <thead>
        <tr>
          <th>Rule</th>
          <th>Protocol</th>
          <th>Outside port</th>
          <th>Send to</th>
          <th>Inside port</th>
        </tr>
      </thead>
      <tbody>
        {rules.map(([proto, out, inner, what], i) => (
          <tr key={i}>
            <td>{what}</td>
            <td>{proto}</td>
            <td>{out}</td>
            <td>{nasIp}</td>
            <td>{inner}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
  if (router === "opnsense" || router === "pfsense") {
    const opn = router === "opnsense";
    return (
      <>
        {table}
        <ol className="small">
          <li>
            Sign in to {opn ? "OPNsense" : "pfSense"} and open{" "}
            {opn ? (
              <>
                <b>Firewall → NAT → Destination NAT</b> (called <b>Port Forward</b> before version 26.1)
              </>
            ) : (
              <b>Firewall → NAT → Port Forward</b>
            )}
            , then click <b>+ / Add</b>.
          </li>
          <li>
            Fill in the first rule from the table. Anything not mentioned here: leave it as it is.
            <ul>
              <li><b>Description:</b> any name for you, e.g. "Llamble web" (Disabled, Sequence and Categories: leave alone)</li>
              <li><b>Interface:</b> WAN · <b>TCP/IP version:</b> IPv4 · <b>Protocol:</b> TCP (UDP for the voice rule)</li>
              <li><b>Source:</b> any, not inverted · <b>Source port:</b> any</li>
              <li><b>Destination:</b> WAN address, not inverted · <b>Destination port:</b> the outside port (443; pick "other" and type it if it's not in the list)</li>
              <li><b>Redirect target IP:</b> {nasIp} · <b>Redirect target port:</b> the inside port ({ports.https} for the first rule)</li>
              <li>{opn ? <><b>NAT reflection:</b> Use system default · <b>Firewall rule:</b> Register rule</> : <><b>NAT reflection:</b> Use system default · <b>Filter rule association:</b> Add associated filter rule</>} (this opens the firewall for it)</li>
            </ul>
          </li>
          <li>Save, then add the other two rules the same way.</li>
          <li>Click <b>Apply changes</b>.</li>
          <li>
            So it also works from inside your house: <b>Firewall → Settings → Advanced</b>, tick <b>Reflection for Destination NAT (Port Forwards)</b> (older: "Reflection for port forwards") and <b>Automatic Source NAT (Outbound) for Reflection</b> (older: "Automatic outbound NAT for Reflection"), then Save.
          </li>
          <li>
            Check: the WAN IP on the {opn ? "OPNsense" : "pfSense"} dashboard should be a public address (not 192.168.x.x, 10.x.x.x or 100.64–127.x.x). If it isn't, your
            internet provider's modem is also routing and needs to be put in bridge mode first.
          </li>
          <li>Back here, click <b>Check again now</b> under the status below.</li>
        </ol>
      </>
    );
  }
  return (
    <>
      {table}
      <ol className="small">
        <li>Open your router's settings (often <code>192.168.1.1</code> or <code>192.168.0.1</code> in a browser, or your internet provider's app).</li>
        <li>Find <b>Port Forwarding</b>, <b>Virtual Server</b> or <b>NAT</b> (often under Advanced, WAN or Firewall).</li>
        <li>Add one entry per row above: protocol, outside (external) port, the NAS address {nasIp}, and inside (internal) port. Some routers call it "start/end port"; use the same number for both.</li>
        <li>Save or Apply. Some ISP routers need a restart afterwards.</li>
        <li>Back here, click <b>Check again now</b> under the status below.</li>
      </ol>
    </>
  );
}

function RemoteAccess() {
  const [r, setR] = useState<any>(null);
  const [mode, setMode] = useState<"off" | "direct" | "relay">("off");
  const [domain, setDomain] = useState("");
  const [pw, setPw] = useState("");
  const [email, setEmail] = useState("");
  const [relayAddr, setRelayAddr] = useState("");
  const [provider, setProvider] = useState("namecheap");
  const [ddnsUrl, setDdnsUrl] = useState("");
  const [lanIp, setLanIp] = useState("");
  const [router, setRouter] = useState(() => localStorage.getItem("llamble.routerType") || "opnsense");
  useEffect(() => localStorage.setItem("llamble.routerType", router), [router]);
  useEffect(() => {
    api("/api/admin/settings").then((x) => setLanIp(x.settings.lan_ip || "")).catch(() => {});
  }, []);
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
      setProvider(d.ddns_provider || "namecheap");
      setMode(d.enabled ? d.mode : "off");
    });
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, []);
  if (!r) return <div className="muted">Loading…</div>;
  // the server knows its own home-network address best; the browser's view is a fallback
  const nasIp = lanIp || nasAddress() || "your NAS's IP";
  const p = r.ports;
  const save = async (extra: any = {}) => {
    setBusy(true);
    try {
      const on = mode !== "off";
      await api("/api/admin/remote", {
        method: "PUT",
        body: { enabled: on, mode: on ? mode : r.mode, domain: on ? domain : r.domain, ddns_provider: provider, ddns_password: pw || undefined, ddns_url: ddnsUrl || undefined, email, relay_addr: relayAddr, ...extra },
      });
      setPw("");
      setDdnsUrl("");
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
  // a saved secret only counts for the provider it was saved with
  const secretSaved = r.has_ddns_secret && r.ddns_provider === provider;
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
      <p className="muted small">How people outside your home reach this server. Everyone uses your own address (like chat.example.com, or a free yourname.duckdns.org) with HTTPS.</p>
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
              <div className="bold">Keep your address pointed at home</div>
              <p className="muted small">Most home internet IPs change now and then. Llamble can update your address for you; pick where your domain's DNS is managed.</p>
              <select value={provider} onChange={(e) => setProvider(e.target.value)} style={{ width: 320 }}>
                {Object.entries(PROVIDERS).map(([id, p]) => (
                  <option key={id} value={id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <ol className="small">
                {PROVIDERS[provider].steps.map((st, k) => (
                  <li key={k}>{st}</li>
                ))}
              </ol>
            </div>
          </div>
          <div className="remote-step">
            <div className="step-num">2</div>
            <div className="grow">
              <div className="bold">Tell Llamble</div>
              <label>
                Address people will use
                <input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder={PROVIDERS[provider].example} />
              </label>
              {PROVIDERS[provider].secret && (
                <label>
                  {PROVIDERS[provider].secret} {secretSaved && <span className="green">· saved</span>}
                  <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder={secretSaved ? "(leave blank to keep the saved one)" : "paste it here"} />
                </label>
              )}
              {provider === "custom" && (
                <label>
                  Update URL {secretSaved && <span className="green">· saved</span>}
                  <input type="password" value={ddnsUrl} onChange={(e) => setDdnsUrl(e.target.value)} placeholder={secretSaved ? "(leave blank to keep the saved one)" : "https://provider.example/update?host=…&key=…&ip={ip}"} />
                </label>
              )}
              <label>
                Your email <span className="muted">(optional; Let's Encrypt emails you only if a certificate has problems)</span>
                <input value={email} onChange={(e) => setEmail(e.target.value)} />
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
              <p className="muted small">This tells your router to send outside visitors to the NAS. Pick your router for exact steps:</p>
              <select value={router} onChange={(e) => setRouter(e.target.value)} style={{ width: 320 }}>
                <option value="opnsense">OPNsense</option>
                <option value="pfsense">pfSense</option>
                <option value="other">Other router (Netgear, TP-Link, Asus, ISP router…)</option>
              </select>
              <RouterSteps router={router} nasIp={nasIp} ports={p} />
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
              <p className="muted small">Wherever your domain's DNS is managed, add an <b>A record</b>: host <code>chat</code> → the VPS's IP address. This only needs doing once; the VPS's IP doesn't change. (Cloudflare: keep it <b>DNS only</b>, grey cloud.)</p>
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
            {st.tls_state === "error" && st.tls_error && <div className="muted small">Details: {st.tls_error}</div>}
          </div>
          {st.tls_state === "ready" ? (
            <p className="small">
              ✅ People outside can now use <b>https://{r.domain}</b> in the app or a browser (Chromebooks too). New invites use this address.
            </p>
          ) : (
            <div className="row gap">
              <button className="btn small" disabled={busy} onClick={() => save()}>
                Check again now
              </button>
              <span className="muted small">Use this right after changing your router; otherwise it retries by itself.</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function OverlaySettings() {
  const p = useOverlayPrefs();
  const pop = usePopout((s) => s.win);
  const native = !!window.llambleNative?.overlay;
  const row = (label: string, desc: string, control: React.ReactNode) => (
    <div className="perm-row">
      <div>
        <div className="bold">{label}</div>
        {desc && <div className="muted small">{desc}</div>}
      </div>
      {control}
    </div>
  );
  const widgetRow = (id: WidgetId, label: string, desc: string) => row(label, desc, <Toggle on={p.widgets[id].on} onChange={(v) => setWidget(id, { on: v })} />);
  return (
    <div>
      <h2>Overlay</h2>
      <p className="muted">
        {native
          ? "Shows who's talking, chat and alerts on top of your games and other apps. It never takes clicks away from your game."
          : "Pops out a small window that stays on top of your other apps and games, showing who's talking, chat and alerts. Drag it wherever you like and resize it."}
      </p>
      {native ? (
        <>
          {row("Show the overlay", "", <Toggle on={p.enabled} onChange={(v) => setOverlayPrefs({ enabled: v })} />)}
          <div className="row gap" style={{ margin: "8px 0 16px" }}>
            <button className="btn primary" onClick={() => window.llambleNative!.overlay!.edit(true)}>
              Move widgets
            </button>
            <span className="muted small">Or press Ctrl+Shift+O any time, even in a game. Press it again (or Esc) when you're done.</span>
          </div>
        </>
      ) : popoutSupported() ? (
        <div className="row gap" style={{ margin: "8px 0 16px" }}>
          <button
            className="btn primary"
            onClick={() =>
              pop
                ? closePopout()
                : openPopout().catch((e) => toast(e.message, "error"))
            }
          >
            {pop ? "Close pop-out" : "Pop out overlay"}
          </button>
          <span className="muted small">There's also a button for it in the voice call controls.</span>
        </div>
      ) : (
        <p className="error-text">This browser can't keep a window on top. Use Chrome or Edge, or the Windows app.</p>
      )}

      <h3>What to show</h3>
      {widgetRow("voice", "Voice", "People in your voice channel")}
      {p.widgets.voice.on && (
        <div className="indent">
          {row(
            "Who to list",
            "",
            <select value={p.voiceMode} onChange={(e) => setOverlayPrefs({ voiceMode: e.target.value as any })}>
              <option value="all">Everyone in the channel</option>
              <option value="speaking">Only people talking</option>
            </select>,
          )}
          {row("Pictures", "", <Toggle on={p.voiceAvatars} onChange={(v) => setOverlayPrefs({ voiceAvatars: v })} />)}
        </div>
      )}
      {widgetRow("chat", "Chat", "Recent messages")}
      {p.widgets.chat.on && (
        <div className="indent">
          {row(
            "Messages from",
            "",
            <select value={p.chatSource} onChange={(e) => setOverlayPrefs({ chatSource: e.target.value as any })}>
              <option value="open">The channel open in Llamble</option>
              <option value="mentions">Only DMs and @mentions</option>
            </select>,
          )}
          {row(
            "How many",
            "",
            <select value={p.chatCount} onChange={(e) => setOverlayPrefs({ chatCount: +e.target.value })}>
              {[3, 5, 8, 12].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>,
          )}
          {row(
            "Fade away after",
            "",
            <select value={p.chatFade} onChange={(e) => setOverlayPrefs({ chatFade: +e.target.value })}>
              {[10, 20, 60, 300, 0].map((n) => (
                <option key={n} value={n}>
                  {n === 0 ? "Never" : n < 60 ? n + " seconds" : n / 60 + " minute" + (n > 60 ? "s" : "")}
                </option>
              ))}
            </select>,
          )}
        </div>
      )}
      {widgetRow("alerts", "Alerts", "Pop-ups for direct messages and @mentions")}
      {p.widgets.alerts.on &&
        row(
          "Alerts stay for",
          "",
          <select value={p.alertsFade} onChange={(e) => setOverlayPrefs({ alertsFade: +e.target.value })}>
            {[5, 8, 15, 30].map((n) => (
              <option key={n} value={n}>
                {n} seconds
              </option>
            ))}
          </select>,
        )}

      <h3>Look</h3>
      {row("Size", "", <input type="range" min={0.6} max={1.6} step={0.05} value={p.scale} onChange={(e) => setOverlayPrefs({ scale: +e.target.value })} />)}
      {native && row("See-through", "", <input type="range" min={0.3} max={1} step={0.05} value={p.opacity} onChange={(e) => setOverlayPrefs({ opacity: +e.target.value })} />)}
      {row(
        "When",
        "",
        <select value={p.when} onChange={(e) => setOverlayPrefs({ when: e.target.value as any })}>
          <option value="voice">Only while I'm in a voice channel</option>
          <option value="always">Always</option>
        </select>,
      )}
      {native && row("Hide while Llamble is in front", "No need for it when you're looking at Llamble itself", <Toggle on={p.hideWhenFocused} onChange={(v) => setOverlayPrefs({ hideWhenFocused: v })} />)}
      {native && (
        <p className="muted small">
          Works over windowed and borderless full-screen games. A few games use exclusive full-screen, which nothing can draw over; switch those to "Borderless" or "Windowed full-screen" in the game's video settings.
        </p>
      )}
    </div>
  );
}

function ServerUpdate() {
  const sv = useStore((s) => s.config.version) || "unknown";
  const behind = sv !== "unknown" && __APP_VERSION__ !== "dev" && sv !== __APP_VERSION__ && newer(__APP_VERSION__, sv);
  return (
    <div className={"rs " + (behind ? "err" : "ok")}>
      <b>Version</b> server {sv}, this app {__APP_VERSION__}
      {behind ? " — the server is out of date." : " — up to date."}
      {behind && (
        <ol className="small" style={{ margin: "8px 0 0", paddingLeft: 20 }}>
          <li>
            On TrueNAS, open <b>Apps</b>, click the Llamble app, and press <b>Update</b> if it's offered.
          </li>
          <li>
            If there's no Update button: <b>Apps → Discover Apps → ⋮ → Manage Container Images → Pull Image</b>, enter <code>ghcr.io/outcomegit/llamble</code> with tag <code>latest</code>, wait for it to finish, then <b>Stop</b> and <b>Start</b> the Llamble app.
          </li>
          <li>Your accounts, chats and settings stay. Everyone reconnects by themselves in a few seconds.</li>
        </ol>
      )}
    </div>
  );
}

function newer(a: string, b: string): boolean {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
}

function LendPictures() {
  const ai = useAi();
  const want = useStore((s) => (s.config as any).images);
  if (!window.llambleNative?.images) return null;
  const st = ai.img;
  const pct = st.total ? Math.round((st.done / st.total) * 100) : 0;
  return (
    <div className="perm-row">
      <div>
        <div className="bold">Also make pictures</div>
        <div className="muted small">
          {!want?.enabled
            ? "The server's owner hasn't turned on pictures (Settings → AI Model → Pictures)."
            : `Draws /imagine pictures with ${want.model === "z-image-turbo" ? "Z-Image Turbo" : "FLUX.2 [klein] 4B"} on this GPU (a few seconds each). Downloads about 6–7 GB once.`}
          {ai.config.pictures && (
            <div>
              {st.state === "downloading"
                ? `Downloading ${st.file}… ${pct}%`
                : st.state === "ready"
                  ? st.busy
                    ? "Drawing a picture now"
                    : "Ready"
                  : st.state === "error"
                    ? "Problem: " + st.error
                    : "Getting ready…"}
            </div>
          )}
        </div>
      </div>
      <Toggle
        on={ai.config.pictures}
        disabled={!want?.enabled}
        onChange={(v) => {
          saveAiConfig({ ...ai.config, pictures: v });
          if (v) preparePictures();
        }}
      />
    </div>
  );
}
