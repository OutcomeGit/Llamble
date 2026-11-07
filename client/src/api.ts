import type { FileObj } from "./types";

const LS_SERVER = "parley.server";
const LS_TOKEN = "parley.token";

export const session = {
  server: (localStorage.getItem(LS_SERVER) || (location.protocol.startsWith("http") && !location.port.startsWith("517") ? location.origin : "")).replace(/\/+$/, ""),
  token: localStorage.getItem(LS_TOKEN) || "",
};

export function setSession(server: string, token: string) {
  session.server = server.replace(/\/+$/, "");
  session.token = token;
  localStorage.setItem(LS_SERVER, session.server);
  if (token) localStorage.setItem(LS_TOKEN, token);
  else localStorage.removeItem(LS_TOKEN);
}

export function normalizeServer(input: string): string {
  let s = input.trim().replace(/\/+$/, "");
  if (!s) return s;
  if (!/^https?:\/\//i.test(s)) s = (/^(localhost|\d+\.\d+\.\d+\.\d+)(:\d+)?$/.test(s) ? "http://" : "https://") + s;
  return s;
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, msg: string) {
    super(msg);
    this.status = status;
  }
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; server?: string; token?: string | null } = {}): Promise<T> {
  const server = opts.server ?? session.server;
  const token = opts.token === undefined ? session.token : opts.token;
  const headers: Record<string, string> = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  let res: Response;
  try {
    res = await fetch(server + path, {
      method: opts.method || (opts.body !== undefined ? "POST" : "GET"),
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch {
    throw new ApiError(0, "Can't reach the server");
  }
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    if (res.status === 401 && path !== "/api/auth/login") window.dispatchEvent(new Event("parley:unauthorized"));
    throw new ApiError(res.status, data?.error || `Request failed (${res.status})`);
  }
  return data as T;
}

/** Absolute URL for a server-relative media path, with the auth token attached (for <img>/<video>). */
export function media(path: string | null | undefined): string {
  if (!path) return "";
  if (/^(https?:|data:|blob:)/.test(path)) return path;
  const sep = path.includes("?") ? "&" : "?";
  return `${session.server}${path}${sep}access_token=${encodeURIComponent(session.token)}`;
}

export function avatarUrl(fileId: string | null | undefined): string {
  return fileId ? media(`/api/files/${fileId}`) : "";
}

export function upload(file: File | Blob, filename: string, onProgress?: (p: number) => void, signal?: AbortSignal): Promise<FileObj> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", session.server + "/api/files");
    xhr.setRequestHeader("Authorization", `Bearer ${session.token}`);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onload = () => {
      let data: any = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {}
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new ApiError(xhr.status, data?.error || "Upload failed"));
    };
    xhr.onerror = () => reject(new ApiError(0, "Upload failed"));
    xhr.onabort = () => reject(new ApiError(0, "Upload cancelled"));
    signal?.addEventListener("abort", () => xhr.abort());
    const fd = new FormData();
    fd.append("file", file, filename);
    xhr.send(fd);
  });
}

export function ulidTime(id: string): number {
  const A = "0123456789abcdefghjkmnpqrstvwxyz";
  let t = 0;
  for (const c of id.slice(0, 10).toLowerCase()) t = t * 32 + A.indexOf(c);
  return t;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}
