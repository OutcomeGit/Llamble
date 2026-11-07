import { useEffect, useRef, useState } from "react";
import { api, media, upload } from "../api";
import { EMOJI, pushRecentEmoji, recentEmoji, searchEmoji } from "../emoji";
import type { GifItem } from "../types";
import { openModal, toast } from "../ui";
import { Icon, useClickOutside } from "./common";

export function EmojiPicker({ onPick, onClose }: { onPick: (e: string) => void; onClose: () => void }) {
  const [q, setQ] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  useClickOutside(ref, onClose);
  const recent = recentEmoji();
  const pick = (e: string) => {
    pushRecentEmoji(e);
    onPick(e);
  };
  return (
    <div className="picker emoji-picker" ref={ref} onKeyDown={(e) => e.key === "Escape" && onClose()}>
      <input className="picker-search" placeholder="Find the perfect emoji" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
      <div className="picker-scroll">
        {q ? (
          <div className="emoji-grid">
            {searchEmoji(q, 120).map((x) => (
              <button key={x.e} title={`:${x.n}:`} onClick={() => pick(x.e)}>
                {x.e}
              </button>
            ))}
          </div>
        ) : (
          <>
            {recent.length > 0 && (
              <>
                <div className="picker-cat">Frequently Used</div>
                <div className="emoji-grid">
                  {recent.map((e) => (
                    <button key={e} onClick={() => pick(e)}>
                      {e}
                    </button>
                  ))}
                </div>
              </>
            )}
            {EMOJI.map((c) => (
              <div key={c.category}>
                <div className="picker-cat">{c.category}</div>
                <div className="emoji-grid">
                  {c.items.map((x) => (
                    <button key={x.e} title={`:${x.n}:`} onClick={() => pick(x.e)}>
                      {x.e}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

export function GifPicker({ onPick, onClose }: { onPick: (g: GifItem) => void; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [tab, setTab] = useState<"all" | "fav">("all");
  const [items, setItems] = useState<GifItem[] | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  useClickOutside(ref, onClose);

  const load = () => {
    const params = new URLSearchParams({ limit: "60" });
    if (q.trim()) params.set("q", q.trim());
    if (tab === "fav") params.set("favorites", "true");
    api<GifItem[]>(`/api/gifs?${params}`).then(setItems).catch(() => setItems([]));
  };
  useEffect(() => {
    const t = setTimeout(load, 200);
    return () => clearTimeout(t);
  }, [q, tab]);

  const toggleFav = async (g: GifItem, e: React.MouseEvent) => {
    e.stopPropagation();
    await api(`/api/gifs/${g.id}/favorite`, { method: g.favorite ? "DELETE" : "PUT" });
    load();
  };

  const uploadGif = async (f: File) => {
    try {
      const fo = await upload(f, f.name);
      openModal({ kind: "saveGif", fileId: fo.id, preview: fo.url });
      onClose();
    } catch (err: any) {
      toast(err.message, "error");
    }
  };

  return (
    <div className="picker gif-picker" ref={ref} onKeyDown={(e) => e.key === "Escape" && onClose()}>
      <div className="gif-top">
        <input className="picker-search" placeholder="Search the server's GIF library" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
        <div className="gif-tabs">
          <button className={tab === "all" ? "on" : ""} onClick={() => setTab("all")}>
            All
          </button>
          <button className={tab === "fav" ? "on" : ""} onClick={() => setTab("fav")}>
            <Icon name="star" size={14} /> Favorites
          </button>
          <div className="grow" />
          <button onClick={() => fileRef.current?.click()} title="Add a GIF to the library">
            <Icon name="plus" size={14} /> Add GIF
          </button>
          <button onClick={() => (openModal({ kind: "saveGif" }), onClose())} title="Import from a link">
            <Icon name="link" size={14} /> From link
          </button>
          <input ref={fileRef} type="file" accept="image/gif,image/webp,video/mp4,video/webm" hidden onChange={(e) => e.target.files?.[0] && uploadGif(e.target.files[0])} />
        </div>
      </div>
      <div className="picker-scroll">
        {items === null ? (
          <div className="muted pad">Loading…</div>
        ) : items.length === 0 ? (
          <div className="muted pad center">
            {q ? "No GIFs match that." : "The library is empty. Add GIFs here, or right-click any GIF in chat → Save GIF to library."}
          </div>
        ) : (
          <div className="gif-grid">
            {items.map((g) => (
              <div key={g.id} className="gif-cell" onClick={() => onPick(g)} title={g.title || g.tags}>
                {g.file.mime.startsWith("video/") ? <video src={media(g.file.url)} autoPlay loop muted playsInline /> : <img src={media(g.file.url)} loading="lazy" alt={g.title} />}
                <button className={"gif-fav" + (g.favorite ? " on" : "")} onClick={(e) => toggleFav(g, e)} title="Favorite">
                  <Icon name="star" size={16} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
