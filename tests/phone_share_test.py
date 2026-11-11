# The Android app's screen share, page half (the phone side can only run on a phone): real H.264 (as the phone's encoder sends it)
# arrives over the app's message channel and must come out as a live video track + sound.
import base64, os, shutil, subprocess, sys, time
from playwright.sync_api import sync_playwright
B = sys.argv[1]
# 3 seconds of 720p H.264 like a phone's encoder makes (no B-frames, a full picture every second)
subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30", "-t", "3", "-c:v", "libx264", "-profile:v", "baseline",
                "-pix_fmt", "yuv420p", "-x264-params", "keyint=30:bframes=0:aud=1", "-bsf:v", "h264_mp4toannexb", "-f", "h264", "/tmp/phone-test.h264"], check=True)
data = open("/tmp/phone-test.h264", "rb").read()
# split into access units at each AUD (00 00 00 01 09)
aus = [b"\x00\x00\x00\x01" + p for p in data.split(b"\x00\x00\x00\x01\x09")[1:]]
aus = [b"\x00\x00\x00\x01\x09" + a[4:] for a in aus]
first = aus[0]
# the encoder's config buffer: SPS + PPS of the first unit
sps = first.find(b"\x00\x00\x00\x01\x67"); idr = first.find(b"\x00\x00\x00\x01\x65")
config = first[sps:idr]
frames = [(a, b"\x00\x00\x00\x01\x65" in a or b"\x00\x00\x01\x65" in a) for a in aus]
print(f"{len(frames)} frames, {sum(k for _, k in frames)} key frames, config {len(config)} bytes")
with sync_playwright() as p:
    # real Chrome (has the H.264 decoder, like Android's WebView); Playwright's own Chromium may not
    chrome = next((c for c in ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", shutil.which("google-chrome") or ""] if c and os.path.exists(c)), None)
    br = p.chromium.launch(executable_path=chrome, args=["--no-sandbox", "--autoplay-policy=no-user-gesture-required"])
    pg = br.new_page(user_agent="Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/130 Mobile Safari/537.36 LlambleAndroid/0.1.95")
    pg.on("pageerror", lambda e: print("PAGEERROR", e))
    pg.on("console", lambda m: print("CONSOLE", m.text) if "llamble" in m.text or m.type == "error" else None)
    pg.goto(B); time.sleep(2)
    # play the Android app: hand the page its message channel, answer "screen-start" with video
    pg.evaluate("""() => {
      const ch = new MessageChannel();
      window.__app = ch.port1;
      window.__sent = [];
      ch.port1.onmessage = (e) => window.__sent.push(JSON.parse(e.data));
      window.postMessage("llamble-android", "*", [ch.port2]);
    }""")
    time.sleep(0.5)
    pg.evaluate("""() => { window.__cap = window.llambleDebug.startPhoneCapture({width:1920,height:1080,fps:30,bitrate:6000000,audio:true}).then(c => (window.__capOK = {w:c.width,h:c.height,audio:!!c.audio, live: c.video.readyState}, window.__c = c), e => (window.__capErr = String(e))); }""")
    time.sleep(0.5)
    sent = pg.evaluate("window.__sent")
    assert any(m["cmd"] == "screen-start" and m["width"] == 1920 for m in sent), sent
    send = lambda o: pg.evaluate("o => window.__app.postMessage(JSON.stringify(o))", o)
    send({"event": "screen-video", "b64": base64.b64encode(config).decode(), "config": True, "key": False, "ts": 0})
    pcm = base64.b64encode(bytes(3840)).decode()
    for i, (au, key) in enumerate(frames):
        send({"event": "screen-video", "b64": base64.b64encode(au).decode(), "config": False, "key": key, "ts": i * 33333})
        send({"event": "screen-audio", "b64": pcm})
        time.sleep(1 / 30)
    time.sleep(1)
    print("capture:", pg.evaluate("window.__capOK || window.__capErr"))
    ok = pg.evaluate("window.__capOK")
    assert ok and ok["w"] == 1280 and ok["h"] == 720 and ok["audio"] and ok["live"] == "live", ok
    # the track really plays the decoded pictures
    pg.evaluate("""() => { const v = document.createElement('video'); v.muted = true; v.srcObject = new MediaStream([window.__c.video]); document.body.appendChild(v); v.play().catch(()=>{}); }""")
    # keep feeding a little so the element sees frames
    for i, (au, key) in enumerate(frames[:30]):
        send({"event": "screen-video", "b64": base64.b64encode(au).decode(), "config": False, "key": key, "ts": (100 + i) * 33333}); time.sleep(1/30)
    dims = pg.evaluate("() => { const v = document.querySelector('video'); return [v.videoWidth, v.videoHeight]; }")
    print("video element sees", dims)
    assert dims == [1280, 720], dims
    # stopping from Android's side tells the page
    send({"event": "screen-stopped"}); time.sleep(0.3)
    print("after stop:", pg.evaluate("window.__c.video.readyState"), [m["cmd"] for m in pg.evaluate("window.__sent")][-1])
    assert pg.evaluate("window.__c.video.readyState") == "ended"
    print("PHONE SHARE PAGE OK")
    br.close()
