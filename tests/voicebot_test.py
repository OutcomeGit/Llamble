# Talking with Llamble: models download, "Hey Llamble" answered out loud to everyone in the
# call, follow-up questions, context, kid calls saved for parents, and the per-server switch.
import requests, sys, json, time, io, os, tarfile, threading, functools
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from websocket import create_connection
B = sys.argv[1]
MAP = "/tmp/fake_stt_map.json"

# --- fake model downloads (same names/layout as the real sherpa-onnx releases)
root = "/tmp/voice-models"
for sub, name, files in [("asr-models", "sherpa-onnx-whisper-tiny.en", ["tiny.en-encoder.int8.onnx", "tiny.en-decoder.int8.onnx", "tiny.en-tokens.txt", "tiny.en-encoder.onnx"]),
                         ("tts-models", "kokoro-int8-en-v0_19", ["model.int8.onnx", "voices.bin", "tokens.txt", "espeak-ng-data/x"])]:
    os.makedirs(f"{root}/{sub}", exist_ok=True)
    with tarfile.open(f"{root}/{sub}/{name}.tar.bz2", "w:bz2") as t:
        for f in files:
            data = b"x" * 1000
            ti = tarfile.TarInfo(f"{name}/{f}"); ti.size = len(data); t.addfile(ti, io.BytesIO(data))
srv = ThreadingHTTPServer(("127.0.0.1", 8094), functools.partial(SimpleHTTPRequestHandler, directory=root))
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
call("PUT", "/api/admin/settings", M, json={"lan_ip": "127.0.0.1"})
mom = call("POST", "/api/auth/register", json={"invite": call("POST", f"/api/guilds/{gid}/invites", M, json={"max_uses": 5})["code"], "username": "mom", "password": "mom-pass1234"})
MOM = mom["token"]

def gw(tok):
    ws = create_connection(B.replace("http", "ws") + "/api/gateway?access_token=" + tok); d = json.loads(ws.recv())["d"]; ws.settimeout(0.3); return ws, d
def events(ws, kind, secs=3.0, stop=None):
    out, end = [], time.time() + secs
    while time.time() < end:
        try: m = json.loads(ws.recv())
        except Exception: continue
        if m.get("t") == kind:
            out.append(m["d"])
            if stop and stop(m["d"]): break
    return out

wsM, ready = gw(M)
assert ready["config"]["voice_ai"]["available"] is False
vc = [c for g in ready["guilds"] for c in g["channels"] if c["kind"] == "voice"][0]["id"]

# --- master turns it on: models download
call("PUT", "/api/admin/voice-ai", MOM, expect=403, json={"enabled": True})
call("PUT", "/api/admin/voice-ai", M, json={"enabled": True, "stt": "whisper-tiny.en", "voice": 9})
for _ in range(60):
    st = call("GET", "/api/admin/voice-ai", M)["status"]
    if st["stt"] == "ready" and st["tts"] == "ready": break
    time.sleep(0.25)
assert st["stt"] == "ready" and st["tts"] == "ready", st
wav = call("POST", "/api/admin/voice-ai/preview", M, json={"text": "testing"})
assert wav.content[:4] == b"RIFF"
print("models downloaded; voice preview works")

# --- off until the server's owner turns it on for their server (and the bot is on there)
call("POST", f"/api/channels/{vc}/voice", M); call("POST", f"/api/channels/{vc}/voice", MOM)
pcm = lambda n: b"\x00\x00" * n
call("POST", f"/api/channels/{vc}/listen", M, expect=400, data=pcm(16000))
call("PUT", f"/api/guilds/{gid}/voice-listen", MOM, expect=403, json={"voice_listen": True})
call("PATCH", f"/api/guilds/{gid}/bot", M, json={"enabled": True})
call("PUT", f"/api/guilds/{gid}/voice-listen", M, json={"voice_listen": True})
upd = events(wsM, "CONFIG_UPDATE", 2, stop=lambda d: gid in d.get("voice_ai", {}).get("guilds", []))
assert upd and gid in upd[-1]["voice_ai"]["guilds"], upd
print("listening is per server and announced to apps")

# --- talk: plain chat isn't answered; "hey llamble" is, out loud, to everyone in the call
wsMom, _ = gw(MOM)
json.dump({"16000": "we should get pizza tonight", "16100": "hey lamble, what should we eat", "16200": "hey llamble", "16300": "is it going to rain"}, open(MAP, "w"))
call("POST", f"/api/channels/{vc}/listen", MOM, data=pcm(16000))
time.sleep(1)
call("POST", f"/api/channels/{vc}/listen", M, data=pcm(16100))
said = events(wsMom, "BOT_SPEAK", 10, stop=lambda d: True)
assert said and said[0]["text"] == "Hello from the server!" and said[0]["audio_url"], said
a = call("GET", said[0]["audio_url"], MOM)
assert a.content[:4] == b"RIFF"
prompt = json.load(open("/tmp/last_prompt.json"))["messages"][1]["content"]
assert "mom: we should get pizza tonight" in prompt and "bran just asked you: what should we eat" in prompt, prompt
print("asked out loud, answered out loud with the call's context")

# just the name, then the question in the next sentence
call("POST", f"/api/channels/{vc}/listen", MOM, data=pcm(16200))
yes = events(wsMom, "BOT_SPEAK", 5, stop=lambda d: True)
assert yes and yes[0]["text"] == "Yes?", yes
call("POST", f"/api/channels/{vc}/listen", MOM, data=pcm(16300))
ans = events(wsMom, "BOT_SPEAK", 10, stop=lambda d: True)
assert ans and json.load(open("/tmp/last_prompt.json"))["messages"][1]["content"].endswith("mom just asked you: is it going to rain"), ans
print('"Hey Llamble" … then the question works')

# --- kids: their calls are saved as text for their parents (adults' aren't)
kid = call("POST", "/api/kids", MOM, json={"username": "junior", "password": "kid-pass12"})
call("POST", f"/api/kids/{kid['user']['id']}/guilds", MOM, json={"guild_id": gid})
K = call("POST", "/api/auth/login", json={"username": "junior", "password": "kid-pass12"})["token"]
assert call("GET", f"/api/kids/{kid['user']['id']}/calls", MOM) == []
call("POST", f"/api/channels/{vc}/voice", K)
json.dump({"16400": "can we play minecraft", "16500": "after homework"}, open(MAP, "w"))
call("POST", f"/api/channels/{vc}/listen", K, data=pcm(16400))
time.sleep(1)
call("POST", f"/api/channels/{vc}/listen", MOM, data=pcm(16500))
time.sleep(1.5)
lines = call("GET", f"/api/kids/{kid['user']['id']}/calls", MOM)
assert [l["text"] for l in lines] == ["can we play minecraft", "after homework"], lines
call("GET", f"/api/kids/{kid['user']['id']}/calls", K, expect=403)
print("calls with a kid in them are saved for the parent")

# ---- "Test: what does it hear?" returns the text only to the person testing
json.dump({"17000": "hey llamble what time is it"}, open(MAP, "w"))
r = call("POST", "/api/voice-ai/test", MOM, data=pcm(17000))
assert r["text"] == "hey llamble what time is it" and r["wake"] and r["question"] == "what time is it", r
a = call("GET", "/api/admin/voice-ai", M)["activity"]
assert a["received"] >= 6 and a["wakes"] >= 2 and a["answers"] >= 2, a
print("hearing test + activity counters work")
