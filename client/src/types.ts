export interface User {
  id: string;
  username: string;
  display_name: string;
  avatar_file_id: string | null;
  is_admin: boolean;
  is_bot?: boolean;
  /** master | admin | user */
  instance_role?: string;
  /** may post instance news (set by the instance admin) */
  news_writer?: boolean;
  is_kid?: boolean;
}

export interface Guild {
  id: string;
  name: string;
  icon_file_id: string | null;
  owner_id: string;
  created_at: number;
  /** add AI pictures / show recordings to the server's Highlights automatically */
  highlights_auto_pictures?: boolean;
  highlights_auto_recordings?: boolean;
}

export type NoteColor = "yellow" | "pink" | "blue" | "green" | "purple";

/** A sticky note on a server's Notes board, for everyone there or for picked people. */
export interface Note {
  id: string;
  guild_id: string;
  author: User;
  content: string;
  color: NoteColor;
  audience: "everyone" | "people";
  to: string[];
  expires_at: number | null;
  created_at: number;
  edited_at: number | null;
  /** for me */
  read: boolean;
  dismissed: boolean;
  /** for the author */
  read_count: number;
  target_count: number;
}

export interface HighlightRecording {
  id: string;
  title: string;
  url: string;
  created_at: number;
  duration_ms?: number;
}

export type HighlightType = "shows" | "pictures" | "videos" | "recordings" | "links" | "posts";

export interface Highlight {
  /** what kind of thing it is, for the type filters */
  type?: HighlightType;
  id: string;
  guild_id: string;
  kind: "message" | "recording";
  added_by: User;
  auto: boolean;
  created_at: number;
  channel_id: string | null;
  message: Message | null;
  recording: HighlightRecording | null;
}

/** News: from the instance admin (and news writers), a server, or the Llamble project (signed). */
export interface NewsItem {
  id: string;
  scope: "instance" | "guild" | "llamble";
  guild_id: string | null;
  author: User | null;
  title: string;
  body: string;
  image: { id: string; url: string; content_type: string; width?: number; height?: number } | null;
  pinned: boolean;
  created_at: number;
  edited_at: number | null;
  url?: string;
}

export interface LlambleNews {
  enabled: boolean;
  items: NewsItem[];
  fetched_at: number | null;
  error: string | null;
}

/** What each server puts on your boards (missing = everything on). */
export interface GuildBoardPrefs {
  notes: boolean;
  highlights: boolean;
  news: boolean;
  highlight_types: HighlightType[] | "all";
}

export interface BoardPrefs {
  guilds: Record<string, GuildBoardPrefs>;
  llamble_news: boolean;
}

export interface Role {
  id: string;
  guild_id: string;
  name: string;
  color: number;
  permissions: number;
  position: number;
  hoist: boolean;
  /** permissions this role takes away (Guest) */
  deny?: number;
}

export type ChannelKind = "text" | "voice" | "category" | "dm" | "party";

export interface Channel {
  id: string;
  guild_id: string | null;
  kind: ChannelKind;
  name: string;
  topic: string;
  parent_id: string | null;
  position: number;
  created_at: number;
  last_message_id: string | null;
  recipients?: User[];
  retention_days?: number | null;
  /** parties: who made it (can rename it, remove people, delete it) */
  owner_id?: string | null;
}

export interface Member {
  guild_id: string;
  user: User;
  nickname: string | null;
  roles: string[];
  joined_at: number;
}

export interface FileObj {
  id: string;
  filename: string;
  mime: string;
  size: number;
  width: number | null;
  height: number | null;
  url: string;
  thumb_url: string | null;
  spoiler?: boolean;
}

export interface EmbedMedia {
  proxy_url: string;
  width?: number | null;
  height?: number | null;
}

export interface Embed {
  type: "link" | "image" | "video" | "gifv" | "show";
  /** type "show": a published recording ("show" = a Show post, "video" = just the video) */
  style?: "show" | "video";
  show_id?: string;
  duration_ms?: number | null;
  people?: string[];
  recorded_at?: number | null;
  url: string;
  title?: string | null;
  description?: string | null;
  site_name?: string | null;
  color?: number | null;
  image?: EmbedMedia;
  video?: EmbedMedia;
  large_image?: boolean;
  provider?: string;
  embed_url?: string;
}

export interface Reaction {
  emoji: string;
  users: string[];
}

export interface Message {
  id: string;
  channel_id: string;
  author: User;
  content: string;
  reply_to: { id: string; author_id: string; content: string } | null;
  attachments: FileObj[];
  embeds: Embed[];
  reactions: Reaction[];
  edited_at: number | null;
  created_at: number;
  nonce?: string;
  // client-only
  pending?: boolean;
  failed?: boolean;
  localFiles?: { name: string; progress: number }[];
}

export interface VoiceState {
  user_id: string;
  channel_id: string;
  guild_id: string | null;
  muted: boolean;
  deafened: boolean;
  video: boolean;
  screen: boolean;
}

export interface GuildPayload {
  guild: Guild;
  channels: Channel[];
  roles: Role[];
  members: Member[];
}

export interface GifItem {
  id: string;
  title: string;
  tags: string;
  uses: number;
  uploader_id: string;
  favorite: boolean;
  file: FileObj;
}

export const P = {
  VIEW: 1 << 0,
  SEND: 1 << 1,
  ATTACH: 1 << 2,
  EMBED_LINKS: 1 << 3,
  REACT: 1 << 4,
  MANAGE_MESSAGES: 1 << 5,
  MANAGE_CHANNELS: 1 << 6,
  MANAGE_ROLES: 1 << 7,
  MANAGE_GUILD: 1 << 8,
  CREATE_INVITE: 1 << 9,
  KICK: 1 << 10,
  BAN: 1 << 11,
  CONNECT: 1 << 12,
  SPEAK: 1 << 13,
  VIDEO: 1 << 14,
  MENTION_EVERYONE: 1 << 15,
  POST_NEWS: 1 << 16,
  ADD_HIGHLIGHTS: 1 << 17,
  ADMINISTRATOR: 1 << 30,
};
export const ALL_PERMS = 2 ** 31 - 1;
/** what the Guest role takes away: read and listen only */
export const GUEST_DENY = P.SEND | P.ATTACH | P.EMBED_LINKS | P.REACT | P.SPEAK | P.VIDEO | P.CREATE_INVITE | P.MENTION_EVERYONE;

export const PERM_LABELS: [number, string, string][] = [
  [P.VIEW, "View Channels", "See channels and read messages"],
  [P.SEND, "Send Messages", "Post messages in text channels"],
  [P.ATTACH, "Attach Files", "Upload files and images"],
  [P.EMBED_LINKS, "Embed Links", "Links show rich previews"],
  [P.REACT, "Add Reactions", "React to messages with emoji"],
  [P.CONNECT, "Connect", "Join voice channels"],
  [P.SPEAK, "Speak", "Talk in voice channels"],
  [P.VIDEO, "Video & Screen Share", "Turn on camera or share screen"],
  [P.CREATE_INVITE, "Create Invite", "Invite new people"],
  [P.MANAGE_MESSAGES, "Manage Messages", "Delete other people's messages"],
  [P.MANAGE_CHANNELS, "Manage Channels", "Create, edit and delete channels"],
  [P.MANAGE_ROLES, "Manage Roles", "Create roles and assign them"],
  [P.ADD_HIGHLIGHTS, "Add to Highlights", "Pin messages and recordings to the server's Highlights"],
  [P.POST_NEWS, "Post news", "Write news for this server's Board"],
  [P.MANAGE_GUILD, "Manage Server", "Rename the server, manage invites and nicknames"],
  [P.KICK, "Kick Members", "Remove members from the server"],
  [P.BAN, "Ban Members", "Permanently ban members"],
  [P.ADMINISTRATOR, "Administrator", "Every permission. Grant carefully."],
];

export interface DetectedGame {
  name: string;
  exe: string;
  title: string;
  /** desktop capture id of the game's window ("window:<hwnd>:0") */
  sourceId: string | null;
}

declare global {
  interface Window {
    llambleNative?: {
      platform: string;
      getScreenSources: () => Promise<{ id: string; name: string; kind: "screen" | "window"; thumbnail: string | null; icon: string | null }[]>;
      setScreenSource: (c: { id: string; audio: boolean }) => Promise<boolean>;
      /** one program's sound for a screen share (Windows 10 2004+); resolves to what's captured, or null */
      nativeRec?: {
        start: (o: { id: string; sourceId: string; fps: 30 | 60; bpp: number; sound: "app" | "all" | "off"; codec?: "auto" | "h264"; title?: string }) => Promise<{ id: string; codec: string; gpu: boolean; width: number; height: number; bitrate: number; sound: string } | { error: string }>;
        stop: () => Promise<boolean>;
        on: (cb: (kind: "stat" | "done", v: { id: string; fps?: number; dropped?: number; bytes?: number; error?: string; ok?: boolean }) => void) => () => void;
      };
      appAudio?: { start: (key: string, sourceId: string, mode?: "app" | "all") => Promise<string | null>; stop: (key: string) => Promise<void> };
      flash: () => void;
      setUnread: (n: number) => void;
      focus: () => void;
      isFocused: () => Promise<boolean>;
      version: () => Promise<string>;
      setAutostart: (on: boolean) => void;
      quit: () => void;
      onHotkey: (cb: (k: string) => void) => () => void;
      onInvite: (cb: (code: string) => void) => () => void;
      onUpdateReady: (cb: (version: string) => void) => () => void;
      installUpdate: () => void;
      checkUpdate?: () => void;
      onUpdateStatus?: (cb: (s: { state: string; percent?: number; message?: string }) => void) => () => void;
      /** push-to-talk that works while other apps have focus (older versions don't have it) */
      ptt?: { start: (vk: number) => Promise<boolean>; stop: () => Promise<void>; on: (cb: (down: boolean) => void) => () => void };
      /** per-process memory/CPU for Settings → About (older app versions don't have it) */
      metrics?: () => Promise<{ label: string; what: string; pid: number; mb: number | null; cpu: number | null }[]>;
      /** game detection (Windows app; older versions don't have it) */
      games?: {
        current: () => Promise<DetectedGame[]>;
        running: () => Promise<{ exe: string; title: string; game: string | null }[]>;
        custom: () => Promise<{ enabled?: boolean; games: Record<string, string>; ignored: Record<string, boolean> }>;
        mark: (exe: string, name: string | null) => Promise<{ games: Record<string, string>; ignored: Record<string, boolean> }>;
        reset: (exe: string) => Promise<{ games: Record<string, string>; ignored: Record<string, boolean> }>;
        enable?: (on: boolean) => Promise<{ enabled: boolean }>;
        on: (cb: (g: DetectedGame[]) => void) => () => void;
      };
      /** Windows app overlay (older app versions don't have it) */
      overlay?: {
        set: (o: { show: boolean; hideWhenFocused: boolean }) => void;
        update: (snap: unknown) => void;
        edit: (on: boolean) => void;
        editShown?: () => void;
        onSnapshot: (cb: (s: any) => void) => () => void;
        onEdit: (cb: (on: boolean) => void) => () => void;
        /** main window → show (or clear with null) an alarm on the overlay */
        alarm?: (payload: unknown) => void;
        /** overlay → snooze/dismiss pressed on the overlay card */
        alarmAction?: (a: { id: string; action: "snooze" | "dismiss"; minutes?: number }) => void;
        /** overlay → let clicks through or not (for the card area) */
        interactive?: (on: boolean) => void;
        onAlarm?: (cb: (p: any) => void) => () => void;
        /** main window ← snooze/dismiss pressed on the overlay */
        onAlarmAction?: (cb: (a: { id: string; action: "snooze" | "dismiss"; minutes?: number }) => void) => () => void;
      };
      readAsset?: (name: string) => Promise<Uint8Array>;
      images?: {
        status: () => Promise<any>;
        prepare: (cfg: { model: string; files: any[]; gpu: Gpu | undefined }) => Promise<any>;
        generate: (job: any, gpu: Gpu | undefined) => Promise<Uint8Array>;
        on: (cb: (s: any) => void) => () => void;
      };
      pickFile: (opts?: { title?: string; filters?: { name: string; extensions: string[] }[] }) => Promise<string | null>;
      llm: {
        gpus: () => Promise<Gpu[]>;
        start: (cfg: unknown) => Promise<LlmStatus>;
        stop: () => Promise<void>;
        status: () => Promise<{ status: LlmStatus; log: string[] }>;
        chat: (job: unknown) => void;
        sysState: (gpuIndex?: number | null) => Promise<{ idleSeconds: number; locked: boolean; gpuUtil: number | null }>;
        on: (cb: (kind: "status" | "log" | "job", d: any) => void) => () => void;
      };
    };
  }
}

export interface Gpu {
  index: number;
  name: string;
  vram_mb: number;
  vendor: "nvidia" | "amd" | "intel" | "other";
  approximate?: boolean;
}

export interface LlmStatus {
  state: "off" | "starting" | "ready" | "error";
  error: string | null;
  port: number | null;
  url: string | null;
  model: string | null;
}

/** a friendship, or a request either way */
export interface Friend {
  user: User;
  state: "friend" | "outgoing" | "incoming";
  since: number;
  /** my private note about them */
  note?: string;
}
