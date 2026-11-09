// News on boards: from the instance (its admins and news writers), from each server
// (people with "Post news"), and from the Llamble project (signed; shown if allowed).
import { useMemo, useState } from "react";
import { media, upload } from "../api";
import { Markdown } from "../markdown";
import { ago, deleteNews, editNews, postNews, type NewsDraft } from "../notes";
import { can, useStore } from "../store";
import { P, type NewsItem, type User } from "../types";
import { toast } from "../ui";
import { Avatar } from "./common";

export function canWriteInstanceNews(me: User | null | undefined): boolean {
  return !!me && (me.is_admin || me.instance_role === "master" || me.instance_role === "admin" || !!me.news_writer);
}

/** Which news a board shows: Home = instance + my servers (that I follow) + Llamble; a server = its own. */
export type NewsView = "all" | "instance" | "llamble";

export function NewsSection({ scope, view = "all" }: { scope: string; view?: NewsView }) {
  const home = scope === "@home";
  const me = useStore((s) => s.me);
  const news = useStore((s) => s.news);
  const guilds = useStore((s) => s.guilds);
  const prefs = useStore((s) => s.boardPrefs);
  const llamble = useStore((s) => s.llambleNews);
  const [writing, setWriting] = useState<NewsItem | "new" | null>(null);

  const list = useMemo(() => {
    const out: NewsItem[] = [];
    for (const n of Object.values(news)) {
      if (home) {
        if (n.scope === "instance" && view !== "llamble") out.push(n);
        else if (n.scope === "guild" && view === "all" && n.guild_id && guilds[n.guild_id] && prefs.guilds[n.guild_id]?.news !== false) out.push(n);
      } else if (n.scope === "guild" && n.guild_id === scope) out.push(n);
    }
    if (home && view !== "instance" && llamble?.enabled && prefs.llamble_news) out.push(...llamble.items);
    return out.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.created_at - a.created_at);
  }, [news, guilds, prefs, llamble, home, scope, view]);

  const [source, setSource] = useState<string>("all"); // all | llamble | instance | <guild id>
  const sources = useMemo(() => {
    const ids = new Set<string>();
    for (const n of list) ids.add(n.scope === "guild" ? n.guild_id || "" : n.scope);
    return [...ids];
  }, [list]);
  const shown = source === "all" ? list : list.filter((n) => (n.scope === "guild" ? n.guild_id : n.scope) === source);
  const mayWrite = home ? view !== "llamble" && canWriteInstanceNews(me) : can(scope, P.POST_NEWS);
  const title = !home ? "News" : view === "instance" ? "Instance news" : view === "llamble" ? "Llamble news" : "News";

  if (!list.length && !mayWrite && view === "all") return null;
  return (
    <section className="hb-section" data-hb-section="news">
      <div className="hb-section-head">
        <h2 className="hb-label">{title}</h2>
        {mayWrite && (
          <button className="hb-new" onClick={() => setWriting("new")}>
            + Write news
          </button>
        )}
      </div>
      {home && view === "llamble" && llamble && !llamble.enabled && <div className="hb-paper-note">This instance doesn't show Llamble news.</div>}
      {home && view === "llamble" && llamble?.enabled && !prefs.llamble_news && (
        <div className="hb-paper-note">You've turned Llamble news off. Turn it back on in Customize (top right).</div>
      )}
      {home && view === "llamble" && llamble?.error && <div className="hb-paper-note">Couldn't get Llamble news: {llamble.error}</div>}
      {home && sources.length > 1 && (
        <div className="hb-chips">
          {["all", ...sources].map((k) => (
            <button key={k} className={"hb-chip" + (source === k ? " on" : "")} onClick={() => setSource(k)}>
              {k === "all" ? "All" : k === "llamble" ? "🦙 Llamble" : k === "instance" ? "📢 Instance" : guilds[k]?.name || "Server"}
            </button>
          ))}
        </div>
      )}
      <div className="hb-news-list">
        {shown.map((n) => (
          <NewsCard key={n.id} n={n} serverName={n.guild_id ? guilds[n.guild_id]?.name : undefined} onEdit={() => setWriting(n)} />
        ))}
        {!list.length && (
          <div className="hb-newspaper hb-empty-news">
            <div className="hb-news-title">No news yet</div>
            <div className="hb-news-body">{mayWrite ? "Write the first story with “+ Write news”." : "Nothing has been posted here yet."}</div>
          </div>
        )}
      </div>
      {writing && <NewsComposer guildId={home ? null : scope} item={writing === "new" ? null : writing} onClose={() => setWriting(null)} />}
    </section>
  );
}

function NewsCard({ n, serverName, onEdit }: { n: NewsItem; serverName?: string; onEdit: () => void }) {
  const me = useStore((s) => s.me);
  const mine = !!n.author && n.author.id === me?.id;
  const admin = n.scope === "instance" ? canWriteInstanceNews(me) && (mine || me?.is_admin || me?.instance_role === "master" || me?.instance_role === "admin") : n.scope === "guild" && !!n.guild_id && can(n.guild_id, P.MANAGE_MESSAGES);
  const tag = n.scope === "llamble" ? "Llamble" : n.scope === "instance" ? "Instance" : serverName || "Server";
  const remove = async () => {
    if (!window.confirm(`Delete "${n.title}"?`)) return;
    try {
      await deleteNews(n.id);
    } catch (e: any) {
      toast(e.message, "error");
    }
  };
  return (
    <article className={"hb-newspaper" + (n.pinned ? " hb-news-pinned" : "") + (n.scope === "llamble" ? " hb-news-llamble" : "")}>
      {n.pinned && <span className="hb-news-ribbon">Pinned</span>}
      <div className="hb-news-meta">
        <span className={"hb-news-tag hb-news-tag-" + n.scope}>{tag}</span>
        <span>{ago(n.created_at)}</span>
        {n.edited_at && <span>· edited</span>}
      </div>
      <h3 className="hb-news-title">{n.url ? <a href={n.url} target="_blank" rel="noreferrer">{n.title}</a> : n.title}</h3>
      {n.image && <img className="hb-news-img" src={media(n.image.url)} alt="" loading="lazy" />}
      <div className="hb-news-body">
        <Markdown text={n.body} guildId={n.guild_id} />
      </div>
      <div className="hb-news-foot">
        {n.author ? (
          <span className="hb-news-by">
            <Avatar user={n.author} size={18} /> {n.author.display_name}
          </span>
        ) : (
          <span className="hb-news-by">🦙 The Llamble project</span>
        )}
        {(mine || admin) && n.scope !== "llamble" && (
          <span className="hb-news-tools">
            {mine && (
              <button className="hb-linkbtn" onClick={onEdit}>
                Edit
              </button>
            )}
            <button className="hb-linkbtn" onClick={remove}>
              Delete
            </button>
          </span>
        )}
      </div>
    </article>
  );
}

/** Write or edit a news story (guildId null = instance news). */
function NewsComposer({ guildId, item, onClose }: { guildId: string | null; item: NewsItem | null; onClose: () => void }) {
  const [draft, setDraft] = useState<NewsDraft>({ title: item?.title || "", body: item?.body || "", image_id: item?.image?.id ?? null, pinned: item?.pinned ?? false });
  const [preview, setPreview] = useState<string | null>(item?.image ? media(item.image.url) : null);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const pickImage = async (f: File | undefined) => {
    if (!f) return;
    if (!f.type.startsWith("image/")) return toast("Pick a picture", "error");
    setUploading(true);
    try {
      const up = await upload(f, f.name);
      setDraft((d) => ({ ...d, image_id: up.id }));
      setPreview(media(up.url));
    } catch (e: any) {
      toast(e.message, "error");
    } finally {
      setUploading(false);
    }
  };
  const save = async () => {
    if (!draft.title.trim()) return toast("Give it a headline", "error");
    setBusy(true);
    try {
      if (item) await editNews(item.id, { ...draft, title: draft.title.trim() });
      else await postNews(guildId, { ...draft, title: draft.title.trim() });
      onClose();
    } catch (e: any) {
      toast(e.message, "error");
      setBusy(false);
    }
  };
  return (
    <div className="hb-modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="hb-modal">
        <h2>{item ? "Edit news" : guildId ? "Write server news" : "Write instance news"}</h2>
        <input autoFocus placeholder="Headline" maxLength={200} value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
        <textarea
          placeholder="What's happening? (markdown works: **bold**, links, lists)"
          rows={8}
          maxLength={8000}
          value={draft.body}
          onChange={(e) => setDraft({ ...draft, body: e.target.value })}
        />
        <div className="row gap center-v" style={{ flexWrap: "wrap" }}>
          <label className="btn small">
            {uploading ? "Uploading…" : preview ? "Change picture" : "Add a picture"}
            <input type="file" accept="image/*" hidden onChange={(e) => pickImage(e.target.files?.[0])} />
          </label>
          {preview && (
            <button
              className="btn small"
              onClick={() => {
                setDraft({ ...draft, image_id: null });
                setPreview(null);
              }}
            >
              Remove picture
            </button>
          )}
          <label className="row gap center-v" style={{ marginLeft: "auto" }}>
            <input type="checkbox" checked={!!draft.pinned} onChange={(e) => setDraft({ ...draft, pinned: e.target.checked })} /> Pin to the top
          </label>
        </div>
        {preview && <img className="hb-news-img" src={preview} alt="" />}
        <div className="row gap" style={{ justifyContent: "flex-end" }}>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || uploading} onClick={save}>
            {item ? "Save" : "Post"}
          </button>
        </div>
      </div>
    </div>
  );
}

const FEATURE_DAYS = 14;
/** New Llamble announcements get a featured banner at the top of Home's board until seen. */
export function FeaturedLlambleNews() {
  const llamble = useStore((s) => s.llambleNews);
  const prefs = useStore((s) => s.boardPrefs);
  const [seen, setSeen] = useState(() => localStorage.getItem("llamble.featuredSeen") || "");
  if (!llamble?.enabled || !prefs.llamble_news) return null;
  const n = [...llamble.items].sort((a, b) => b.created_at - a.created_at)[0];
  if (!n || n.id === seen || Date.now() - n.created_at > FEATURE_DAYS * 864e5) return null;
  const close = () => {
    localStorage.setItem("llamble.featuredSeen", n.id);
    setSeen(n.id);
  };
  return (
    <div className="hb-featured" role="region" aria-label="Llamble announcement">
      <img src="./icon-192.png" alt="" className="hb-featured-logo" />
      <div className="hb-featured-text">
        <div className="hb-featured-kicker">New from Llamble</div>
        <div className="hb-featured-title">{n.title}</div>
        {n.body && <div className="hb-featured-body">{n.body.replace(/[#*_`>]/g, "").slice(0, 220)}</div>}
      </div>
      <div className="hb-featured-actions">
        {n.url && (
          <a className="hb-featured-btn" href={n.url} target="_blank" rel="noreferrer">
            Read more
          </a>
        )}
        <button className="hb-featured-x" title="Got it" onClick={close}>
          ✕
        </button>
      </div>
    </div>
  );
}
