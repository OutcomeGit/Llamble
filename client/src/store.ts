import { create } from "zustand";
import type { BoardPrefs, Channel, Guild, GuildBoardPrefs, GuildPayload, Highlight, LlambleNews, Member, Message, NewsItem, Note, Role, User, VoiceState } from "./types";
import { ALL_PERMS, P } from "./types";

export interface ServerConfig {
  voice_enabled: boolean;
  max_upload_bytes: number;
  guild_create: string;
  public_domain?: string | null;
  version?: string;
  client_download?: string;
  /** server-wide limits set by the Master Admin */
  media?: { max_share: string; max_camera: string; mic_default_kbps?: number; mic_max_kbps?: number };
  bot?: { id: string; name: string; server_backend: boolean; worker_policy: string };
}

interface State {
  me: User | null;
  ready: boolean;
  conn: "connecting" | "open" | "closed";
  config: ServerConfig;
  guildOrder: string[];
  guilds: Record<string, Guild>;
  channels: Record<string, Channel>;
  roles: Record<string, Role[]>;
  members: Record<string, Record<string, Member>>;
  users: Record<string, User>;
  messages: Record<string, Message[]>; // ascending
  hasMore: Record<string, boolean>;
  readStates: Record<string, string>;
  mentions: Record<string, number>;
  presences: Record<string, string>;
  /** what each person is playing ("Playing X"), from the Windows app's game detection */
  games: Record<string, string>;
  voiceStates: Record<string, VoiceState>;
  typing: Record<string, Record<string, number>>;
  /** guild id, "@me" (direct messages) or "@home" */
  selectedGuild: string;
  /** a server's Notes board or Highlights is open instead of a channel */
  /** "board" while a server's board is open in the main area instead of a channel */
  guildView: Record<string, "board" | undefined>;
  /** board section to scroll to once it opens */
  boardSection: "notes" | "highlights" | null;
  /** what each board shows ("@home" or a server id): everything, or one kind */
  boardFilter: Record<string, BoardFilter>;
  /** notes I can see (Home's "For you" and boards I've opened) */
  notes: Record<string, Note>;
  highlights: Record<string, Highlight>;
  /** news I can see: instance, servers', and Llamble's (signed by the project) */
  news: Record<string, NewsItem>;
  llambleNews: LlambleNews | null;
  /** what each server puts on my boards */
  boardPrefs: BoardPrefs;
  lastChannel: Record<string, string>;
  memberListOpen: boolean;
  ringing: { channel_id: string; from: string } | null;
}

export const useStore = create<State>(() => ({
  me: null,
  ready: false,
  conn: "connecting",
  config: { voice_enabled: false, max_upload_bytes: 500 * 1024 * 1024, guild_create: "admin" },
  guildOrder: [],
  guilds: {},
  channels: {},
  roles: {},
  members: {},
  users: {},
  messages: {},
  hasMore: {},
  readStates: {},
  mentions: {},
  presences: {},
  games: {},
  voiceStates: {},
  typing: {},
  // everyone opens the app on Home (notes for you, who's around, highlights)
  selectedGuild: "@home",
  guildView: {},
  boardSection: null,
  boardFilter: {},
  notes: {},
  highlights: {},
  news: {},
  llambleNews: null,
  boardPrefs: { guilds: {}, llamble_news: true },
  lastChannel: JSON.parse(localStorage.getItem("llamble.lastChannel") || "{}"),
  memberListOpen: true,
  ringing: null,
}));

const set = useStore.setState;
const get = useStore.getState;

// ---------- helpers ----------

export function selectChannel(guildId: string, channelId: string | null) {
  const lastChannel = { ...get().lastChannel };
  if (channelId) lastChannel[guildId] = channelId;
  localStorage.setItem("llamble.lastChannel", JSON.stringify(lastChannel));
  localStorage.setItem("llamble.lastGuild", guildId);
  // picking a channel leaves that server's Notes/Highlights view
  const guildView = channelId ? { ...get().guildView, [guildId]: undefined } : get().guildView;
  set({ selectedGuild: guildId, lastChannel, guildView });
}

export type BoardFilter = "all" | "notes" | "highlights" | "news" | "instance-news" | "llamble-news";

export function openHome(filter: BoardFilter = "all") {
  localStorage.setItem("llamble.lastGuild", "@home");
  set({ selectedGuild: "@home", boardFilter: { ...get().boardFilter, "@home": filter } });
}

/** Open a server's board in the main area, showing everything or just notes / highlights. */
export function openGuildView(guildId: string, view: "board" | "notes" | "highlights" | "news" = "board") {
  localStorage.setItem("llamble.lastGuild", guildId);
  const filter: BoardFilter = view === "board" ? "all" : view;
  set({ selectedGuild: guildId, guildView: { ...get().guildView, [guildId]: "board" }, boardSection: null, boardFilter: { ...get().boardFilter, [guildId]: filter } });
}

/** Notes addressed to me that are still up (Home's "For you"). */
export function notesForMe(s: State = get()): Note[] {
  const me = s.me?.id;
  const now = Date.now();
  return Object.values(s.notes).filter(
    (n) =>
      n.author.id !== me &&
      !n.dismissed &&
      (!n.expires_at || n.expires_at > now) &&
      !!s.guilds[n.guild_id] &&
      s.boardPrefs.guilds[n.guild_id]?.notes !== false &&
      (n.audience === "everyone" || n.to.includes(me || "")),
  );
}

/** A server's board preferences for me (everything on unless I turned it off). */
export function guildPrefs(s: State, gid: string): GuildBoardPrefs {
  return s.boardPrefs.guilds[gid] ?? { notes: true, highlights: true, news: true, highlight_types: "all" };
}

export function currentChannelId(s: State = get()): string | null {
  const g = s.selectedGuild;
  if (g === "@home" || s.guildView[g]) return null;
  const c = s.lastChannel[g];
  if (c && s.channels[c] && (g === "@me" ? !s.channels[c].guild_id : s.channels[c].guild_id === g)) return c;
  if (g === "@me") return null;
  const first = Object.values(s.channels)
    .filter((ch) => ch.guild_id === g && ch.kind === "text")
    .sort(channelSort(s))[0];
  return first?.id ?? null;
}

export function channelSort(s: State) {
  return (a: Channel, b: Channel) => {
    const pa = a.parent_id ? s.channels[a.parent_id]?.position ?? 0 : a.kind === "category" ? a.position : -1;
    const pb = b.parent_id ? s.channels[b.parent_id]?.position ?? 0 : b.kind === "category" ? b.position : -1;
    if (pa !== pb) return pa - pb;
    return a.position - b.position || a.created_at - b.created_at;
  };
}

export function memberName(guildId: string | null, user: User | undefined): string {
  if (!user) return "Unknown";
  if (guildId) {
    const m = get().members[guildId]?.[user.id];
    if (m?.nickname) return m.nickname;
  }
  return user.display_name || user.username;
}

export function roleColor(guildId: string | null, userId: string): string | undefined {
  if (!guildId) return undefined;
  const m = get().members[guildId]?.[userId];
  if (!m) return undefined;
  const roles = (get().roles[guildId] || []).filter((r) => m.roles.includes(r.id) && r.color).sort((a, b) => b.position - a.position);
  return roles[0] ? "#" + roles[0].color.toString(16).padStart(6, "0") : undefined;
}

export function guildPerms(guildId: string | null, s: State = get()): number {
  const me = s.me;
  if (!me) return 0;
  if (!guildId) return P.VIEW | P.SEND | P.ATTACH | P.EMBED_LINKS | P.REACT | P.CONNECT | P.SPEAK | P.VIDEO;
  const g = s.guilds[guildId];
  if (!g) return 0;
  if (g.owner_id === me.id) return ALL_PERMS;
  const m = s.members[guildId]?.[me.id];
  const roles = s.roles[guildId] || [];
  let p = roles.find((r) => r.id === guildId)?.permissions ?? 0;
  for (const r of roles) if (m?.roles.includes(r.id)) p |= r.permissions;
  if (p & P.ADMINISTRATOR) return ALL_PERMS;
  return p;
}

export function can(guildId: string | null, perm: number): boolean {
  return (guildPerms(guildId) & perm) === perm;
}

export function isUnread(ch: Channel, s: State = get()): boolean {
  if (!ch.last_message_id) return false;
  const r = s.readStates[ch.id];
  return !r || r < ch.last_message_id;
}

export function totalUnreadBadge(s: State = get()): number {
  let n = 0;
  for (const [cid, c] of Object.entries(s.mentions)) if (s.channels[cid]) n += c;
  for (const ch of Object.values(s.channels)) if (ch.kind === "dm" && isUnread(ch, s) && !s.mentions[ch.id]) n += 1;
  return n;
}

function absorbGuild(p: GuildPayload, st: Partial<State> & State) {
  st.guilds = { ...st.guilds, [p.guild.id]: p.guild };
  if (!st.guildOrder.includes(p.guild.id)) st.guildOrder = [...st.guildOrder, p.guild.id];
  const channels = { ...st.channels };
  for (const c of Object.values(channels)) if (c.guild_id === p.guild.id) delete channels[c.id];
  for (const c of p.channels) channels[c.id] = c;
  st.channels = channels;
  st.roles = { ...st.roles, [p.guild.id]: p.roles };
  const mm: Record<string, Member> = {};
  const users = { ...st.users };
  for (const m of p.members) {
    mm[m.user.id] = m;
    users[m.user.id] = m.user;
  }
  st.members = { ...st.members, [p.guild.id]: mm };
  st.users = users;
}

function upsertMessage(list: Message[] | undefined, msg: Message): Message[] {
  const arr = list ? [...list] : [];
  if (msg.nonce) {
    const pi = arr.findIndex((m) => m.pending && m.nonce === msg.nonce);
    if (pi >= 0) {
      arr[pi] = { ...msg, pending: false };
      return arr;
    }
  }
  const i = arr.findIndex((m) => m.id === msg.id);
  if (i >= 0) {
    arr[i] = msg;
    return arr;
  }
  // insert in order (ids are time-sortable), keeping pending ones at the end
  let at = arr.length;
  while (at > 0 && (arr[at - 1].pending || arr[at - 1].id > msg.id)) at--;
  arr.splice(at, 0, msg);
  return arr;
}

export function mentionsMe(content: string, me: User): boolean {
  return content.includes(`<@${me.id}>`) || /(^|\s)@(everyone|here)\b/.test(content);
}

type Listener = (t: string, d: any) => void;
const listeners = new Set<Listener>();
export function onEvent(l: Listener) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

// ---------- gateway events ----------

export function handleEvent(t: string, d: any) {
  const s = get();
  switch (t) {
    case "READY": {
      const st: any = { ...s, guilds: {}, channels: {}, roles: {}, members: {}, users: {}, guildOrder: [] };
      for (const g of d.guilds as GuildPayload[]) absorbGuild(g, st);
      for (const dm of d.dms as Channel[]) {
        st.channels[dm.id] = dm;
        for (const u of dm.recipients || []) st.users[u.id] = u;
      }
      st.users[d.user.id] = d.user;
      const readStates: Record<string, string> = {};
      for (const r of d.read_states) readStates[r.channel_id] = r.last_read_id;
      const presences: Record<string, string> = {};
      const games: Record<string, string> = {};
      for (const p of d.presences) {
        presences[p.user_id] = p.status;
        if (p.game) games[p.user_id] = p.game;
      }
      presences[d.user.id] = localStorage.getItem("llamble.status") || "online";
      const voiceStates: Record<string, VoiceState> = {};
      for (const v of d.voice_states) voiceStates[v.user_id] = v;
      if (st.selectedGuild !== "@me" && st.selectedGuild !== "@home" && !st.guilds[st.selectedGuild]) st.selectedGuild = "@home";
      set({ ...st, me: d.user, ready: true, readStates, presences, games, voiceStates, config: d.config, messages: {}, hasMore: {} });
      break;
    }
    case "GUILD_CREATE": {
      const st: any = { ...s };
      absorbGuild(d, st);
      set(st);
      break;
    }
    case "GUILD_UPDATE":
      set({ guilds: { ...s.guilds, [d.id]: d } });
      break;
    case "GUILD_DELETE": {
      const guilds = { ...s.guilds };
      delete guilds[d.id];
      const channels = { ...s.channels };
      for (const c of Object.values(channels)) if (c.guild_id === d.id) delete channels[c.id];
      set({ guilds, channels, guildOrder: s.guildOrder.filter((g) => g !== d.id), selectedGuild: s.selectedGuild === d.id ? "@home" : s.selectedGuild });
      break;
    }
    case "CHANNEL_CREATE":
    case "CHANNEL_UPDATE": {
      const users = { ...s.users };
      for (const u of d.recipients || []) users[u.id] = u;
      set({ channels: { ...s.channels, [d.id]: { ...s.channels[d.id], ...d } }, users });
      break;
    }
    case "CHANNEL_DELETE": {
      const channels = { ...s.channels };
      delete channels[d.id];
      set({ channels });
      break;
    }
    case "ROLE_UPDATE": {
      const list = [...(s.roles[d.guild_id] || [])];
      const i = list.findIndex((r) => r.id === d.id);
      if (i >= 0) list[i] = d;
      else list.push(d);
      list.sort((a, b) => a.position - b.position);
      set({ roles: { ...s.roles, [d.guild_id]: list } });
      break;
    }
    case "ROLE_DELETE":
      set({ roles: { ...s.roles, [d.guild_id]: (s.roles[d.guild_id] || []).filter((r) => r.id !== d.id) } });
      break;
    case "GUILD_MEMBER_ADD":
    case "GUILD_MEMBER_UPDATE": {
      const m = d as Member;
      set({
        members: { ...s.members, [m.guild_id]: { ...(s.members[m.guild_id] || {}), [m.user.id]: m } },
        users: { ...s.users, [m.user.id]: m.user },
      });
      break;
    }
    case "GUILD_MEMBER_REMOVE": {
      const mm = { ...(s.members[d.guild_id] || {}) };
      delete mm[d.user_id];
      set({ members: { ...s.members, [d.guild_id]: mm } });
      break;
    }
    case "USER_UPDATE": {
      const members = { ...s.members };
      for (const gid of Object.keys(members)) {
        if (members[gid][d.id]) members[gid] = { ...members[gid], [d.id]: { ...members[gid][d.id], user: d } };
      }
      set({ users: { ...s.users, [d.id]: d }, members, me: s.me?.id === d.id ? d : s.me });
      break;
    }
    case "MESSAGE_CREATE": {
      const msg = d as Message;
      const ch = s.channels[msg.channel_id];
      const patch: Partial<State> = {
        users: { ...s.users, [msg.author.id]: msg.author },
      };
      if (s.messages[msg.channel_id]) patch.messages = { ...s.messages, [msg.channel_id]: upsertMessage(s.messages[msg.channel_id], msg) };
      if (ch) patch.channels = { ...s.channels, [ch.id]: { ...ch, last_message_id: !ch.last_message_id || msg.id > ch.last_message_id ? msg.id : ch.last_message_id } };
      if (s.me && msg.author.id === s.me.id) patch.readStates = { ...s.readStates, [msg.channel_id]: msg.id };
      else if (s.me && (mentionsMe(msg.content, s.me) || (ch && ch.kind === "dm"))) {
        patch.mentions = { ...s.mentions, [msg.channel_id]: (s.mentions[msg.channel_id] || 0) + 1 };
      }
      const typing = s.typing[msg.channel_id];
      if (typing?.[msg.author.id]) {
        const t2 = { ...typing };
        delete t2[msg.author.id];
        patch.typing = { ...s.typing, [msg.channel_id]: t2 };
      }
      set(patch);
      break;
    }
    case "MESSAGE_UPDATE":
      if (s.messages[d.channel_id]) {
        set({ messages: { ...s.messages, [d.channel_id]: s.messages[d.channel_id].map((m) => (m.id === d.id ? { ...d } : m)) } });
      }
      break;
    case "MESSAGE_DELETE":
      if (s.messages[d.channel_id]) {
        set({ messages: { ...s.messages, [d.channel_id]: s.messages[d.channel_id].filter((m) => m.id !== d.id) } });
      }
      break;
    case "MESSAGE_DELETE_BULK":
      if (s.messages[d.channel_id]) {
        const gone = new Set<string>(d.ids);
        set({ messages: { ...s.messages, [d.channel_id]: s.messages[d.channel_id].filter((m) => !gone.has(m.id)) } });
      }
      break;
    case "CHANNEL_CLEARED":
      if (s.messages[d.channel_id]) set({ messages: { ...s.messages, [d.channel_id]: [] }, hasMore: { ...s.hasMore, [d.channel_id]: false } });
      break;
    case "REACTION_ADD":
    case "REACTION_REMOVE": {
      const list = s.messages[d.channel_id];
      if (!list) break;
      set({
        messages: {
          ...s.messages,
          [d.channel_id]: list.map((m) => {
            if (m.id !== d.message_id) return m;
            let reactions = m.reactions.map((r) => ({ ...r, users: [...r.users] }));
            const g = reactions.find((r) => r.emoji === d.emoji);
            if (t === "REACTION_ADD") {
              if (g) {
                if (!g.users.includes(d.user_id)) g.users.push(d.user_id);
              } else reactions.push({ emoji: d.emoji, users: [d.user_id] });
            } else if (g) {
              g.users = g.users.filter((u) => u !== d.user_id);
              reactions = reactions.filter((r) => r.users.length);
            }
            return { ...m, reactions };
          }),
        },
      });
      break;
    }
    case "TYPING_START": {
      if (d.user_id === s.me?.id) break;
      set({ typing: { ...s.typing, [d.channel_id]: { ...(s.typing[d.channel_id] || {}), [d.user_id]: Date.now() + 10000 } } });
      break;
    }
    case "TYPING_STOP": {
      const t = { ...(s.typing[d.channel_id] || {}) };
      delete t[d.user_id];
      set({ typing: { ...s.typing, [d.channel_id]: t } });
      break;
    }
    case "READ_STATE_UPDATE": {
      const mentions = { ...s.mentions };
      delete mentions[d.channel_id];
      set({ readStates: { ...s.readStates, [d.channel_id]: d.last_read_id }, mentions });
      break;
    }
    case "CONFIG_UPDATE":
      set({ config: { ...s.config, ...d } });
      break;
    case "PRESENCE_UPDATE": {
      const games = { ...s.games };
      if (d.status === "offline") delete games[d.user_id];
      set({ presences: { ...s.presences, [d.user_id]: d.status }, games });
      break;
    }
    case "NOTE_CREATE":
    case "NOTE_UPDATE": {
      const old = s.notes[d.id];
      // a broadcast update doesn't know my own read/dismissed state: keep what I had
      const n: Note = old && t === "NOTE_UPDATE" ? { ...d, read: d.read ?? old.read, dismissed: d.dismissed ?? old.dismissed } : d;
      set({ notes: { ...s.notes, [d.id]: n } });
      break;
    }
    case "NOTE_DELETE": {
      const notes = { ...s.notes };
      delete notes[d.id];
      set({ notes });
      break;
    }
    case "NOTE_READ": {
      const n = s.notes[d.id];
      if (n) set({ notes: { ...s.notes, [d.id]: { ...n, read_count: d.read_count } } });
      break;
    }
    case "NEWS_CREATE":
    case "NEWS_UPDATE":
      set({ news: { ...s.news, [d.id]: d } });
      break;
    case "NEWS_DELETE": {
      const news = { ...s.news };
      delete news[d.id];
      set({ news });
      break;
    }
    case "LLAMBLE_NEWS":
      set({ llambleNews: d });
      break;
    case "HIGHLIGHT_CREATE":
      set({ highlights: { ...s.highlights, [d.id]: d } });
      break;
    case "HIGHLIGHT_DELETE": {
      const highlights = { ...s.highlights };
      delete highlights[d.id];
      set({ highlights });
      break;
    }
    case "ACTIVITY_UPDATE": {
      const games = { ...s.games };
      if (d.game) games[d.user_id] = d.game;
      else delete games[d.user_id];
      set({ games });
      break;
    }
    case "VOICE_STATE_UPDATE": {
      const v = { ...s.voiceStates };
      if (d.channel_id) v[d.user_id] = d;
      else delete v[d.user_id];
      set({ voiceStates: v });
      break;
    }
    case "CALL_RING":
      set({ ringing: d });
      break;
  }
  for (const l of listeners) l(t, d);
}

// local optimistic helpers
export function addPending(msg: Message) {
  const s = get();
  set({ messages: { ...s.messages, [msg.channel_id]: [...(s.messages[msg.channel_id] || []), msg] } });
}
export function patchPending(channelId: string, nonce: string, patch: Partial<Message>) {
  const s = get();
  const list = s.messages[channelId];
  if (!list) return;
  set({ messages: { ...s.messages, [channelId]: list.map((m) => (m.pending && m.nonce === nonce ? { ...m, ...patch } : m)) } });
}
export function removePending(channelId: string, nonce: string) {
  const s = get();
  const list = s.messages[channelId];
  if (!list) return;
  set({ messages: { ...s.messages, [channelId]: list.filter((m) => !(m.pending && m.nonce === nonce)) } });
}
export function setMessages(channelId: string, older: Message[], hasMore: boolean, replace = false) {
  const s = get();
  const existing = replace ? [] : s.messages[channelId] || [];
  const ids = new Set(existing.map((m) => m.id));
  const merged = [...older.filter((m) => !ids.has(m.id)), ...existing].sort((a, b) => (a.pending ? 1 : b.pending ? -1 : a.id < b.id ? -1 : 1));
  set({ messages: { ...s.messages, [channelId]: merged }, hasMore: { ...s.hasMore, [channelId]: hasMore } });
}
