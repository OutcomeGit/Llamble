# A real show recording through the real voice server (CI, after voice_e2e.py): two people in
# a call, the director plays music into it, the recorder's app encodes video + mixes sound
# with our own recorder/WebM writer. The file must decode end to end with sound in it, and
# the music must reach the other person as its own track. Args: base_url
import base64, json, subprocess, sys, time, requests
from playwright.sync_api import sync_playwright
from websocket import create_connection
B = sys.argv[1]
def ok(r):
    if r.status_code >= 300: raise SystemExit(f"FAIL {r.request.method} {r.url} {r.status_code} {r.text}")
    return r.json()
login = lambda u, p: ok(requests.post(B + "/api/auth/login", json={"username": u, "password": p}))
a, b = login("bran", "hunter2hunter2"), login("client1", "password123")
TA, TB = {"Authorization": "Bearer " + a["token"]}, {"Authorization": "Bearer " + b["token"]}
aid, bid = a["user"]["id"], b["user"]["id"]
ws = create_connection(B.replace("http", "ws") + "/api/gateway?access_token=" + a["token"]); ready = json.loads(ws.recv())["d"]; ws.close()
vc = [c for g in ready["guilds"] for c in g["channels"] if c["kind"] == "voice"][0]["id"]
# 6 s of a 660 Hz tone as the "music" file
subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=660:duration=6", "-ac", "2", "-ar", "48000", "/tmp/show-music.wav"], check=True)
music = base64.b64encode(open("/tmp/show-music.wav", "rb").read()).decode()

with sync_playwright() as p:
    br = p.chromium.launch(args=["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"])
    pages = []
    for tok in (a["token"], b["token"]):
        ctx = br.new_context(permissions=["microphone", "camera"])
        pg = ctx.new_page()
        pg.on("pageerror", lambda e: print("  [pageerror]", e))
        pg.on("console", lambda m: ("llamble" in m.text or m.type == "error") and print("  [browser]", m.text[:200]))
        pg.goto(B)
        pg.evaluate("t=>{localStorage.setItem('llamble.token',t);localStorage.setItem('llamble.server',location.origin);localStorage.setItem('llamble.showRes','1080p')}", tok)
        pg.reload()
        pg.wait_for_function("() => window.llambleDebug", timeout=30000)
        pg.wait_for_timeout(1500)
        pg.evaluate("vc => window.llambleDebug.joinVoice(vc)", vc)
        pages.append(pg)
    for pg in pages:
        pg.wait_for_function("() => { const r = window.llambleDebug.getRoom(); return r && window.llambleDebug.voice().status === 'connected' && r.remoteParticipants.size === 1 }", timeout=60000, polling=500)
    print("two people in the call")

    sh = ok(requests.post(B + f"/api/channels/{vc}/shows", headers=TA, json={
        "title": "Mixer test", "recorder_id": aid, "director_id": aid, "record_on": "member",
        "people": [{"user_id": aid, "voice": True}, {"user_id": bid, "voice": True}]}))
    sid = sh["id"]
    ok(requests.post(B + f"/api/shows/{sid}/consent", headers=TB, json={"voice": True, "camera": False, "screen": False}))
    ok(requests.post(B + f"/api/shows/{sid}/start", headers=TA))
    pages[0].wait_for_function("() => window.llambleDebug.recorder().showId && window.llambleDebug.recorder().encoder", timeout=30000)
    print("recording with", pages[0].evaluate("() => window.llambleDebug.recorder().encoder"))
    st = pages[0].evaluate("b64 => window.llambleDebug.showMusic(b64, 'tone.wav').then(s => ({live: s.live, playing: s.items[0].playing}))", music)
    assert st == {"live": True, "playing": True}, st
    # the other person gets the music as its own track
    pages[1].wait_for_function("() => [...[...window.llambleDebug.getRoom().remoteParticipants.values()][0].trackPublications.values()].some(t => t.trackName === 'show-music' && t.isSubscribed)", timeout=20000)
    print("music playing into the call as its own track")
    time.sleep(5)
    # director turns the guest's mic down and the soundboard off: accepted and kept
    s2 = ok(requests.post(B + f"/api/shows/{sid}/state", headers=TA, json={"mix": {f"mic:{bid}": {"vol": 0.4}, "soundboard": {"on": False}}}))
    assert s2["state"]["mix"][f"mic:{bid}"]["vol"] == 0.4, s2["state"]
    time.sleep(1)
    # the director's panel, for a look (saved with the CI screenshots)
    try:
        pages[0].set_viewport_size({"width": 1280, "height": 900})
        gid = [c.get("guild_id") for g in ready["guilds"] for c in g["channels"] if c["id"] == vc][0]
        pages[0].evaluate("([g, c]) => window.llambleDebug.selectChannel(g, c)", [gid, vc])
        pages[0].wait_for_timeout(1000)
        pages[0].locator("button", has_text="Director").first.click(timeout=5000)
        pages[0].wait_for_timeout(1500)
        pages[0].locator(".director").screenshot(path="/tmp/home-director-mixer.png")
    except Exception as e:
        print("  (no director screenshot:", e, ")")
    time.sleep(3)
    fps = pages[0].evaluate("() => window.llambleDebug.recorder().fpsNow")
    print("frames per second right now:", fps)
    ok(requests.post(B + f"/api/shows/{sid}/stop", headers=TA))
    pages[0].wait_for_function("() => !window.llambleDebug.recorder().showId", timeout=30000)
    data = base64.b64decode(pages[0].evaluate("id => window.llambleDebug.recordingB64(id)", sid))
    open("/tmp/show-rec.webm", "wb").write(data)
    print(f"recording kept in the browser: {len(data) // 1024} KB")
    br.close()

probe = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height", "-of", "json", "/tmp/show-rec.webm"], capture_output=True, text=True)
streams = json.loads(probe.stdout)["streams"]
kinds = {s["codec_type"]: s for s in streams}
assert "video" in kinds and "audio" in kinds and kinds["audio"]["codec_name"] == "opus", streams
assert (kinds["video"]["width"], kinds["video"]["height"]) == (1920, 1080), kinds["video"]
frames = int(subprocess.run(["ffprobe", "-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", "/tmp/show-rec.webm"], capture_output=True, text=True).stdout.strip())
dec = subprocess.run(["ffmpeg", "-v", "error", "-i", "/tmp/show-rec.webm", "-f", "null", "-"], capture_output=True, text=True)
if dec.stderr.strip():
    pk = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "a:0", "-show_entries", "packet=pts_time,size", "-of", "csv=p=0", "/tmp/show-rec.webm"], capture_output=True, text=True).stdout.splitlines()
    small = [l for l in pk if int(l.split(",")[1] or 0) < 3]
    lastpk = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "packet=stream_index,pts_time,size,pos", "-of", "csv=p=0", "/tmp/show-rec.webm"], capture_output=True, text=True).stdout.splitlines()[-4:]
    print("file size", len(open("/tmp/show-rec.webm", "rb").read()), "| last packets (stream,pts,size,pos):", lastpk)
    raw = open("/tmp/show-rec.webm", "rb").read()
    apk = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "a:0", "-show_entries", "packet=pts_time,size,pos", "-of", "csv=p=0", "/tmp/show-rec.webm"], capture_output=True, text=True).stdout.splitlines()
    for l in apk[:2] + apk[-4:]:
        t, sz, pos = l.split(","); sz, pos = int(sz), int(pos)
        print(f"  audio {t}: {sz} bytes, block head {raw[pos-7:pos].hex()} data starts {raw[pos:pos+6].hex()} ends {raw[pos+sz-4:pos+sz].hex()}")
    # which packet does the decoder reject? decode the sound one packet at a time
    import re
    bad = subprocess.run(["ffmpeg", "-v", "error", "-err_detect", "explode", "-i", "/tmp/show-rec.webm", "-map", "0:a", "-f", "null", "-"], capture_output=True, text=True).stderr
    print("strict decode:", bad[:300])
    vers = subprocess.run(["ffmpeg", "-version"], capture_output=True, text=True).stdout.splitlines()[0]
    print("ffmpeg:", vers)
    print("audio packets:", len(pk), "| first:", pk[:3], "| last:", pk[-3:], "| tiny:", small[:5])
    dbg = subprocess.run(["ffmpeg", "-v", "debug", "-debug_ts", "-i", "/tmp/show-rec.webm", "-map", "0:a", "-f", "null", "-"], capture_output=True, text=True).stderr.splitlines()
    for i, l in enumerate(dbg):
        if "Error parsing" in l:
            print("\n".join(x[:200] for x in dbg[max(0, i - 6):i + 2] if "demuxer" in x or "Error" in x or "pkt_pts" in x or "decoder" in x))
            pts = None
            for x in reversed(dbg[:i]):
                if "pkt_pts_time:" in x:
                    pts = x.split("pkt_pts_time:")[1].split()[0]; break
            if pts:
                d = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "a:0", "-show_packets", "-show_data", "-read_intervals", f"{float(pts)-0.03}%+0.06", "/tmp/show-rec.webm"], capture_output=True, text=True).stdout
                print(d[:1500])
            break
    raise SystemExit("decode errors: " + dec.stderr[:400])
vol = subprocess.run(["ffmpeg", "-i", "/tmp/show-rec.webm", "-vn", "-af", "volumedetect", "-f", "null", "-"], capture_output=True, text=True).stderr
mean = float([l for l in vol.splitlines() if "mean_volume" in l][0].split(":")[1].split()[0])
print(f"{kinds['video']['codec_name']} {frames} frames, opus sound at {mean} dB mean")
assert frames >= 150, f"only {frames} frames in ~10 s"
assert mean > -45, f"recording is silent ({mean} dB)"
print("SHOW RECORDING OK")
