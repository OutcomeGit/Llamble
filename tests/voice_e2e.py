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
    for pg in pages: pg.wait_for_function(hears, timeout=60000, polling=500)
    print("two people connected and hearing each other")
    sid = "async () => { const r = window.llambleDebug.getRoom(); try { return r ? await r.getSid() : null } catch { return null } }"
    before = [pg.evaluate(sid) for pg in pages]
    # match the process by its executable, not its command line (which would also match this shell)
    kill = 'for p in /proc/[0-9]*; do [ "$(readlink $p/exe 2>/dev/null)" = /opt/livekit/livekit-server ] && kill -9 ${p#/proc/}; done; true'
    subprocess.run(["docker", "exec", NAME, "sh", "-c", kill], check=True)
    print("voice server crashed mid-call (kill -9)")
    # the restarted voice server is a fresh room (new ID): both must be back in it and hearing each other
    end = time.time() + 120
    for i, pg in enumerate(pages):
        while True:
            if time.time() > end: raise SystemExit(f"browser {i} didn't get back into the call")
            now = pg.evaluate(sid)
            if now and now != before[i] and pg.evaluate(hears): break
            time.sleep(0.5)
    st = ok(requests.get(B + "/api/admin/settings", headers=TA))["voice"]
    print("both rejoined on their own; voice server", st["state"])

    # ---- Show: bran records both of them (voice + camera) in his app, and it lands on the server
    pages[0].evaluate("() => window.llambleDebug.toggleCamera()")
    pages[0].wait_for_function("() => window.llambleDebug.voice().camera", timeout=30000)
    # the other person sees the camera, can hide it (stops downloading it) and show it again
    cam = """id => { const p = window.llambleDebug.getRoom().remoteParticipants.get(id); const pub = p && p.getTrackPublication('camera'); return pub ? pub.isSubscribed : null; }"""
    pages[1].wait_for_function(cam, arg=a["user"]["id"], timeout=30000)
    pages[1].evaluate("id => window.llambleDebug.setWatching(id, 'camera', false)", a["user"]["id"])
    pages[1].wait_for_function("(id) => { const p = window.llambleDebug.getRoom().remoteParticipants.get(id); return p.getTrackPublication('camera').isSubscribed === false; }", arg=a["user"]["id"], timeout=15000)
    pages[1].evaluate("id => window.llambleDebug.setWatching(id, 'camera', true)", a["user"]["id"])
    pages[1].wait_for_function(cam, arg=a["user"]["id"], timeout=15000)
    print("hiding someone's camera stops it downloading; showing it brings it back")
    TB = {"Authorization": "Bearer " + b["token"]}
    show = ok(requests.post(B + f"/api/channels/{vc}/shows", headers=TA, json={"title": "CI show", "people": [
        {"user_id": a["user"]["id"], "voice": True, "camera": True}, {"user_id": b["user"]["id"], "voice": True, "camera": False}]}))
    ok(requests.post(B + f"/api/shows/{show['id']}/consent", headers=TB, json={"voice": True}))
    ok(requests.post(B + f"/api/shows/{show['id']}/start", headers=TA))
    pages[0].wait_for_function("() => window.llambleDebug.recorder().showId", timeout=20000)
    time.sleep(12)
    ok(requests.post(B + f"/api/shows/{show['id']}/stop", headers=TA))
    pages[0].wait_for_function("() => !window.llambleDebug.recorder().showId", timeout=60000)
    rec = ok(requests.get(B + "/api/shows", headers=TB))
    mine = [x for x in rec if x["id"] == show["id"]]
    assert mine and mine[0]["size"] > 50_000, rec
    v = requests.get(B + f"/api/shows/{show['id']}/video", headers=TA)
    assert v.status_code == 200 and len(v.content) >= mine[0]["size"], (v.status_code, len(v.content), mine[0]["size"])
    open("/tmp/show.webm", "wb").write(v.content)
    probe = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height", "-of", "csv=p=0", "/tmp/show.webm"], capture_output=True, text=True).stdout
    print("  ffprobe:", probe.strip().replace("\n", " | "))
    assert "video" in probe and "1920,1080" in probe and "audio" in probe, probe
    # the picture isn't blank: grab a frame from the middle and check it has detail
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", "6", "-i", "/tmp/show.webm", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gray", "-s", "64x36", "/tmp/frame.raw"], check=True)
    px = open("/tmp/frame.raw", "rb").read()
    assert len(set(px)) > 8, "recorded frame is blank"
    print(f"show recorded: {mine[0]['size'] // 1000} KB of 1080p video with sound, visible to the other person in it")

    # ---- "Hey Llamble" with the real speech tools in the image (Whisper tiny + Kokoro)
    ok(requests.put(B + "/api/admin/voice-ai", headers=TA, json={"enabled": True, "stt": "whisper-tiny.en"}))
    def voice_ready():
        x = ok(requests.get(B + "/api/admin/voice-ai", headers=TA))["status"]
        if x.get("error"): raise SystemExit("voice models: " + x["error"])
        return x["stt"] == "ready" and x["tts"] == "ready"
    wait(voice_ready, 600, "voice models downloaded")
    print("voice models downloaded")
    ok(requests.patch(B + f"/api/guilds/{gid}/bot", headers=TA, json={"enabled": True}))
    ok(requests.put(B + f"/api/guilds/{gid}/voice-listen", headers=TA, json={"voice_listen": True}))
    t0 = time.time()
    said = requests.post(B + "/api/admin/voice-ai/preview", headers=TA, json={"text": "Hey Llamble, what is two plus two?"})
    assert said.status_code == 200 and said.content[:4] == b"RIFF", (said.status_code, said.text[:300])
    print(f"Kokoro spoke a sentence in {time.time() - t0:.1f}s ({len(said.content) // 1000} KB)")
    open("/tmp/q.wav", "wb").write(said.content)
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", "/tmp/q.wav", "-ac", "1", "-ar", "16000", "-f", "s16le", "/tmp/q.pcm"], check=True)
    wsb = create_connection(B.replace("http", "ws") + "/api/gateway?access_token=" + b["token"]); wsb.recv(); wsb.settimeout(1)
    ok(requests.post(B + f"/api/channels/{vc}/listen", headers=TA, data=open("/tmp/q.pcm", "rb").read()))
    end, heard = time.time() + 120, None
    while time.time() < end and not heard:
        try:
            m = json.loads(wsb.recv())
            if m["t"] == "BOT_SPEAK": heard = m["d"]
        except Exception: pass
    assert heard, "Llamble didn't hear 'Hey Llamble' (speech recognition or wake word failed)"
    print("Whisper heard the question; Llamble answered out loud:", heard["text"][:80], "| audio:", bool(heard["audio_url"]))
    assert heard["audio_url"], heard
    br.close()
print("ALL VOICE E2E OK")
