export interface User {
  id: string;
  username: string;
  display_name: string;
  avatar_file_id: string | null;
  is_admin: boolean;
  is_bot?: boolean;
}

export interface Guild {
  id: string;
  name: string;
  icon_file_id: string | null;
  owner_id: string;
  created_at: number;
}

export interface Role {
  id: string;
  guild_id: string;
  name: string;
  color: number;
  permissions: number;
  position: number;
  hoist: boolean;
}

export type ChannelKind = "text" | "voice" | "category" | "dm";

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
  type: "link" | "image" | "video" | "gifv";
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
  ADMINISTRATOR: 1 << 30,
};
export const ALL_PERMS = 2 ** 31 - 1;

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
  [P.MANAGE_GUILD, "Manage Server", "Rename the server, manage invites and nicknames"],
  [P.KICK, "Kick Members", "Remove members from the server"],
  [P.BAN, "Ban Members", "Permanently ban members"],
  [P.ADMINISTRATOR, "Administrator", "Every permission. Grant carefully."],
];

declare global {
  interface Window {
    parleyNative?: {
      platform: string;
      getScreenSources: () => Promise<{ id: string; name: string; kind: "screen" | "window"; thumbnail: string | null; icon: string | null }[]>;
      setScreenSource: (c: { id: string; audio: boolean }) => Promise<boolean>;
      flash: () => void;
      setUnread: (n: number) => void;
      focus: () => void;
      isFocused: () => Promise<boolean>;
      version: () => Promise<string>;
      setAutostart: (on: boolean) => void;
      quit: () => void;
      onHotkey: (cb: (k: string) => void) => () => void;
      onInvite: (cb: (code: string) => void) => () => void;
      pickFile: (opts?: { title?: string; filters?: { name: string; extensions: string[] }[] }) => Promise<string | null>;
      llm: {
        gpus: () => Promise<Gpu[]>;
        start: (cfg: unknown) => Promise<LlmStatus>;
        stop: () => Promise<void>;
        status: () => Promise<{ status: LlmStatus; log: string[] }>;
        chat: (job: unknown) => void;
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
