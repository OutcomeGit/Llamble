// Notes (sticky notes on each server's board) and Highlights: loading and actions.
// Live changes arrive as NOTE_* / HIGHLIGHT_* gateway events (handled in store.ts).
import { api } from "./api";
import { onEvent, useStore } from "./store";
import type { BoardPrefs, GuildBoardPrefs, Highlight, HighlightType, LlambleNews, NewsItem, Note, NoteColor } from "./types";

const set = useStore.setState;
const get = useStore.getState;

function mergeNotes(list: Note[]) {
  const notes = { ...get().notes };
  for (const n of list) notes[n.id] = n;
  set({ notes });
}

function mergeHighlights(list: Highlight[]) {
  const highlights = { ...get().highlights };
  for (const h of list) highlights[h.id] = h;
  set({ highlights });
}

function mergeNews(list: NewsItem[]) {
  const news = { ...get().news };
  for (const n of list) news[n.id] = n;
  set({ news });
}

/** Home: notes for me across my servers, recent highlights and news, and my board preferences. */
export async function loadHome() {
  loadBoardPrefs();
  loadLlambleNews();
  try {
    const r = await api<{ notes: Note[]; highlights: Highlight[]; news?: NewsItem[] }>("/api/home");
    mergeNews(r.news || []);
    // replace "for me" notes wholesale (some may have expired or been deleted while away)
    const me = get().me?.id;
    const keep = Object.fromEntries(Object.entries(get().notes).filter(([, n]) => n.author.id === me));
    set({ notes: keep });
    mergeNotes(r.notes || []);
    mergeHighlights(r.highlights || []);
  } catch {
    // older server without Home: nothing to show
  }
}

// after connecting (and every reconnect) READY arrives: refresh Home
onEvent((t) => {
  if (t === "READY") setTimeout(loadHome, 300);
});

export async function loadBoard(guildId: string) {
  const list = await api<Note[]>(`/api/guilds/${guildId}/notes`);
  // drop this server's notes we no longer see, keep everything else
  const notes = Object.fromEntries(Object.entries(get().notes).filter(([, n]) => n.guild_id !== guildId));
  for (const n of list) notes[n.id] = n;
  set({ notes });
}

export async function postNote(guildId: string, body: { content: string; color: NoteColor; to: string[]; expires_at: number | null }) {
  const n = await api<Note>(`/api/guilds/${guildId}/notes`, { body: { ...body, expires_at: body.expires_at ?? undefined } });
  mergeNotes([n]);
  return n;
}

export async function editNote(id: string, body: { content?: string; color?: NoteColor; expires_at?: number | null }) {
  const n = await api<Note>(`/api/notes/${id}`, { method: "PATCH", body });
  mergeNotes([n]);
}

export async function deleteNote(id: string) {
  await api(`/api/notes/${id}`, { method: "DELETE" });
  const notes = { ...get().notes };
  delete notes[id];
  set({ notes });
}

function patchLocal(id: string, p: Partial<Note>) {
  const n = get().notes[id];
  if (n) set({ notes: { ...get().notes, [id]: { ...n, ...p } } });
}

const reading = new Set<string>();
export function markNoteRead(id: string) {
  const n = get().notes[id];
  if (!n || n.read || reading.has(id)) return;
  reading.add(id);
  patchLocal(id, { read: true });
  api(`/api/notes/${id}/read`, { method: "POST" })
    .catch(() => patchLocal(id, { read: false }))
    .finally(() => reading.delete(id));
}

export async function dismissNote(id: string, undo = false) {
  patchLocal(id, { dismissed: !undo, read: true });
  try {
    await api(`/api/notes/${id}/${undo ? "undismiss" : "dismiss"}`, { method: "POST" });
  } catch (e) {
    patchLocal(id, { dismissed: undo });
    throw e;
  }
}

export function noteReads(id: string) {
  return api<{ user: import("./types").User; read_at: number | null; dismissed_at: number | null }[]>(`/api/notes/${id}/reads`);
}

/** `before` is a created_at time (ms): load highlights older than it. */
export async function loadHighlights(guildId: string, before?: number, limit = 30, type?: HighlightType): Promise<Highlight[]> {
  const q = new URLSearchParams({ limit: String(limit) });
  if (before) q.set("before", String(before));
  if (type) q.set("type", type);
  const list = await api<Highlight[]>(`/api/guilds/${guildId}/highlights?${q}`);
  mergeHighlights(list);
  return list;
}

export async function addHighlight(guildId: string, what: { message_id: string } | { show_id: string }) {
  const h = await api<Highlight>(`/api/guilds/${guildId}/highlights`, { body: what });
  mergeHighlights([h]);
  return h;
}

export async function removeHighlight(id: string) {
  await api(`/api/highlights/${id}`, { method: "DELETE" });
  const highlights = { ...get().highlights };
  delete highlights[id];
  set({ highlights });
}

/** "3 min ago", "yesterday", "Mar 4" */
export function ago(ms: number): string {
  const d = Date.now() - ms;
  if (d < 60_000) return "just now";
  if (d < 3_600_000) return `${Math.floor(d / 60_000)} min ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)} h ago`;
  if (d < 2 * 86_400_000) return "yesterday";
  return new Date(ms).toLocaleDateString([], { month: "short", day: "numeric" });
}

/** "expires in 3 h", "expires tomorrow 10:00 PM" */
export function expiresText(ms: number): string {
  const d = ms - Date.now();
  if (d <= 0) return "expired";
  if (d < 3_600_000) return `expires in ${Math.max(1, Math.round(d / 60_000))} min`;
  if (d < 86_400_000) return `expires in ${Math.round(d / 3_600_000)} h`;
  return "expires " + new Date(ms).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });
}

// ---- board preferences: what each server puts on my boards ----
export async function loadBoardPrefs() {
  try {
    const p = await api<BoardPrefs>("/api/board-prefs");
    set({ boardPrefs: { guilds: p.guilds || {}, llamble_news: p.llamble_news !== false } });
  } catch {
    // older server: everything on
  }
}

export async function setGuildPrefs(gid: string, patch: Partial<GuildBoardPrefs>) {
  const before = get().boardPrefs;
  const cur = before.guilds[gid] ?? { notes: true, highlights: true, news: true, highlight_types: "all" as const };
  set({ boardPrefs: { ...before, guilds: { ...before.guilds, [gid]: { ...cur, ...patch } } } });
  try {
    await api(`/api/board-prefs/${gid}`, { method: "PUT", body: patch });
  } catch (e) {
    set({ boardPrefs: before });
    throw e;
  }
}

export async function setLlambleNewsPref(on: boolean) {
  const before = get().boardPrefs;
  set({ boardPrefs: { ...before, llamble_news: on } });
  try {
    await api("/api/board-prefs/llamble", { method: "PUT", body: { on } });
  } catch (e) {
    set({ boardPrefs: before });
    throw e;
  }
}

// ---- news ----
export async function loadLlambleNews() {
  try {
    set({ llambleNews: await api<LlambleNews>("/api/news/llamble") });
  } catch {
    set({ llambleNews: null });
  }
}

export async function loadInstanceNews() {
  mergeNews(await api<NewsItem[]>("/api/news?scope=instance"));
}

export async function loadGuildNews(gid: string) {
  const list = await api<NewsItem[]>(`/api/guilds/${gid}/news`);
  const news = Object.fromEntries(Object.entries(get().news).filter(([, n]) => n.guild_id !== gid));
  for (const n of list) news[n.id] = n;
  set({ news });
}

export type NewsDraft = { title: string; body: string; image_id?: string | null; pinned?: boolean };

/** guildId null = instance news */
export async function postNews(guildId: string | null, draft: NewsDraft) {
  const n = await api<NewsItem>(guildId ? `/api/guilds/${guildId}/news` : "/api/news", { body: { ...draft, image_id: draft.image_id || undefined } });
  mergeNews([n]);
  return n;
}

export async function editNews(id: string, patch: Partial<NewsDraft>) {
  const n = await api<NewsItem>(`/api/news/${id}`, { method: "PATCH", body: patch });
  mergeNews([n]);
  return n;
}

export async function deleteNews(id: string) {
  await api(`/api/news/${id}`, { method: "DELETE" });
  const news = { ...get().news };
  delete news[id];
  set({ news });
}

/** Older servers don't label highlights: work the type out from the message. */
export function highlightType(h: Highlight): HighlightType {
  if (h.type) return h.type;
  if (h.kind === "recording") return "recordings";
  const m = h.message;
  const files = m?.attachments || [];
  if (files.some((a) => (a.mime || "").startsWith("video/"))) return "videos";
  if (files.some((a) => (a.mime || "").startsWith("image/"))) return "pictures";
  if ((m?.embeds && m.embeds.length) || /https?:\/\//.test(m?.content || "")) return "links";
  return "posts";
}
