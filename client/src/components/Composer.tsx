import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { api, formatBytes, upload } from "../api";
import { searchEmoji } from "../emoji";
import { addPending, can, memberName, patchPending, useStore } from "../store";
import { P, type Channel, type FileObj, type Message, type User } from "../types";
import { setReply, toast, useUI } from "../ui";
import { Avatar, BotTag, Icon } from "./common";
import { EmojiPicker, GifPicker } from "./Pickers";

export interface ComposerHandle {
  addFiles: (f: File[]) => void;
}

interface Draft {
  id: string;
  file: File;
  preview: string | null;
  spoiler: boolean;
}

type Suggest = { kind: "user"; items: User[] } | { kind: "emoji"; items: { e: string; n: string }[] };

const drafts: Record<string, string> = {};

export const Composer = forwardRef<ComposerHandle, { channel: Channel; placeholder: string }>(function Composer({ channel, placeholder }, ref) {
  const [text, setText] = useState(drafts[channel.id] || "");
  const [files, setFiles] = useState<Draft[]>([]);
  const [picker, setPicker] = useState<"emoji" | "gif" | null>(null);
  const [suggest, setSuggest] = useState<Suggest | null>(null);
  const [sel, setSel] = useState(0);
  const ta = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const mentionMap = useRef<Record<string, string>>({}); // "@Name" -> user id
  const lastTyping = useRef(0);
  const replyTo = useUI((s) => s.replyTo[channel.id]);
  const maxUpload = useStore((s) => s.config.max_upload_bytes);
  const canSend = can(channel.guild_id, P.SEND);
  const canAttach = can(channel.guild_id, P.ATTACH);
  const members = useStore((s) => (channel.guild_id ? s.members[channel.guild_id] : undefined));
  const recipients = channel.recipients;

  useImperativeHandle(ref, () => ({ addFiles }));

  useEffect(() => {
    drafts[channel.id] = text;
  }, [text, channel.id]);

  useEffect(() => {
    ta.current?.focus();
  }, [channel.id, replyTo]);

  // global "type anywhere to focus composer"
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable || e.ctrlKey || e.metaKey || e.altKey) return;
      if (useUI.getState().modals.length) return;
      if (e.key.length === 1) ta.current?.focus();
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, []);

  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = Math.min(el.scrollHeight, 320) + "px";
  }, [text]);

  const people: User[] = useMemo(() => {
    if (members) return Object.values(members).map((m) => m.user);
    return recipients || [];
  }, [members, recipients]);

  function addFiles(list: File[]) {
    if (!canAttach) return toast("You can't attach files here", "error");
    const ok = list.filter((f) => {
      if (f.size > maxUpload) {
        toast(`${f.name} is larger than the ${formatBytes(maxUpload)} limit`, "error");
        return false;
      }
      return true;
    });
    setFiles((cur) =>
      [...cur, ...ok.map((f) => ({ id: Math.random().toString(36).slice(2), file: f, preview: f.type.startsWith("image/") ? URL.createObjectURL(f) : null, spoiler: false }))].slice(0, 10),
    );
  }

  const updateSuggest = (value: string, caret: number) => {
    const before = value.slice(0, caret);
    const m = /(^|\s)@([\w.\- ]{0,24})$/.exec(before);
    if (m && !m[2].includes("  ")) {
      const q = m[2].toLowerCase();
      const items = people.filter((u) => u.id !== useStore.getState().me?.id && (memberName(channel.guild_id, u).toLowerCase().startsWith(q) || u.username.toLowerCase().startsWith(q))).slice(0, 8);
      setSuggest(items.length ? { kind: "user", items } : null);
      setSel(0);
      return;
    }
    const e = /(^|\s):([a-z0-9_+-]{2,})$/i.exec(before);
    if (e) {
      const items = searchEmoji(e[2], 8);
      setSuggest(items.length ? { kind: "emoji", items } : null);
      setSel(0);
      return;
    }
    setSuggest(null);
  };

  const applySuggest = (i: number) => {
    if (!suggest || !ta.current) return;
    const el = ta.current;
    const caret = el.selectionStart;
    const before = text.slice(0, caret);
    const after = text.slice(caret);
    let insert: string;
    let start: number;
    if (suggest.kind === "user") {
      const u = suggest.items[i];
      const name = "@" + memberName(channel.guild_id, u);
      mentionMap.current[name] = u.id;
      start = before.lastIndexOf("@");
      insert = name + " ";
    } else {
      start = before.lastIndexOf(":");
      insert = suggest.items[i].e + " ";
    }
    const next = before.slice(0, start) + insert + after;
    setText(next);
    setSuggest(null);
    requestAnimationFrame(() => {
      el.focus();
      const pos = start + insert.length;
      el.setSelectionRange(pos, pos);
    });
  };

  const encodeMentions = (s: string) => {
    let out = s;
    const names = Object.keys(mentionMap.current).sort((a, b) => b.length - a.length);
    for (const n of names) out = out.split(n).join(`<@${mentionMap.current[n]}>`);
    return out;
  };

  const typing = () => {
    const now = Date.now();
    if (now - lastTyping.current > 8000) {
      lastTyping.current = now;
      api(`/api/channels/${channel.id}/typing`, { method: "POST" }).catch(() => {});
    }
  };

  const send = async (override?: { attachments: { id: string }[] }) => {
    const content = encodeMentions(text).trim();
    const toUpload = override ? [] : files;
    if (!content && !toUpload.length && !override) return;
    const me = useStore.getState().me!;
    const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
    const reply = replyTo;
    const pending: Message = {
      id: "pending-" + nonce,
      nonce,
      pending: true,
      channel_id: channel.id,
      author: me,
      content,
      reply_to: reply ? { id: reply.id, author_id: reply.author.id, content: reply.content } : null,
      attachments: [],
      embeds: [],
      reactions: [],
      edited_at: null,
      created_at: Date.now(),
      localFiles: toUpload.map((f) => ({ name: f.file.name, progress: 0 })),
    };
    addPending(pending);
    setText("");
    setFiles([]);
    setReply(channel.id, undefined);
    mentionMap.current = {};
    lastTyping.current = 0;
    try {
      const uploaded: { id: string; spoiler: boolean }[] = [];
      const progress = toUpload.map(() => 0);
      for (let i = 0; i < toUpload.length; i++) {
        const d = toUpload[i];
        const fo: FileObj = await upload(d.file, d.file.name || "pasted.png", (p) => {
          progress[i] = p;
          patchPending(channel.id, nonce, { localFiles: toUpload.map((f, j) => ({ name: f.file.name, progress: progress[j] })) });
        });
        uploaded.push({ id: fo.id, spoiler: d.spoiler });
        if (d.preview) URL.revokeObjectURL(d.preview);
      }
      await api(`/api/channels/${channel.id}/messages`, {
        body: { content, nonce, reply_to: reply?.id, attachments: override ? override.attachments : uploaded },
      });
    } catch (e: any) {
      patchPending(channel.id, nonce, { failed: true, localFiles: [] });
      toast(e.message, "error");
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (suggest) {
      if (e.key === "ArrowDown") return e.preventDefault(), setSel((s) => (s + 1) % suggest.items.length);
      if (e.key === "ArrowUp") return e.preventDefault(), setSel((s) => (s - 1 + suggest.items.length) % suggest.items.length);
      if (e.key === "Tab" || e.key === "Enter") return e.preventDefault(), applySuggest(sel);
      if (e.key === "Escape") return setSuggest(null);
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    } else if (e.key === "Escape") {
      if (replyTo) setReply(channel.id, undefined);
    } else if (e.key === "ArrowUp" && !text) {
      const me = useStore.getState().me!;
      const mine = [...(useStore.getState().messages[channel.id] || [])].reverse().find((m) => m.author.id === me.id && !m.pending);
      if (mine) {
        e.preventDefault();
        useUI.setState({ editing: mine.id });
      }
    }
  };

  if (!canSend) {
    return (
      <div className="composer disabled">
        <div className="composer-box">You do not have permission to send messages in this channel.</div>
      </div>
    );
  }

  return (
    <div className="composer">
      {suggest && (
        <div className="suggest">
          <div className="suggest-head">{suggest.kind === "user" ? "Members" : "Emoji matching"}</div>
          {suggest.kind === "user"
            ? suggest.items.map((u, i) => (
                <div key={u.id} className={"suggest-row" + (i === sel ? " sel" : "")} onMouseEnter={() => setSel(i)} onMouseDown={(e) => (e.preventDefault(), applySuggest(i))}>
                  <Avatar user={u} size={24} />
                  <span className="bold">{memberName(channel.guild_id, u)}</span>
                  {u.is_bot && <BotTag />}
                  <span className="muted small">@{u.username}</span>
                </div>
              ))
            : suggest.items.map((x, i) => (
                <div key={x.e} className={"suggest-row" + (i === sel ? " sel" : "")} onMouseEnter={() => setSel(i)} onMouseDown={(e) => (e.preventDefault(), applySuggest(i))}>
                  <span className="suggest-emoji">{x.e}</span>
                  <span>:{x.n}:</span>
                </div>
              ))}
        </div>
      )}
      {replyTo && (
        <div className="reply-bar">
          Replying to <b>{memberName(channel.guild_id, replyTo.author)}</b>
          <div className="grow" />
          <button className="icon-btn tiny" onClick={() => setReply(channel.id, undefined)}>
            <Icon name="x" size={16} />
          </button>
        </div>
      )}
      <div className={"composer-box" + (replyTo ? " with-reply" : "")}>
        {files.length > 0 && (
          <div className="draft-files">
            {files.map((f) => (
              <div key={f.id} className="draft-file">
                <div className={"draft-thumb" + (f.spoiler ? " spoiler" : "")}>{f.preview ? <img src={f.preview} alt="" /> : <Icon name="file" size={36} />}</div>
                <div className="draft-name ellipsis">{f.file.name}</div>
                <div className="draft-actions">
                  <button title="Mark as spoiler" className={f.spoiler ? "on" : ""} onClick={() => setFiles((c) => c.map((x) => (x.id === f.id ? { ...x, spoiler: !x.spoiler } : x)))}>
                    👁
                  </button>
                  <button title="Remove" onClick={() => setFiles((c) => c.filter((x) => x.id !== f.id))}>
                    <Icon name="trash" size={14} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
        <div className="composer-row">
          {canAttach && (
            <button className="icon-btn composer-plus" title="Upload a file" onClick={() => fileInput.current?.click()}>
              <Icon name="plus" size={18} stroke={3} />
            </button>
          )}
          <input ref={fileInput} type="file" multiple hidden onChange={(e) => (e.target.files && addFiles(Array.from(e.target.files)), (e.target.value = ""))} />
          <textarea
            ref={ta}
            rows={1}
            value={text}
            placeholder={placeholder}
            spellCheck
            onChange={(e) => {
              setText(e.target.value);
              updateSuggest(e.target.value, e.target.selectionStart);
              if (e.target.value) typing();
            }}
            onKeyDown={onKeyDown}
            onPaste={(e) => {
              const fl = Array.from(e.clipboardData.files);
              if (fl.length) {
                e.preventDefault();
                addFiles(fl.map((f) => (f.name === "image.png" ? new File([f], `pasted-${Date.now()}.png`, { type: f.type }) : f)));
              }
            }}
            onBlur={() => setTimeout(() => setSuggest(null), 100)}
          />
          <button className={"icon-btn" + (picker === "gif" ? " on" : "")} title="GIFs" onClick={() => setPicker(picker === "gif" ? null : "gif")}>
            <Icon name="gif" size={22} />
          </button>
          <button className={"icon-btn" + (picker === "emoji" ? " on" : "")} title="Emoji" onClick={() => setPicker(picker === "emoji" ? null : "emoji")}>
            <Icon name="smile" size={22} />
          </button>
        </div>
      </div>
      {picker === "emoji" && (
        <div className="composer-picker">
          <EmojiPicker
            onPick={(e) => {
              const el = ta.current!;
              const s = el.selectionStart ?? text.length;
              setText(text.slice(0, s) + e + text.slice(el.selectionEnd ?? s));
              requestAnimationFrame(() => {
                el.focus();
                el.setSelectionRange(s + e.length, s + e.length);
              });
            }}
            onClose={() => setPicker(null)}
          />
        </div>
      )}
      {picker === "gif" && (
        <div className="composer-picker">
          <GifPicker
            onPick={(g) => {
              setPicker(null);
              send({ attachments: [{ id: g.file.id }] });
            }}
            onClose={() => setPicker(null)}
          />
        </div>
      )}
    </div>
  );
});
