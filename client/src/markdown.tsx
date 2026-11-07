import React, { useState } from "react";
import { memberName, useStore } from "./store";

type Rule = { re: RegExp; render: (m: RegExpExecArray, key: string, ctx: Ctx) => React.ReactNode };
interface Ctx {
  guildId: string | null;
}

function Spoiler({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <span className={"md-spoiler" + (open ? " open" : "")} onClick={() => setOpen(true)}>
      {children}
    </span>
  );
}

function Mention({ id, guildId }: { id: string; guildId: string | null }) {
  const user = useStore((s) => s.users[id]);
  return <span className="md-mention">@{user ? memberName(guildId, user) : "unknown-user"}</span>;
}

function safeHref(u: string): string | null {
  try {
    const url = new URL(u);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

const rules: Rule[] = [
  { re: /`([^`\n]+)`/, render: (m, k) => <code key={k} className="md-code">{m[1]}</code> },
  { re: /\|\|([\s\S]+?)\|\|/, render: (m, k, c) => <Spoiler key={k}>{inline(m[1], k, c)}</Spoiler> },
  { re: /\*\*\*([\s\S]+?)\*\*\*/, render: (m, k, c) => <strong key={k}><em>{inline(m[1], k, c)}</em></strong> },
  { re: /\*\*([\s\S]+?)\*\*/, render: (m, k, c) => <strong key={k}>{inline(m[1], k, c)}</strong> },
  { re: /__([\s\S]+?)__/, render: (m, k, c) => <u key={k}>{inline(m[1], k, c)}</u> },
  { re: /\*([^*\s][^*]*?)\*/, render: (m, k, c) => <em key={k}>{inline(m[1], k, c)}</em> },
  { re: /(?<![\w])_([^_\s][^_]*?)_(?![\w])/, render: (m, k, c) => <em key={k}>{inline(m[1], k, c)}</em> },
  { re: /~~([\s\S]+?)~~/, render: (m, k, c) => <s key={k}>{inline(m[1], k, c)}</s> },
  {
    re: /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/,
    render: (m, k) => {
      const href = safeHref(m[2]);
      return href ? <a key={k} href={href} target="_blank" rel="noreferrer" title={href}>{m[1]}</a> : m[0];
    },
  },
  {
    re: /<?(https?:\/\/[^\s<>"']+[^\s<>"'.,!?;:)\]])>?/,
    render: (m, k) => {
      const href = safeHref(m[1]);
      return href ? <a key={k} href={href} target="_blank" rel="noreferrer">{m[1]}</a> : m[0];
    },
  },
  { re: /<@([0-9a-z]{26})>/, render: (m, k, c) => <Mention key={k} id={m[1]} guildId={c.guildId} /> },
  { re: /(?<![\w])@(everyone|here)\b/, render: (m, k) => <span key={k} className="md-mention">@{m[1]}</span> },
];

function inline(text: string, key: string, ctx: Ctx): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let rest = text;
  let n = 0;
  while (rest) {
    let best: { i: number; m: RegExpExecArray; r: Rule } | null = null;
    for (const r of rules) {
      const m = r.re.exec(rest);
      if (m && (!best || m.index < best.i)) best = { i: m.index, m, r };
    }
    if (!best) {
      out.push(rest);
      break;
    }
    if (best.i > 0) out.push(rest.slice(0, best.i));
    out.push(best.r.render(best.m, `${key}.${n++}`, ctx));
    rest = rest.slice(best.i + best.m[0].length);
  }
  return out;
}

function blocks(text: string, ctx: Ctx, key: string): React.ReactNode[] {
  const lines = text.split("\n");
  const out: React.ReactNode[] = [];
  let quote: string[] = [];
  const flushQuote = () => {
    if (quote.length) {
      out.push(
        <blockquote key={`${key}q${out.length}`} className="md-quote">
          {blocks(quote.join("\n"), ctx, `${key}q${out.length}`)}
        </blockquote>,
      );
      quote = [];
    }
  };
  lines.forEach((line, i) => {
    if (line.startsWith("> ") || line === ">") {
      quote.push(line.slice(2));
      return;
    }
    flushQuote();
    const h = /^(#{1,3}) (.+)$/.exec(line);
    if (h) {
      const Tag = (["h1", "h2", "h3"] as const)[h[1].length - 1];
      out.push(<Tag key={`${key}h${i}`} className="md-h">{inline(h[2], `${key}h${i}`, ctx)}</Tag>);
      return;
    }
    const li = /^\s*[-*] (.+)$/.exec(line);
    if (li) {
      out.push(<div key={`${key}l${i}`} className="md-li">• {inline(li[1], `${key}l${i}`, ctx)}</div>);
      return;
    }
    out.push(
      <React.Fragment key={`${key}t${i}`}>
        {inline(line, `${key}t${i}`, ctx)}
        {i < lines.length - 1 ? <br /> : null}
      </React.Fragment>,
    );
  });
  flushQuote();
  return out;
}

const EMOJI_ONLY = /^(?:\p{Extended_Pictographic}|\p{Emoji_Component}|‍|️|\s)+$/u;

export function isJumbo(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 40 || /[0-9#*]/.test(t)) return false;
  return EMOJI_ONLY.test(t);
}

export function Markdown({ text, guildId }: { text: string; guildId: string | null }) {
  const ctx: Ctx = { guildId };
  const parts: React.ReactNode[] = [];
  const re = /```(?:([\w+-]{1,20})\n)?([\s\S]*?)```/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(...blocks(text.slice(last, m.index).replace(/\n$/, ""), ctx, `b${i}`));
    parts.push(
      <pre key={`c${i}`} className="md-pre">
        {m[1] ? <span className="md-lang">{m[1]}</span> : null}
        <code>{m[2].replace(/^\n/, "").replace(/\n$/, "")}</code>
      </pre>,
    );
    last = m.index + m[0].length;
    i++;
  }
  if (last < text.length) parts.push(...blocks(text.slice(last).replace(/^\n/, ""), ctx, `b${i}`));
  return <>{parts}</>;
}
