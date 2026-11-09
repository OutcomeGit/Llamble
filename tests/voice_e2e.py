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

    # ---- mic sound: the default (High, with helpers) runs the mic through our chain with AI
    # noise suppression; switching presets mid-call takes effect without breaking the call
    proc = "() => { const t = window.llambleDebug.getRoom().localParticipant.getTrackPublication('microphone')?.track; return (t && t.getProcessor && t.getProcessor()?.name) || null }"
    def wait_proc(pg, want, what):
        end = time.time() + 30
        while time.time() < end:
            if pg.evaluate(proc) == want and not pg.evaluate("() => window.llambleDebug.voice().error"): return
            time.sleep(0.3)
        raise SystemExit(f"mic chain: expected {want} ({what}); got {pg.evaluate(proc)}, error: {pg.evaluate('() => window.llambleDebug.voice().error')}")
    assert pages[0].evaluate("() => window.llambleDebug.micSound().noise") == "rnnoise"
    assert pages[0].evaluate("() => window.llambleDebug.micSound().bitrate") == 128000, "follows the server default (128 kbps)"
    for pg in pages: wait_proc(pg, "llamble-mic", "default preset: RNNoise")
    pages[0].evaluate("() => window.llambleDebug.setMicSound({ ...window.llambleDebug.micSound(), noise: 'gtcrn', gateDb: -50, lowCut: true, compressor: true, bassDb: 3 })")
    time.sleep(1.5)
    wait_proc(pages[0], "llamble-mic", "GTCRN + gate + low-cut + compressor + EQ")
    assert pages[0].evaluate("() => window.llambleDebug.getRoom().localParticipant.getTrackPublication('microphone').track.getProcessor().sound.noise") == "gtcrn"
    pages[0].evaluate("() => window.llambleDebug.setMicSound(window.llambleDebug.PRESETS.find(p => p.id === 'max-raw').sound)")
    time.sleep(1.5)
    wait_proc(pages[0], None, "raw preset: no chain")
    pages[0].evaluate("() => window.llambleDebug.setMicSound(window.llambleDebug.PRESETS.find(p => p.id === 'high').sound)")
    time.sleep(1.5)
    wait_proc(pages[0], "llamble-mic", "back to default")
    for pg in pages: pg.wait_for_function(hears, timeout=30000, polling=500)
    print("mic sound: AI noise suppression on by default; GTCRN/gate/EQ, raw and back again mid-call, still hearing each other")
    # the admin's default and maximum reach everyone right away
    ok(requests.put(B + "/api/admin/settings", headers=TA, json={"mic_default_kbps": 64, "mic_max_kbps": 96}))
    pages[1].wait_for_function("() => window.llambleDebug.micSound().bitrate === 64000", timeout=10000)
    r = requests.put(B + "/api/admin/settings", headers=TA, json={"mic_default_kbps": 128, "mic_max_kbps": 96})
    assert r.status_code == 400, "default above maximum must be refused"
    ok(requests.put(B + "/api/admin/settings", headers=TA, json={"mic_default_kbps": 128, "mic_max_kbps": 510}))
    pages[1].wait_for_function("() => window.llambleDebug.micSound().bitrate === 128000", timeout=10000)
    for pg in pages: pg.wait_for_function(hears, timeout=30000, polling=500)
    print("server mic default/maximum: pushed live, default above maximum refused")

    # ---- Home: a note and a highlight from bran show up on client1's Home in a real browser
    tc = [c for g in ready["guilds"] for c in g["channels"] if c["kind"] == "text"][0]["id"]
    crashed = "() => document.body.innerText.includes('Something went wrong')"
    pages[1].evaluate("() => window.llambleDebug.openHome()")
    note = ok(requests.post(B + f"/api/guilds/{gid}/notes", headers=TA, json={"content": "on around 10 pm tonight", "color": "pink"}))
    pages[1].wait_for_function("() => document.querySelector('.hb-board') && document.body.innerText.includes('on around 10 pm tonight')", timeout=15000)
    m = ok(requests.post(B + f"/api/channels/{tc}/messages", headers=TA, json={"content": "highlight me"}))
    ok(requests.post(B + f"/api/guilds/{gid}/highlights", headers=TA, json={"message_id": m["id"]}))
    pages[1].wait_for_function("() => document.body.innerText.includes('highlight me')", timeout=15000)
    # "Share to…" opens without crashing (it crashed once with React #185)
    assert pages[1].evaluate("([c, m]) => window.llambleDebug.openShare(c, m)", [tc, m["id"]]), "share: message not found"
    pages[1].wait_for_function("() => document.querySelector('.share-modal')", timeout=10000)
    pages[1].wait_for_timeout(1000)
    assert not pages[1].evaluate(crashed), "Share to… crashed"
    pages[1].keyboard.press("Escape")
    pages[1].get_by_text("Cancel").first.click() if pages[1].query_selector(".share-modal") else None
    print("Share to…: opens fine")
    pages[1].get_by_text("✓ Dismiss").first.click()
    pages[1].wait_for_function("() => !document.querySelector('.hb-board')?.innerText.includes('on around 10 pm tonight')", timeout=10000)
    assert ok(requests.get(B + "/api/home", headers={"Authorization": "Bearer " + b["token"]}))["notes"] == [], "dismissed on the server too"
    for view in ("notes", "highlights"):
        pages[1].evaluate("([g, v]) => window.llambleDebug.openGuildView(g, v)", [gid, view])
        pages[1].wait_for_timeout(1500)
        assert not pages[1].evaluate(crashed), f"{view} view crashed"
    pages[1].evaluate("() => window.llambleDebug.openHome()")
    pages[1].wait_for_timeout(1000)
    assert not pages[1].evaluate(crashed), "Home crashed"
    print("Home: note shown live and dismissed, highlight shown, Notes board and Highlights open fine")
    # screenshots of the Home board in each style (uploaded by CI as "home-screenshots")
    ok(requests.post(B + f"/api/guilds/{gid}/notes", headers=TA, json={"content": "Pizza night Friday? Bring the good controller.", "color": "yellow"}))
    pages[1].set_viewport_size({"width": 1400, "height": 900})
    cls = {"cork": "hb-cork", "spit": "hb-felt-spit", "sky": "hb-felt-sky", "midnight": "hb-felt-midnight", "chalkboard": "hb-chalkboard", "plain": "hb-plain"}
    for style in ("cork", "spit", "sky", "midnight", "chalkboard", "plain"):
        pages[1].evaluate("s => localStorage.setItem('llamble.homeBoard', s)", style)
        pages[1].evaluate("([g]) => window.llambleDebug.openGuildView(g, 'notes')", [gid])
        pages[1].wait_for_timeout(300)
        pages[1].evaluate("() => window.llambleDebug.openHome()")
        pages[1].wait_for_function("c => document.querySelector('.hb-board.' + c)", arg=cls[style], timeout=10000)
        pages[1].wait_for_timeout(800)
        pages[1].screenshot(path="/tmp/home.png" if style == "cork" else f"/tmp/home-{style}.png", full_page=True)
        assert not pages[1].evaluate(crashed), f"Home ({style}) crashed"
    pages[1].evaluate("() => localStorage.setItem('llamble.homeBoard', 'cork')")
    pages[1].evaluate("([g]) => window.llambleDebug.openGuildView(g)", [gid])
    pages[1].wait_for_function("() => document.querySelector('.hb-board [data-hb-section=notes]') && document.body.innerText.includes('Pizza night')", timeout=10000)
    pages[1].wait_for_timeout(800)
    pages[1].screenshot(path="/tmp/home-server.png", full_page=True)
    assert not pages[1].evaluate(crashed), "server board crashed"
    pages[1].evaluate("() => window.llambleDebug.openHome()")
    print("Board screenshots saved (Home in 6 colors; server board)")

    # ---- instance news reaches everyone's Home live
    ok(requests.post(B + "/api/news", headers=TA, json={"title": "Game night is back", "body": "Friday at **8 pm** in General. Bring snacks.", "pinned": True}))
    pages[1].evaluate("() => window.llambleDebug.openHome()")
    pages[1].wait_for_function("() => document.querySelector('.hb-newspaper') && document.body.innerText.includes('Game night is back')", timeout=15000)
    pages[1].wait_for_timeout(800)
    pages[1].screenshot(path="/tmp/home-news.png", full_page=True)
    assert not pages[1].evaluate(crashed), "Home with news crashed"
    pages[1].evaluate("() => window.llambleDebug.openHome('news')")
    pages[1].wait_for_timeout(800)
    assert not pages[1].evaluate(crashed), "News view crashed"
    pages[1].evaluate("() => window.llambleDebug.openHome('highlights')")
    pages[1].wait_for_timeout(800)
    assert not pages[1].evaluate(crashed), "Highlights view crashed"
    pages[1].evaluate("() => window.llambleDebug.openHome()")
    print("News: instance news shown live on Home; news views open fine")

    # alarms: a one-off alarm ~3 s ahead must ring on client1 with a card that only Dismiss/Snooze closes
    TB = {"Authorization": "Bearer " + b["token"]}
    at_ms = int((time.time() + 3) * 1000)
    al = ok(requests.post(B + "/api/alarms", headers=TB, json={"label": "Time to get off — e2e", "kind": "alarm", "at": at_ms, "sound": "classic", "snooze_min": 10}))
    pages[1].wait_for_function("() => document.querySelector('.al-card') && document.body.innerText.includes('Time to get off — e2e')", timeout=20000)
    pages[1].wait_for_timeout(500)
    pages[1].screenshot(path="/tmp/home-alarm.png", full_page=True)
    pages[1].locator(".al-card .al-dismiss").click()
    pages[1].wait_for_function("() => !document.querySelector('.al-card')", timeout=10000)
    pages[1].wait_for_timeout(5000)  # the local backup timer (+4 s) must not ring it again
    assert not pages[1].evaluate("() => !!document.querySelector('.al-card')"), "alarm rang again after dismiss"
    assert not pages[1].evaluate(crashed), "alarm crashed the app"
    print(f"Alarm {al['id']}: rang on time, dismissed, stayed dismissed")
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

    # ---- Show: bran records both of them (voice + camera) in his app: it stays in his app
    # until he shares it from the Library, which uploads it
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
    assert mine and mine[0]["on_server"] is False and mine[0]["size"] > 50_000, rec
    assert requests.get(B + f"/api/shows/{show['id']}/video", headers=TA).status_code == 404, "nothing uploaded by itself"
    local = pages[0].evaluate("async (id) => (await window.llambleDebug.localrec.list()).find((r) => r.id === id)", show["id"])
    assert local and local["size"] == mine[0]["size"], (local, mine[0]["size"])
    print(f"show kept on the recorder's device ({local['size'] // 1000} KB), nothing on the server; the other person sees it's on his device")
    # the Library opens and lists it
    pages[0].evaluate("() => window.llambleDebug.openLibrary()")
    pages[0].wait_for_selector(".library .recording", timeout=15000)
    assert "Something went wrong" not in pages[0].inner_text("body")
    pages[0].screenshot(path="/tmp/library.png")
    # sharing it uploads it
    pages[0].evaluate("async (id) => window.llambleDebug.localrec.uploadToServer(id)", show["id"])
    rec = ok(requests.get(B + "/api/shows", headers=TB))
    mine = [x for x in rec if x["id"] == show["id"]]
    assert mine[0]["on_server"] is True and mine[0]["size"] == local["size"], mine
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
    print(f"show shared from the Library: {mine[0]['size'] // 1000} KB of 1080p video with sound, uploaded whole, visible to the other person in it")

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
