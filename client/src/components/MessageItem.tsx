import { memo, useEffect, useRef, useState } from "react";
import { api, formatBytes, media } from "../api";
import { QUICK_REACTIONS, pushRecentEmoji } from "../emoji";
import { isJumbo, Markdown } from "../markdown";
import { can, memberName, removePending, roleColor, useStore } from "../store";
import { P, type Embed, type FileObj, type Message } from "../types";
import { copy, openMenu, openModal, setReply, toast, useUI } from "../ui";
import { Avatar, BotTag, Icon, formatTime } from "./common";
import { EmojiPicker } from "./Pickers";
import { addHighlight } from "../notes";

export const MessageItem = memo(function MessageItem({ msg, guildId, compact, readOnly }: { msg: Message; guildId: string | null; compact: boolean; readOnly?: boolean }) {
  const me = useStore((s) => s.me)!;
  const author = useStore((s) => s.users[msg.author.id]) || msg.author;
  const editing = useUI((s) => s.editing === msg.id);
  const selecting = useUI((s) => (s.selecting?.channelId === msg.channel_id ? s.selecting : null));
  const picked = !!selecting?.ids.includes(msg.id);
  const [picker, setPicker] = useState(false);
  const color = roleColor(guildId, author.id);
  const mine = author.id === me.id;
  const canManage = can(guildId, P.MANAGE_MESSAGES);
  const replyAuthor = useStore((s) => (msg.reply_to?.author_id ? s.users[msg.reply_to.author_id] : undefined));
  const mentioned = msg.content.includes(`<@${me.id}>`) || /(^|\s)@(everyone|here)\b/.test(msg.content);

  const react = (emoji: string) => {
    const r = msg.reactions.find((x) => x.emoji === emoji);
    const has = r?.users.includes(me.id);
    pushRecentEmoji(emoji);
    api(`/api/messages/${msg.id}/reactions/${encodeURIComponent(emoji)}`, { method: has ? "DELETE" : "PUT" }).catch((e) => toast(e.message, "error"));
  };

  const del = () =>
    openModal({
      kind: "confirm",
      title: "Delete Message",
      body: "Are you sure you want to delete this message?",
      danger: true,
      confirmLabel: "Delete",
      onConfirm: () => api(`/api/messages/${msg.id}`, { method: "DELETE" }),
    });

  const gifSource = (): { fileId?: string; url?: string; preview?: string } | null => {
    const a = msg.attachments.find((f) => /image\/(gif|webp)|video\/(mp4|webm)/.test(f.mime));
    if (a) return { fileId: a.id, preview: a.url };
    const e = msg.embeds.find((x) => x.type === "gifv" || (x.type === "image" && /\.gif/i.test(x.url)));
    if (e) return { url: e.url, preview: e.video?.proxy_url || e.image?.proxy_url };
    return null;
  };

  const more = (e: React.MouseEvent) => {
    const gif = gifSource();
    openMenu(e, [
      { label: "Add Reaction", onClick: () => setPicker(true) },
      { label: "Reply", onClick: () => setReply(msg.channel_id, msg) },
      { label: "Share to…", onClick: () => openModal({ kind: "share", msg }) },
      ...(guildId && !msg.pending && can(guildId, P.ADD_HIGHLIGHTS)
        ? [
            {
              label: "Add to Highlights",
              onClick: () =>
                addHighlight(guildId, { message_id: msg.id })
                  .then(() => toast("Added to Highlights"))
                  .catch((e) => toast(e.message, "error")),
            },
          ]
        : []),
      ...(mine ? [{ label: "Edit Message", onClick: () => useUI.setState({ editing: msg.id }) }] : []),
      ...(gif ? [{ label: "Save GIF to library", onClick: () => openModal({ kind: "saveGif", ...gif }) }] : []),
      { label: "Copy Text", onClick: () => copy(msg.content) },
      { label: "Copy Message ID", onClick: () => copy(msg.id, "ID copied") },
      ...(mine || canManage ? [{ separator: true, label: "" }, { label: "Delete Message", danger: true, onClick: del }] : []),
    ]);
  };

  const hideText = msg.embeds.length === 1 && (msg.embeds[0].type === "image" || msg.embeds[0].type === "gifv") && msg.content.trim() === msg.embeds[0].url;

  return (
    <div
      id={"msg-" + msg.id}
      className={"msg" + (compact ? " compact" : "") + (msg.pending ? " pending" : "") + (mentioned ? " mentioned" : "") + (picked ? " picked" : "") + (selecting ? " selectable" : "")}
      onContextMenu={readOnly || selecting ? undefined : more}
      onClickCapture={
        selecting && !readOnly && (mine || canManage)
          ? (e) => {
              e.preventDefault();
              e.stopPropagation();
              const ids = picked ? selecting.ids.filter((x) => x !== msg.id) : [...selecting.ids, msg.id];
              useUI.setState({ selecting: { ...selecting, ids } });
            }
          : undefined
      }
    >
      {selecting && !readOnly && (mine || canManage) && <input type="checkbox" className="msg-pick" checked={picked} readOnly />}
      {msg.reply_to && (
        <div className="reply-ref" onClick={() => useUI.setState({ jumpTo: msg.reply_to!.id })}>
          <span className="reply-spine" />
          {replyAuthor ? (
            <>
              <Avatar user={replyAuthor} size={16} />
              <span className="bold" style={{ color: roleColor(guildId, replyAuthor.id) }}>
                {memberName(guildId, replyAuthor)}
              </span>
              <span className="ellipsis muted">{plainMentions(msg.reply_to.content, guildId) || "Click to see attachment"}</span>
            </>
          ) : (
            <span className="muted italic">Original message was deleted</span>
          )}
        </div>
      )}
      <div className="msg-row">
        <div className="msg-gutter">
          {compact ? (
            <span className="msg-hover-time">{new Date(msg.created_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>
          ) : (
            <div onClick={() => openModal({ kind: "profile", userId: author.id, guildId })} className="clickable">
              <Avatar user={author} size={40} />
            </div>
          )}
        </div>
        <div className="msg-main">
          {!compact && (
            <div className="msg-head">
              <span className="msg-author" style={{ color }} onClick={() => openModal({ kind: "profile", userId: author.id, guildId })}>
                {memberName(guildId, author)}
              </span>
              {author.is_bot && <BotTag />}
              <span className="msg-time">{formatTime(msg.created_at)}</span>
            </div>
          )}
          {editing ? (
            <EditBox msg={msg} />
          ) : (
            msg.content &&
            !hideText && (
              <div className={"msg-content" + (isJumbo(msg.content) ? " jumbo" : "")}>
                <Markdown text={msg.content} guildId={guildId} />
                {msg.edited_at && <span className="edited" title={formatTime(msg.edited_at)}> (edited)</span>}
              </div>
            )
          )}
          {msg.localFiles?.map((f) => (
            <div key={f.name} className="upload-progress">
              <Icon name="file" size={18} /> {f.name}
              <div className="bar">
                <div style={{ width: `${Math.round(f.progress * 100)}%` }} />
              </div>
            </div>
          ))}
          {msg.failed && (
            <div className="send-failed">
              Message failed to send.{" "}
              <a href="#" onClick={(e) => (e.preventDefault(), removePending(msg.channel_id, msg.nonce!))}>
                Dismiss
              </a>
            </div>
          )}
          {msg.attachments.length > 0 && <Attachments files={msg.attachments} />}
          {msg.embeds.map((e, i) => (
            <EmbedView key={i} e={e} />
          ))}
          {msg.reactions.length > 0 && (
            <div className="reactions">
              {msg.reactions.map((r) => (
                <ReactionChip key={r.emoji} emoji={r.emoji} users={r.users} mine={r.users.includes(me.id)} onClick={() => react(r.emoji)} guildId={guildId} />
              ))}
              <button className="reaction add" onClick={() => setPicker(true)} title="Add reaction">
                <Icon name="smile" size={16} />
              </button>
            </div>
          )}
        </div>
      </div>
      {!readOnly && !msg.pending && (
        <div className="msg-toolbar">
          {QUICK_REACTIONS.slice(0, 3).map((e) => (
            <button key={e} onClick={() => react(e)} title={`React ${e}`}>
              {e}
            </button>
          ))}
          <button onClick={() => setPicker(true)} title="Add Reaction">
            <Icon name="smile" size={18} />
          </button>
          <button onClick={() => setReply(msg.channel_id, msg)} title="Reply">
            <Icon name="reply" size={18} />
          </button>
          <button onClick={() => openModal({ kind: "share", msg })} title="Share to…">
            <Icon name="share" size={18} />
          </button>
          {mine && (
            <button onClick={() => useUI.setState({ editing: msg.id })} title="Edit">
              <Icon name="edit" size={18} />
            </button>
          )}
          <button onClick={more} title="More">
            <Icon name="more" size={18} />
          </button>
        </div>
      )}
      {picker && (
        <div className="msg-picker">
          <EmojiPicker
            onPick={(e) => {
              react(e);
              setPicker(false);
            }}
            onClose={() => setPicker(false)}
          />
        </div>
      )}
    </div>
  );
});

function ReactionChip({ emoji, users, mine, onClick, guildId }: { emoji: string; users: string[]; mine: boolean; onClick: () => void; guildId: string | null }) {
  const all = useStore((s) => s.users);
  const names = users
    .slice(0, 8)
    .map((u) => memberName(guildId, all[u]))
    .join(", ");
  return (
    <button className={"reaction" + (mine ? " mine" : "")} onClick={onClick} title={names + (users.length > 8 ? ` and ${users.length - 8} more` : "")}>
      <span className="reaction-emoji">{emoji}</span>
      <span>{users.length}</span>
    </button>
  );
}

function EditBox({ msg }: { msg: Message }) {
  const [text, setText] = useState(msg.content);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const t = ref.current!;
    t.focus();
    t.setSelectionRange(t.value.length, t.value.length);
  }, []);
  const save = async () => {
    useUI.setState({ editing: null });
    if (text.trim() === msg.content.trim()) return;
    if (!text.trim() && !msg.attachments.length) return;
    try {
      await api(`/api/messages/${msg.id}`, { method: "PATCH", body: { content: text } });
    } catch (e: any) {
      toast(e.message, "error");
    }
  };
  return (
    <div className="edit-box">
      <textarea
        ref={ref}
        value={text}
        rows={Math.min(12, text.split("\n").length)}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            save();
          }
          if (e.key === "Escape") useUI.setState({ editing: null });
        }}
      />
      <div className="small muted">
        escape to <a onClick={() => useUI.setState({ editing: null })}>cancel</a> • enter to <a onClick={save}>save</a>
      </div>
    </div>
  );
}

function fit(w: number | null | undefined, h: number | null | undefined, maxW = 520, maxH = 360) {
  if (!w || !h) return {};
  const s = Math.min(1, maxW / w, maxH / h);
  return { width: Math.round(w * s), height: Math.round(h * s) };
}

function Attachments({ files }: { files: FileObj[] }) {
  const images = files.filter((f) => f.mime.startsWith("image/") && f.mime !== "image/svg+xml");
  const others = files.filter((f) => !images.includes(f));
  return (
    <div className="attachments">
      {images.length > 0 && (
        <div className={"image-grid n" + Math.min(images.length, 4)}>
          {images.map((f, i) => (
            <Spoilable key={f.id} spoiler={!!f.spoiler}>
              <img
                className="att-img"
                src={media(f.thumb_url || f.url)}
                style={images.length === 1 ? fit(f.width, f.height) : undefined}
                alt={f.filename}
                loading="lazy"
                draggable={false}
                onClick={() => useUI.setState({ lightbox: { items: images, index: i } })}
              />
            </Spoilable>
          ))}
        </div>
      )}
      {others.map((f) =>
        f.mime.startsWith("video/") ? (
          <Spoilable key={f.id} spoiler={!!f.spoiler}>
            <video className="att-video" controls preload="metadata" src={media(f.url)} poster={f.thumb_url ? media(f.thumb_url) : undefined} style={fit(f.width, f.height, 560, 400)} />
          </Spoilable>
        ) : f.mime.startsWith("audio/") ? (
          <div key={f.id} className="att-audio">
            <div className="att-file-name">
              <Icon name="file" size={18} /> {f.filename} <span className="muted small">{formatBytes(f.size)}</span>
            </div>
            <audio controls preload="metadata" src={media(f.url)} />
          </div>
        ) : (
          <a key={f.id} className="att-file" href={media(f.url)} download={f.filename}>
            <Icon name="file" size={30} />
            <div>
              <div className="att-file-name ellipsis">{f.filename}</div>
              <div className="muted small">{formatBytes(f.size)}</div>
            </div>
            <Icon name="download" size={20} />
          </a>
        ),
      )}
    </div>
  );
}

function Spoilable({ spoiler, children }: { spoiler: boolean; children: React.ReactNode }) {
  const [shown, setShown] = useState(!spoiler);
  if (shown) return <>{children}</>;
  return (
    <div className="spoiler-media" onClick={() => setShown(true)}>
      <div className="spoiler-blur">{children}</div>
      <span className="spoiler-label">SPOILER</span>
    </div>
  );
}

function EmbedView({ e }: { e: Embed }) {
  const [playing, setPlaying] = useState(false);
  if (e.type === "image" && e.image) {
    return (
      <img
        className="att-img embed-media"
        src={media(e.image.proxy_url)}
        style={fit(e.image.width, e.image.height)}
        alt=""
        loading="lazy"
        onClick={() => useUI.setState({ lightbox: { items: [{ id: e.url, filename: e.url.split("/").pop() || "image", mime: "image/*", size: 0, width: null, height: null, url: e.image!.proxy_url, thumb_url: null }], index: 0 } })}
      />
    );
  }
  if (e.type === "gifv" && (e.video || e.image)) {
    return e.video ? (
      <video className="embed-media gifv" src={media(e.video.proxy_url)} autoPlay loop muted playsInline style={fit(e.video.width, e.video.height, 400, 300)} />
    ) : (
      <img className="embed-media" src={media(e.image!.proxy_url)} style={fit(e.image!.width, e.image!.height, 400, 300)} alt="" />
    );
  }
  const border = e.color ? "#" + e.color.toString(16).padStart(6, "0") : undefined;
  const large = e.large_image || e.type === "video";
  return (
    <div className="embed" style={{ borderLeftColor: border }}>
      <div className={"embed-body" + (large ? "" : " side")}>
        <div className="embed-text">
          {e.site_name && <div className="embed-site">{e.site_name}</div>}
          {e.title && (
            <a className="embed-title" href={e.url} target="_blank" rel="noreferrer">
              {e.title}
            </a>
          )}
          {e.description && <div className="embed-desc">{e.description}</div>}
        </div>
        {e.type === "video" && e.embed_url && playing ? (
          <iframe className="embed-frame" src={e.embed_url} allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowFullScreen title={e.title || "video"} />
        ) : e.type === "video" && e.video && !e.embed_url ? (
          <video className="embed-video" controls preload="metadata" src={media(e.video.proxy_url)} poster={e.image ? media(e.image.proxy_url) : undefined} />
        ) : e.image ? (
          <div className={"embed-thumb" + (large ? " large" : "")} onClick={() => e.embed_url && setPlaying(true)}>
            <img src={media(e.image.proxy_url)} alt="" loading="lazy" />
            {e.embed_url && (
              <span className="play-btn" title={`Play (loads ${e.provider ?? "the video site"})`}>
                <Icon name="play" size={26} />
              </span>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function plainMentions(text: string, guildId: string | null): string {
  const users = useStore.getState().users;
  return text.replace(/<@([0-9a-z]{26})>/g, (_, id) => "@" + memberName(guildId, users[id]));
}
