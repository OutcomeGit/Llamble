#!/usr/bin/env node
// Llamble news publisher (for the project owner only).
//
// Writes site/news.json = { payload: "<JSON string>", signature: "<base64 Ed25519 sig>" }.
// Every Llamble instance checks the signature with the public key compiled into the server
// (server/news_pubkey.txt, base64 of the 32-byte raw key). The private key never enters
// the repo: it lives in your user profile.
//
//   node tools/news-publisher/publish.mjs           open the publisher page (127.0.0.1:4791)
//   node tools/news-publisher/publish.mjs --verify  check site/news.json, exit 0/1
//
// Zero dependencies: node:crypto, node:fs, node:http, node:child_process only.

import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { execFile, spawn } from "node:child_process";
import { dirname, join, resolve, sep } from "node:path";
import { homedir, platform } from "node:os";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(here, "..", "..");
export const NEWS_FILE = join(REPO, "site", "news.json");
export const PUBKEY_FILE = join(REPO, "server", "news_pubkey.txt");
export const PORT = 4791;
const MAX_ITEMS = 50;

export function keyDir() {
  if (platform() === "win32") return join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "LlambleNewsPublisher");
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "llamble-news-publisher");
}

// ---------- keys and signing (exported for tests) ----------

/** Raw 32-byte Ed25519 public key as base64 (what the Rust verifier expects). */
export function rawPublicKeyB64(publicKey) {
  const der = publicKey.export({ type: "spki", format: "der" }); // 12-byte prefix + 32 raw bytes
  return Buffer.from(der.subarray(der.length - 32)).toString("base64");
}

/** Public KeyObject from base64 of the raw 32-byte key. */
export function publicKeyFromRaw(b64) {
  const raw = Buffer.from(String(b64).trim(), "base64");
  if (raw.length !== 32) throw new Error(`public key must be 32 bytes, got ${raw.length}`);
  const prefix = Buffer.from("302a300506032b6570032100", "hex");
  return createPublicKey({ key: Buffer.concat([prefix, raw]), format: "der", type: "spki" });
}

export function generateKeys() {
  return generateKeyPairSync("ed25519");
}

/** Check and normalize items, newest first, at most 50. Throws on bad input. */
export function cleanItems(items) {
  if (!Array.isArray(items)) throw new Error("items must be a list");
  const ids = new Set();
  const out = items.map((it, i) => {
    const id = String(it.id || "").trim();
    const title = String(it.title || "").trim();
    const body = String(it.body || "");
    if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(id)) throw new Error(`item ${i + 1}: id must be lowercase letters, digits and dashes`);
    if (ids.has(id)) throw new Error(`duplicate id ${id}`);
    ids.add(id);
    if (!title || title.length > 120) throw new Error(`"${id}": title must be 1-120 characters`);
    if (body.length > 8000) throw new Error(`"${id}": body must be at most 8000 characters`);
    const published_at = Number(it.published_at);
    if (!Number.isFinite(published_at) || published_at <= 0) throw new Error(`"${id}": bad publish date`);
    const o = { id, title, body, published_at: Math.round(published_at) };
    for (const k of ["url", "image"]) {
      const v = String(it[k] || "").trim();
      if (v) {
        if (!/^https:\/\/[^\s]+$/.test(v)) throw new Error(`"${id}": ${k} must start with https://`);
        o[k] = v;
      }
    }
    return o;
  });
  out.sort((a, b) => b.published_at - a.published_at);
  if (out.length > MAX_ITEMS) throw new Error(`at most ${MAX_ITEMS} items (you have ${out.length}); delete old ones`);
  return out;
}

/** Build the signed file contents. */
export function signNews(items, privateKey) {
  const payload = JSON.stringify({ version: 1, items: cleanItems(items) });
  const signature = sign(null, Buffer.from(payload, "utf8"), privateKey).toString("base64");
  return { payload, signature };
}

/** Verify a parsed news.json object; returns the items or throws. */
export function verifyNews(file, publicKeyB64) {
  if (!file || typeof file.payload !== "string" || typeof file.signature !== "string") throw new Error("not a signed news file");
  const sig = Buffer.from(file.signature, "base64");
  if (sig.length !== 64) throw new Error("signature must be 64 bytes");
  const ok = verify(null, Buffer.from(file.payload, "utf8"), publicKeyFromRaw(publicKeyB64), sig);
  if (!ok) throw new Error("signature does not match the public key");
  const data = JSON.parse(file.payload);
  if (data.version !== 1 || !Array.isArray(data.items)) throw new Error("unknown news format");
  return data.items;
}

// ---------- files ----------

function readPubkey() {
  try {
    return readFileSync(PUBKEY_FILE, "utf8").trim();
  } catch {
    return "";
  }
}

function readNews() {
  if (!existsSync(NEWS_FILE)) return { items: [], status: "none", message: "No site/news.json yet." };
  let file;
  try {
    file = JSON.parse(readFileSync(NEWS_FILE, "utf8"));
  } catch (e) {
    return { items: [], status: "bad", message: "site/news.json isn't valid JSON: " + e.message };
  }
  const pub = readPubkey();
  try {
    if (!pub) throw new Error("server/news_pubkey.txt is empty");
    return { items: verifyNews(file, pub), status: "verified", message: "verified ✓" };
  } catch (e) {
    let items = [];
    try {
      items = JSON.parse(file.payload).items || [];
    } catch {}
    return { items, status: "unverified", message: "Not verified: " + e.message };
  }
}

function isInside(child, parent) {
  const c = resolve(child) + sep;
  const p = resolve(parent) + sep;
  return c.startsWith(p);
}

/** Load the private key, creating it (and writing the public key into the repo) on first run. */
function loadOrCreateKey() {
  const dir = keyDir();
  if (isInside(dir, REPO) || isInside(REPO, dir)) {
    throw new Error(`refusing to run: the key folder (${dir}) and the repo (${REPO}) must not contain each other`);
  }
  const file = join(dir, "private-key.pem");
  let created = false;
  let privateKey;
  if (existsSync(file)) {
    privateKey = createPrivateKey(readFileSync(file, "utf8"));
    if (privateKey.asymmetricKeyType !== "ed25519") throw new Error(`${file} is not an Ed25519 key`);
  } else {
    mkdirSync(dir, { recursive: true });
    const keys = generateKeys();
    privateKey = keys.privateKey;
    writeFileSync(file, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
    created = true;
  }
  const pub = rawPublicKeyB64(createPublicKey(privateKey));
  const inRepo = readPubkey();
  let pubkeyNote = "";
  if (!inRepo) {
    writeFileSync(PUBKEY_FILE, pub + "\n");
    pubkeyNote = "Wrote your public key into server/news_pubkey.txt. Commit it so the next Llamble update trusts your news.";
  } else if (inRepo !== pub) {
    pubkeyNote =
      "server/news_pubkey.txt holds a DIFFERENT public key than your private key. Instances will reject news you sign now. " +
      "If you lost the old key on purpose, replace that file's contents with your key below and ship an update.";
  }
  return { privateKey, pub, file, created, pubkeyNote };
}

// ---------- the page ----------

function page() {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Llamble news publisher</title>
<style>
:root{--bg:#1e1f22;--bg2:#2b2d31;--bg3:#383a40;--text:#e3e5e8;--muted:#9da3ab;--green:#7fc458;--red:#e5484d;--brand:#5865f2}
*{box-sizing:border-box}body{margin:0;font:15px system-ui,Segoe UI,sans-serif;background:var(--bg);color:var(--text)}
header{padding:16px 24px;background:var(--bg2);display:flex;align-items:center;gap:12px;border-bottom:3px solid var(--green)}
header h1{margin:0;font-size:20px}header .tag{color:var(--green);font-weight:700}
main{display:grid;grid-template-columns:minmax(260px,1fr) minmax(360px,1.4fr);gap:20px;padding:20px 24px;max-width:1300px;margin:auto}
@media(max-width:900px){main{grid-template-columns:1fr}}
.card{background:var(--bg2);border-radius:10px;padding:16px}.muted{color:var(--muted);font-size:13px}
.warn{background:rgba(250,166,26,.12);border:1px solid rgba(250,166,26,.5);border-radius:8px;padding:10px;font-size:13px;margin-bottom:10px}
.ok{color:var(--green);font-weight:700}.bad{color:var(--red);font-weight:700}
.item{padding:10px;border-radius:8px;background:var(--bg3);margin-bottom:8px;cursor:pointer}.item:hover{outline:2px solid var(--green)}
.item.sel{outline:2px solid var(--brand)}.item b{display:block}
label{display:block;margin:10px 0 4px;font-weight:600;font-size:13px}
input,textarea{width:100%;padding:8px 10px;border-radius:6px;border:1px solid #4e5058;background:var(--bg);color:var(--text);font:inherit}
textarea{min-height:200px;resize:vertical;font-family:ui-monospace,Consolas,monospace;font-size:13px}
.preview{white-space:pre-wrap;background:var(--bg);border-radius:6px;padding:10px;min-height:60px;font-size:14px;margin-top:6px}
button{border:0;border-radius:6px;padding:8px 14px;font-weight:700;cursor:pointer;background:var(--bg3);color:var(--text)}
button.primary{background:var(--green);color:#10200a}button.danger{background:var(--red);color:#fff}button:disabled{opacity:.5;cursor:default}
.row{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}code{word-break:break-all}pre{white-space:pre-wrap;font-size:12px;background:var(--bg);padding:8px;border-radius:6px;max-height:220px;overflow:auto}
</style></head><body>
<header><h1>🦙 Llamble news publisher</h1><span class="tag">signs news for every Llamble instance</span></header>
<main>
<section>
  <div class="card" id="keycard"></div>
  <div class="card" style="margin-top:16px">
    <div style="display:flex;justify-content:space-between;align-items:center"><b>News items</b><button onclick="newItem()">+ New</button></div>
    <div id="status" class="muted" style="margin:8px 0"></div>
    <div id="list"></div>
  </div>
</section>
<section class="card">
  <b id="formtitle">New item</b>
  <label>Title (up to 120)</label><input id="title" maxlength="120">
  <label>Body (markdown, up to 8000)</label><textarea id="body" maxlength="8000"></textarea>
  <div class="muted">Preview (plain text)</div><div class="preview" id="preview"></div>
  <label>Link (optional, https://…)</label><input id="url" placeholder="https://">
  <label>Image (optional, https://…)</label><input id="image" placeholder="https://">
  <label>Publish date</label><input id="date" type="datetime-local">
  <div class="row">
    <button class="primary" onclick="saveItem()">Save item</button>
    <button class="danger" id="del" onclick="delItem()" disabled>Delete item</button>
  </div>
  <hr style="border-color:#4e5058;margin:18px 0">
  <div class="muted">Saving changes the list here. Publishing signs it and writes site/news.json.</div>
  <div class="row">
    <button class="primary" onclick="publish(false)">Publish (write site/news.json)</button>
    <button onclick="publish(true)">Publish &amp; push to GitHub</button>
  </div>
  <pre id="out" hidden></pre>
</section>
</main>
<script>
let items=[], sel=-1;
const $=id=>document.getElementById(id);
const esc=s=>String(s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
function toLocal(ms){const d=new Date(ms);d.setMinutes(d.getMinutes()-d.getTimezoneOffset());return d.toISOString().slice(0,16)}
function slug(t){return (new Date().toISOString().slice(0,10)+"-"+t.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"")).slice(0,80).replace(/-+$/,"")}
function plain(md){return md.replace(/\\*\\*|__|\`/g,"").replace(/^#+\\s*/gm,"").replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g,"$1 ($2)")}
async function load(){
  const r=await fetch("/api/state").then(r=>r.json());
  items=r.items; render();
  const s=$("status"); s.innerHTML=r.status==="verified"?'<span class="ok">site/news.json '+esc(r.message)+'</span>':(r.status==="none"?esc(r.message):'<span class="bad">'+esc(r.message)+'</span>');
  $("keycard").innerHTML=(r.created?'<div class="warn"><b>New signing key created.</b> ':'<div class="warn">')+
   'Back up <code>'+esc(r.keyFile)+'</code> somewhere safe. Anyone with it can publish Llamble news. If you lose it, you will need to ship a new public key in a Llamble update.</div>'+
   (r.pubkeyNote?'<div class="warn">'+esc(r.pubkeyNote)+'</div>':'')+
   '<div class="muted">Public key (in server/news_pubkey.txt):</div><code>'+esc(r.pub)+'</code>';
}
function render(){
  $("list").innerHTML=items.length?items.map((it,i)=>'<div class="item'+(i===sel?' sel':'')+'" onclick="pick('+i+')"><b>'+esc(it.title)+'</b><span class="muted">'+new Date(it.published_at).toLocaleString()+' · '+esc(it.id)+'</span></div>').join(""):'<div class="muted">No items yet.</div>';
}
function pick(i){sel=i;const it=items[i];$("formtitle").textContent="Edit item";$("title").value=it.title;$("body").value=it.body;$("url").value=it.url||"";$("image").value=it.image||"";$("date").value=toLocal(it.published_at);$("del").disabled=false;prev();render()}
function newItem(){sel=-1;$("formtitle").textContent="New item";for(const k of ["title","body","url","image"])$(k).value="";$("date").value=toLocal(Date.now());$("del").disabled=true;prev();render()}
function prev(){$("preview").textContent=plain($("body").value)}
$("body").addEventListener("input",prev);
function saveItem(){
  const title=$("title").value.trim(); if(!title) return alert("Title needed");
  const it={id:sel>=0?items[sel].id:slug(title),title,body:$("body").value,published_at:new Date($("date").value||Date.now()).getTime()};
  if($("url").value.trim())it.url=$("url").value.trim(); if($("image").value.trim())it.image=$("image").value.trim();
  if(sel>=0)items[sel]=it; else { let id=it.id,n=2; while(items.some(x=>x.id===id)) id=it.id+"-"+(n++); it.id=id; items.unshift(it); sel=0; }
  items.sort((a,b)=>b.published_at-a.published_at); sel=items.indexOf(it); render(); $("del").disabled=false;
}
function delItem(){if(sel<0)return; if(!confirm("Delete this item? It disappears from every instance after you publish."))return; items.splice(sel,1); newItem()}
async function publish(push){
  const out=$("out"); out.hidden=false; out.textContent="Working…";
  const r=await fetch("/api/publish",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({items,push})}).then(r=>r.json());
  out.textContent=r.ok?(r.message+(r.git?"\\n\\n"+r.git:"")):"Error: "+r.error; if(r.ok) load();
}
newItem(); load();
</script></body></html>`;
}

function git(args) {
  return new Promise((res) => {
    execFile("git", args, { cwd: REPO }, (err, stdout, stderr) => res({ ok: !err, text: `$ git ${args.join(" ")}\n${stdout}${stderr}${err && !stderr ? err.message : ""}` }));
  });
}

function startServer() {
  const key = loadOrCreateKey();
  const server = createServer(async (req, res) => {
    const send = (code, body, type = "application/json") => {
      res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
      res.end(typeof body === "string" ? body : JSON.stringify(body));
    };
    // only this machine, only our own page (blocks other websites poking the local server)
    const host = req.headers.host || "";
    if (host !== `127.0.0.1:${PORT}` && host !== `localhost:${PORT}`) return send(403, { error: "bad host" });
    if (req.method === "POST") {
      const origin = req.headers.origin;
      if (origin && origin !== `http://127.0.0.1:${PORT}` && origin !== `http://localhost:${PORT}`) return send(403, { error: "bad origin" });
    }
    try {
      if (req.method === "GET" && req.url === "/") return send(200, page(), "text/html; charset=utf-8");
      if (req.method === "GET" && req.url === "/api/state") {
        const n = readNews();
        return send(200, { ...n, pub: key.pub, keyFile: key.file, created: key.created, pubkeyNote: key.pubkeyNote });
      }
      if (req.method === "POST" && req.url === "/api/publish") {
        let raw = "";
        for await (const c of req) {
          raw += c;
          if (raw.length > 2_000_000) return send(413, { ok: false, error: "too big" });
        }
        const { items, push } = JSON.parse(raw);
        const signed = signNews(items, key.privateKey);
        verifyNews(signed, key.pub); // never write something instances would reject
        mkdirSync(dirname(NEWS_FILE), { recursive: true });
        writeFileSync(NEWS_FILE, JSON.stringify(signed, null, 2) + "\n");
        const count = JSON.parse(signed.payload).items.length;
        let gitText = "";
        if (push) {
          const title = JSON.parse(signed.payload).items[0]?.title || "update";
          for (const args of [["add", "site/news.json", "server/news_pubkey.txt"], ["commit", "-m", `News: ${title}`], ["push"]]) {
            const r = await git(args);
            gitText += r.text + "\n";
            if (!r.ok && !(args[0] === "commit" && /nothing to commit/.test(r.text))) break;
          }
        }
        return send(200, { ok: true, message: `Signed and wrote site/news.json (${count} item${count === 1 ? "" : "s"}).`, git: gitText });
      }
      send(404, { error: "not found" });
    } catch (e) {
      send(400, { ok: false, error: e.message });
    }
  });
  server.listen(PORT, "127.0.0.1", () => {
    const url = `http://127.0.0.1:${PORT}/`;
    console.log(`Llamble news publisher: ${url}  (Ctrl+C to stop)`);
    console.log(`Signing key: ${key.file}${key.created ? "  (NEW: back this file up!)" : ""}`);
    if (key.pubkeyNote) console.log(key.pubkeyNote);
    const opener = platform() === "win32" ? ["cmd", ["/c", "start", "", url]] : platform() === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
    try {
      spawn(opener[0], opener[1], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
    } catch {}
  });
}

function cliVerify() {
  const pub = readPubkey();
  if (!pub) {
    console.error("server/news_pubkey.txt is empty");
    process.exit(1);
  }
  try {
    const items = verifyNews(JSON.parse(readFileSync(NEWS_FILE, "utf8")), pub);
    console.log(`site/news.json verified ✓ (${items.length} item${items.length === 1 ? "" : "s"})`);
    process.exit(0);
  } catch (e) {
    console.error("site/news.json NOT verified: " + e.message);
    process.exit(1);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--verify")) cliVerify();
  else {
    try {
      startServer();
    } catch (e) {
      console.error(e.message);
      process.exit(1);
    }
  }
}
