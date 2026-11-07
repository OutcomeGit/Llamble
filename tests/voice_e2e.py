# Real calls against the real image (run in CI): two browsers join a voice channel through the
# bundled LiveKit, hear each other, then the voice server is killed mid-call and both must
# rejoin on their own. Args: base_url container_name
import requests, sys, time, subprocess
from playwright.sync_api import sync_playwright
B, NAME = sys.argv[1], sys.argv[2]
def ok(r):
    if r.status_code >= 300: raise SystemExit(f"FAIL {r.request.method} {r.url} {r.status_code} {r.text}")
    return r.json()
def wait(f, t=60, what=""):
    end = time.time() + t
    while time.time() < end:
        try:
            v = f()
            if v: return v
        except Exception: pass
        time.sleep(0.5)
    raise SystemExit("timed out: " + what)
wait(lambda: requests.get(B + "/api/info").ok, 60, "server up")
a = ok(requests.post(B + "/api/setup", json={"username": "bran", "password": "hunter2hunter2", "server_name": "G"}))
TA = {"Authorization": "Bearer " + a["token"]}
gid = a["guild_id"]
ok(requests.put(B + "/api/admin/settings", headers=TA, json={"lan_ip": "127.0.0.1"}))
wait(lambda: ok(requests.get(B + "/api/admin/settings", headers=TA))["voice"]["state"] == "running", 60, "voice server running")
print("bundled voice server running")
inv = ok(requests.post(B + f"/api/guilds/{gid}/invites", headers=TA, json={"max_uses": 5}))
b = ok(requests.post(B + "/api/auth/register", json={"invite": inv["code"], "username": "client1", "password": "password123"}))
import json
from websocket import create_connection
ws = create_connection(B.replace("http", "ws") + "/api/gateway?access_token=" + a["token"]); ready = json.loads(ws.recv())["d"]; ws.close()
vc = [c for g in ready["guilds"] for c in g["channels"] if c["kind"] == "voice"][0]["id"]

with sync_playwright() as p:
    br = p.chromium.launch(args=["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"])
    pages = []
    for tok in (a["token"], b["token"]):
        ctx = br.new_context(permissions=["microphone", "camera"])
        pg = ctx.new_page()
        pg.on("console", lambda m: m.type in ("error", "warning") and print("  [browser]", m.text[:200]))
        pg.goto(B)
        pg.evaluate("t=>{localStorage.setItem('llamble.token',t);localStorage.setItem('llamble.server',location.origin)}", tok)
        pg.reload()
        pg.wait_for_function("() => window.llambleDebug", timeout=30000)
        pg.wait_for_timeout(1500)
        pg.evaluate("vc => window.llambleDebug.joinVoice(vc)", vc)
        pages.append(pg)
    hears = """() => { const r = window.llambleDebug.getRoom(); if (!r || window.llambleDebug.voice().status !== 'connected') return false;
      const ps = [...r.remoteParticipants.values()]; return ps.length === 1 && ps[0].audioTrackPublications.size > 0 && [...ps[0].audioTrackPublications.values()].some(t => t.isSubscribed); }"""
    for pg in pages: pg.wait_for_function(hears, timeout=60000)
    print("two people connected and hearing each other")
    # match the process by its executable, not its command line (which would also match this shell)
    kill = 'for p in /proc/[0-9]*; do [ "$(readlink $p/exe 2>/dev/null)" = /opt/livekit/livekit-server ] && kill -9 ${p#/proc/}; done; true'
    subprocess.run(["docker", "exec", NAME, "sh", "-c", kill], check=True)
    print("voice server crashed mid-call (kill -9)")
    for pg in pages: pg.wait_for_function("() => window.llambleDebug.voice().status !== 'connected'", timeout=30000)
    for pg in pages: pg.wait_for_function(hears, timeout=120000)
    st = ok(requests.get(B + "/api/admin/settings", headers=TA))["voice"]
    print("both rejoined on their own; voice server", st["state"])
    br.close()
print("ALL VOICE E2E OK")
