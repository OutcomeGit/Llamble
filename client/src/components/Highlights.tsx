import { useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { media } from "../api";
import { Markdown } from "../markdown";
import { ago, loadHighlights, removeHighlight } from "../notes";
import { can, selectChannel, useStore } from "../store";
import { P, type Highlight } from "../types";
import { toast, useUI } from "../ui";
import { Avatar, GuildIcon, Icon } from "./common";
import { Player } from "./Show";

/** Jump to the message a highlight came from. */
export function openHighlight(h: Highlight) {
  if (!h.message || !h.channel_id) return;
  selectChannel(h.guild_id, h.channel_id);
  // the chat needs a moment to load before it can scroll to the message
  const id = h.message.id;
  setTimeout(() => useUI.setState({ jumpTo: id }), 700);
}

function Visual({ h }: { h: Highlight }) {
  if (h.recording) return <Player src={media(h.recording.url)} />;
  const m = h.message;
  if (!m) return null;
  const att = m.attachments.find((a) => /^(image|video)\//.test(a.mime));
  if (att) {
    if (att.mime.startsWith("video/")) return <video className="hl-media" src={media(att.url)} muted loop playsInline controls preload="metadata" />;
    return (
      <img
        className="hl-media"
        src={media(att.thumb_url || att.url)}
        alt={att.filename}
        loading="lazy"
        onClick={(e) => {
          e.stopPropagation();
          const items = m.attachments.filter((a) => a.mime.startsWith("image/"));
          useUI.setState({ lightbox: { items, index: Math.max(0, items.indexOf(att)) } });
        }}
      />
    );
  }
  const e = m.embeds.find((x) => x.image || x.video);
  if (e?.video) return <video className="hl-media" src={media(e.video.proxy_url)} muted loop autoPlay playsInline />;
  if (e?.image) return <img className="hl-media" src={media(e.image.proxy_url)} alt="" loading="lazy" />;
  return null;
}

export function HighlightCard({ h, showServer }: { h: Highlight; showServer?: boolean }) {
  const guild = useStore((s) => s.guilds[h.guild_id]);
  const me = useStore((s) => s.me?.id);
  const canRemove = h.added_by.id === me || can(h.guild_id, P.MANAGE_MESSAGES);
  const title = h.recording ? h.recording.title || "Show recording" : null;
  return (
    <div className={"hl-card" + (h.message ? " clickable" : "")} onClick={() => openHighlight(h)} title={h.message ? "Go to the message" : undefined}>
      <Visual h={h} />
      <div className="hl-info">
        {title && <div className="bold">🎬 {title}</div>}
        {h.message && h.message.content.trim() && (
          <div className="hl-text">
            <Markdown text={h.message.content.slice(0, 300)} guildId={h.guild_id} />
          </div>
        )}
        <div className="hl-meta">
          {showServer && guild && (
            <span className="hl-server">
              <span className="hl-guild-icon">
                <GuildIcon name={guild.name} iconId={guild.icon_file_id} size={16} />
              </span>
              {guild.name}
            </span>
          )}
          {h.message && (
            <span className="row gap center-v">
              <Avatar user={h.message.author} size={16} /> {h.message.author.display_name}
            </span>
          )}
          <span className="muted">
            {h.auto ? <span className="hl-auto">auto</span> : <>added by {h.added_by.display_name}</>} · {ago(h.created_at)}
          </span>
          {canRemove && (
            <button
              className="icon-btn tiny"
              title="Remove from Highlights"
              onClick={(e) => {
                e.stopPropagation();
                removeHighlight(h.id).catch((er) => toast(er.message, "error"));
              }}
            >
              <Icon name="trash" size={14} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** A server's Highlights: everything added there, newest first, loads more on demand. */
export function HighlightsView({ guildId }: { guildId: string }) {
  const guild = useStore((s) => s.guilds[guildId]);
  const list = useStore(
    useShallow((s) =>
      Object.values(s.highlights)
        .filter((h) => h.guild_id === guildId)
        .sort((a, b) => b.created_at - a.created_at),
    ),
  );
  const [state, setState] = useState<"loading" | "ok" | "error">("loading");
  const [more, setMore] = useState(true);
  useEffect(() => {
    setState("loading");
    loadHighlights(guildId)
      .then((l) => (setMore(l.length >= 30), setState("ok")))
      .catch(() => setState("error"));
  }, [guildId]);
  const older = async () => {
    const last = list[list.length - 1];
    try {
      const l = await loadHighlights(guildId, last?.id);
      setMore(l.length >= 30);
    } catch (e: any) {
      toast(e.message, "error");
    }
  };
  return (
    <div className="board">
      <div className="board-head">
        <h2>✨ Highlights · {guild?.name}</h2>
        <p className="muted small">The best bits of this server. Add any message with its ⋯ menu → Add to Highlights, or a show from Settings → Recordings.</p>
      </div>
      {state === "loading" && <p className="muted">Loading…</p>}
      {state === "error" && <p className="muted">Couldn't load highlights. This Llamble instance may need updating.</p>}
      {state === "ok" && !list.length && <p className="muted">Nothing here yet.</p>}
      <div className="hl-grid">
        {list.map((h) => (
          <HighlightCard key={h.id} h={h} />
        ))}
      </div>
      {state === "ok" && more && list.length > 0 && (
        <button className="btn" onClick={older} style={{ marginTop: 12 }}>
          Load older
        </button>
      )}
    </div>
  );
}
