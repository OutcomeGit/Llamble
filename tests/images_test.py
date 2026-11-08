# Pictures: /imagine on the NAS (model downloaded once), on a lent GPU, from the AI's own
# tool call, and the rules (who may, family-friendly).
import requests, sys, json, time, os, threading, functools, struct, zlib
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from websocket import create_connection
B = sys.argv[1]

# fake Hugging Face: /{repo}/resolve/main/{path}
root = "/tmp/fake-hf"
for repo, path in [("unsloth/FLUX.2-klein-4B-GGUF", "flux-2-klein-4b-Q4_K_M.gguf"), ("Comfy-Org/vae-text-encorder-for-flux-klein-4b", "split_files/vae/flux2-vae.safetensors"),
                   ("unsloth/Qwen3-4B-Instruct-2507-GGUF", "Qwen3-4B-Instruct-2507-Q4_K_M.gguf")]:
    p = f"{root}/{repo}/resolve/main/{path}"; os.makedirs(os.path.dirname(p), exist_ok=True); open(p, "wb").write(b"x" * 5000)
srv = ThreadingHTTPServer(("127.0.0.1", 8093), functools.partial(SimpleHTTPRequestHandler, directory=root))
threading.Thread(target=srv.serve_forever, daemon=True).start()

def call(method, path, tok=None, expect=200, **kw):
    h = {"Authorization": "Bearer " + tok} if tok else {}
    h.update(kw.pop("headers", {}))
    r = requests.request(method, B + path, headers=h, **kw)
    if r.status_code != expect:
        raise SystemExit(f"FAIL {method} {path}: wanted {expect}, got {r.status_code} {r.text[:300]}")
    return r.json() if r.headers.get("content-type", "").startswith("application/json") else r

s = call("POST", "/api/setup", json={"username": "bran", "password": "master-pass1", "server_name": "Fam"})
M, gid = s["token"], s["guild_id"]
mom = call("POST", "/api/auth/register", json={"invite": call("POST", f"/api/guilds/{gid}/invites", M, json={"max_uses": 5})["code"], "username": "mom", "password": "mom-pass1234"})
MOM = mom["token"]
kid = call("POST", "/api/kids", MOM, json={"username": "junior", "password": "kid-pass12"})
call("POST", f"/api/kids/{kid['user']['id']}/guilds", MOM, json={"guild_id": gid})
K = call("POST", "/api/auth/login", json={"username": "junior", "password": "kid-pass12"})["token"]
ws = create_connection(B.replace("http", "ws") + "/api/gateway?access_token=" + M); ready = json.loads(ws.recv())["d"]
tc = [c for g in ready["guilds"] for c in g["channels"] if c["kind"] == "text"][0]["id"]
assert ready["config"]["images"]["enabled"] is False
def last():
    return call("GET", f"/api/channels/{tc}/messages?limit=1", M)[0]
def wait_picture(t=30):
    for _ in range(t * 4):
        m = last()
        if m["attachments"] or "Couldn't" in m["content"]: return m
        time.sleep(0.25)
    return m

call("POST", f"/api/channels/{tc}/imagine", MOM, expect=400, json={"prompt": "a cat"})   # off
call("PUT", "/api/admin/images", M, json={"enabled": True})
for _ in range(80):
    st = call("GET", "/api/admin/images", M)
    if st["status"]["state"] == "ready": break
    time.sleep(0.25)
assert st["status"]["state"] == "ready" and st["nas_tool"], st
print("model downloaded to the NAS")

# --- on the NAS
call("POST", f"/api/channels/{tc}/imagine", MOM, json={"prompt": "a llama surfing a giant wave", "shape": "wide"})
m = wait_picture()
assert m["author"]["is_bot"] and m["attachments"] and m["attachments"][0]["mime"] == "image/png" and "llama surfing" in m["content"], m
assert m["attachments"][0]["width"] == 1024 * 2 // 3 // 64 * 64, m["attachments"][0]
print("drawn on the NAS and posted:", m["content"])

# --- rules
call("POST", f"/api/channels/{tc}/imagine", K, expect=400, json={"prompt": "a puppy"})          # kids off by default
call("POST", f"/api/channels/{tc}/imagine", MOM, expect=400, json={"prompt": "a naked person"})  # family-friendly
call("PUT", "/api/admin/images", M, json={"who": "everyone"})
call("POST", f"/api/channels/{tc}/imagine", K, json={"prompt": "a puppy"})
assert wait_picture()["attachments"]
print("kids only when allowed; unsafe prompts refused")

# --- a lent GPU that makes pictures gets the job instead
call("PUT", "/api/admin/settings", M, json={})
wsw = create_connection(B.replace("http", "ws") + "/api/gateway?access_token=" + M); wsw.recv(); wsw.settimeout(5)
wsw.send(json.dumps({"op": "worker_register", "gpu": "RTX 4090", "vram_mb": 24576, "model": "x", "available": True, "images": True}))
time.sleep(0.5)
call("POST", f"/api/channels/{tc}/imagine", MOM, json={"prompt": "a robot dog"})
job = None
for _ in range(20):
    try:
        e = json.loads(wsw.recv())
        if e["t"] == "IMAGE_JOB": job = e["d"]; break
    except Exception: pass
assert job and job["prompt"] == "a robot dog" and job["files"][0]["name"] == "diffusion.gguf", job
assert "lent RTX 4090" in last()["content"]
def png(w, h):
    c = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d))
    return b"\x89PNG\r\n\x1a\n" + c(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + c(b"IDAT", zlib.compress(b"".join(b"\0" + b"\x10\x20\x30" * w for _ in range(h)))) + c(b"IEND", b"")
call("POST", f"/api/image-jobs/{job['job_id']}", MOM, expect=403, data=png(64, 64))   # only the GPU that got it
call("POST", f"/api/image-jobs/{job['job_id']}", M, data=png(768, 768))
m = wait_picture()
assert m["attachments"] and m["attachments"][0]["width"] == 768, m
print("drawn on the lent GPU")
wsw.close(); time.sleep(0.5)

# --- the AI draws when asked in chat
call("PATCH", f"/api/guilds/{gid}/bot", M, json={"enabled": True})
call("POST", f"/api/channels/{tc}/messages", MOM, json={"content": "llamble can you draw me something?"})
for _ in range(120):
    ms = call("GET", f"/api/channels/{tc}/messages?limit=4", M)
    m = next((x for x in ms if x["attachments"] and "spacesuit" in x["content"]), None)
    if m: break
    time.sleep(0.25)
assert m, ms
print("the AI drew a picture through its tool")
