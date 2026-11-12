// Recordings kept on this device (Library → Recordings).
// A show recorded on "my app" is written here as it records, a few seconds at a time, so a
// crash keeps everything up to the last few seconds. Nothing goes to the server until the
// person shares it (Add to Highlights / Publish as a Show / Post the video): see shareUpload.
//  - Windows app: a real file in the Videos\Llamble folder (plus a small .json beside it)
//  - browsers (incl. Android): the browser's own storage for this site (IndexedDB)
import { session } from "./api";
import { androidSave, isAndroidApp } from "./android";

export interface RecMeta {
  id: string;
  title: string;
  channel_id: string;
  channel_name?: string;
  server_name?: string;
  started_at: number;
  ended_at?: number | null;
  mime?: string;
  /** "clip": recorded on this PC by the native recorder (just you, not a show) */
  kind?: string;
  sound?: string;
}
export interface LocalRec {
  id: string;
  size: number;
  meta: RecMeta;
}

type NativeRec = {
  begin: (id: string, meta: RecMeta) => Promise<boolean>;
  append: (id: string, data: ArrayBuffer) => Promise<number>;
  meta: (id: string, meta: RecMeta) => Promise<boolean>;
  list: () => Promise<LocalRec[]>;
  read: (id: string, offset: number, length: number) => Promise<ArrayBuffer>;
  remove: (id: string) => Promise<boolean>;
  reveal: (id: string) => Promise<boolean>;
  folder: () => Promise<string>;
};
const native = (): NativeRec | undefined => (window as any).llambleNative?.recordings;

/** Where this device keeps recordings, in words. */
export async function whereKept(): Promise<string> {
  const n = native();
  if (n) return n.folder();
  return "this browser's storage for this site";
}

// ---------------------------------------------------------------- browser (IndexedDB)

let dbp: Promise<IDBDatabase> | null = null;
function db(): Promise<IDBDatabase> {
  if (!dbp)
    dbp = new Promise((res, rej) => {
      const r = indexedDB.open("llamble-recordings", 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        d.createObjectStore("meta", { keyPath: "id" });
        d.createObjectStore("pieces"); // key: [id, seq]
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  return dbp;
}
function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((res, rej) => {
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function store(name: "meta" | "pieces", mode: IDBTransactionMode) {
  return (await db()).transaction(name, mode).objectStore(name);
}
const idbSeq: Record<string, number> = {};

async function idbPieces(id: string): Promise<Blob[]> {
  const s = await store("pieces", "readonly");
  return req(s.getAll(IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]))) as Promise<Blob[]>;
}

// ---------------------------------------------------------------- the same API for both

export async function begin(meta: RecMeta) {
  const n = native();
  if (n) {
    await n.begin(meta.id, meta);
    return;
  }
  // ask the browser not to clear this site's storage when space runs low
  navigator.storage?.persist?.().catch(() => {});
  const m = await store("meta", "readwrite");
  await req(m.put({ ...meta, size: 0 }));
  idbSeq[meta.id] = 0;
}

/** Add the next piece; returns the size so far. */
export async function append(id: string, piece: Blob): Promise<number> {
  const n = native();
  if (n) return n.append(id, await piece.arrayBuffer());
  const seq = idbSeq[id] ?? (idbSeq[id] = (await idbPieces(id)).length);
  idbSeq[id] = seq + 1;
  const p = await store("pieces", "readwrite");
  await req(p.put(piece, [id, seq]));
  const m = await store("meta", "readwrite");
  const cur = (await req(m.get(id))) as any;
  const size = (cur?.size || 0) + piece.size;
  await req(m.put({ ...(cur || { id }), size }));
  return size;
}

export async function updateMeta(meta: RecMeta) {
  const n = native();
  if (n) {
    await n.meta(meta.id, meta);
    return;
  }
  const m = await store("meta", "readwrite");
  const cur = (await req(m.get(meta.id))) as any;
  await req(m.put({ ...(cur || {}), ...meta }));
}

export async function list(): Promise<LocalRec[]> {
  const n = native();
  if (n) return n.list().catch(() => []);
  try {
    const m = await store("meta", "readonly");
    const all = (await req(m.getAll())) as (RecMeta & { size: number })[];
    return all.map(({ size, ...meta }) => ({ id: meta.id, size: size || 0, meta })).sort((a, b) => b.meta.started_at - a.meta.started_at);
  } catch {
    return [];
  }
}

export async function remove(id: string) {
  const n = native();
  if (n) {
    await n.remove(id);
    return;
  }
  const p = await store("pieces", "readwrite");
  await req(p.delete(IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER])));
  const m = await store("meta", "readwrite");
  await req(m.delete(id));
}

/** Something a <video> can play. Browsers: revoke it when done (URL.revokeObjectURL). */
export async function playUrl(id: string): Promise<string> {
  if (native()) return `llamble-asset://recordings/${encodeURIComponent(id)}.webm`;
  return URL.createObjectURL(new Blob(await idbPieces(id), { type: "video/webm" }));
}

/** Save a copy where the person wants it (Windows app: show it in its folder). */
export async function download(id: string, name: string) {
  const n = native();
  if (n) {
    await n.reveal(id);
    return;
  }
  const file = (name.replace(/[^\w \-]/g, "") || "show") + ".webm";
  if (isAndroidApp) {
    // the Android app saves it to Downloads (its WebView can't download blob: links)
    await androidSave(new Blob(await idbPieces(id), { type: "video/webm" }), file);
    return;
  }
  const url = await playUrl(id);
  const a = document.createElement("a");
  a.href = url;
  a.download = file;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** The recording in upload-sized pieces, in order. */
async function* pieces(id: string, size: number): AsyncGenerator<Blob> {
  const n = native();
  if (n) {
    const step = 8 * 1024 * 1024;
    for (let off = 0; off < size; off += step) yield new Blob([await n.read(id, off, Math.min(step, size - off))]);
    return;
  }
  // join small pieces so each upload is a few MB
  let batch: Blob[] = [];
  let bytes = 0;
  for (const p of await idbPieces(id)) {
    batch.push(p);
    bytes += p.size;
    if (bytes >= 8 * 1024 * 1024) {
      yield new Blob(batch);
      batch = [];
      bytes = 0;
    }
  }
  if (batch.length) yield new Blob(batch);
}

/**
 * Put a recording kept on this device on the server (needed before it can be shared).
 * Resumable piece by piece; reports progress 0..1.
 */
export async function uploadToServer(id: string, onProgress?: (f: number) => void): Promise<void> {
  const rec = (await list()).find((r) => r.id === id);
  if (!rec) throw new Error("This recording isn't on this device.");
  const auth = { Authorization: "Bearer " + session.token };
  const post = async (path: string, body?: BodyInit, headers: Record<string, string> = {}) => {
    const r = await fetch(`${session.server}/api/shows/${id}/${path}`, { method: "POST", headers: { ...auth, ...headers }, body });
    if (!r.ok) {
      let msg = await r.text();
      try {
        msg = JSON.parse(msg).message || msg;
      } catch {}
      throw new Error(msg || r.statusText);
    }
    return r.json().catch(() => ({}));
  };
  const b = await post("upload/begin");
  if (b.already) return;
  let seq = 0;
  let sent = 0;
  for await (const piece of pieces(id, rec.size)) {
    for (let tries = 0; ; tries++) {
      try {
        await post("chunk", piece, { "x-seq": String(seq), "content-type": "application/octet-stream" });
        break;
      } catch (e) {
        if (tries >= 5) throw e;
        await new Promise((r) => setTimeout(r, 1000 * 2 ** tries));
      }
    }
    seq++;
    sent += piece.size;
    onProgress?.(sent / Math.max(1, rec.size));
  }
  await post("upload/done", JSON.stringify({ size: sent }), { "content-type": "application/json" });
}
