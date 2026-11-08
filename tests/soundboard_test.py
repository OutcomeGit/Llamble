# Soundboard (server sounds + built-ins, only people in the call hear it) and chat screen effects.
import requests, sys, json, time, io, wave
from websocket import create_connection
B = sys.argv[1]

def call(method, path, tok=None, expect=200, **kw):
    h = {"Authorization": "Bearer " + tok} if tok else {}
    r = requests.request(method, B + path, headers=h, **kw)
    if r.status_code != expect:
        raise SystemExit(f"FAIL {method} {path}: wanted {expect}, got {r.status_code} {r.text[:300]}")
    return r.json() if r.text else {}

s = call("POST", "/api/setup", json={"username": "bran", "password": "master-pass1", "server_name": "Sounds"})
M, gid = s["token"], s["guild_id"]
call("PUT", "/api/admin/settings", M, json={"lan_ip": "127.0.0.1"})
inv = call("POST", f"/api/guilds/{gid}/invites", M, json={"max_uses": 9})["code"]
mom = call("POST", "/api/auth/register", json={"invite": inv, "username": "mom", "password": "mom-pass1234"})
pal = call("POST", "/api/auth/register", json={"invite": inv, "username": "pal", "password": "pal-pass1234"})
MOM, PAL = mom["token"], pal["token"]

def gw(tok):
    ws = create_connection(B.replace("http", "ws") + "/api/gateway?access_token=" + tok); d = json.loads(ws.recv())["d"]; ws.settimeout(0.3); return ws, d
def events(ws, kind, secs=1.5):
    out, end = [], time.time() + secs
    while time.time() < end:
        try: m = json.loads(ws.recv())
        except Exception: continue
        if m.get("t") == kind: out.append(m["d"])
    return out

wsM, ready = gw(M); wsMom, _ = gw(MOM); wsPal, _ = gw(PAL)
vc = [c for g in ready["guilds"] for c in g["channels"] if c["kind"] == "voice"][0]["id"]
tc = [c for g in ready["guilds"] for c in g["channels"] if c["kind"] == "text"][0]["id"]

# ---- a server sound: only managers can add it; audio files only, 1 MB max
buf = io.BytesIO()
with wave.open(buf, "wb") as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(8000); w.writeframes(b"\0\0" * 8000)
wav = call("POST", "/api/files", M, files={"file": ("honk.wav", buf.getvalue(), "audio/wav")})
call("POST", f"/api/guilds/{gid}/sounds", MOM, expect=403, json={"name": "honk", "file_id": wav["id"]})
png = call("POST", "/api/files", M, files={"file": ("x.png", b"\x89PNG\r\n\x1a\n" + b"0" * 100, "image/png")})
call("POST", f"/api/guilds/{gid}/sounds", M, expect=400, json={"name": "nope", "file_id": png["id"]})
sid = call("POST", f"/api/guilds/{gid}/sounds", M, json={"name": "honk", "emoji": "🪿", "file_id": wav["id"]})["id"]
upd = events(wsMom, "SOUNDS_UPDATE")
assert upd and upd[-1]["sounds"][0]["name"] == "honk", upd
lst = call("GET", f"/api/guilds/{gid}/sounds", PAL)
assert "airhorn" in lst["builtin"] and lst["sounds"][0]["id"] == sid
print("server sound added by the owner; members got the update; non-audio refused")

# ---- playing: must be in the call; only people in the call hear it; cooldown
call("POST", f"/api/channels/{vc}/soundboard", MOM, expect=400, json={"sound": "builtin:airhorn"})
call("POST", f"/api/channels/{vc}/voice", M)
call("POST", f"/api/channels/{vc}/voice", MOM)
events(wsMom, "x", 0.5); events(wsPal, "x", 0.5); events(wsM, "x", 0.5)
call("POST", f"/api/channels/{vc}/soundboard", MOM, json={"sound": "builtin:airhorn"})
call("POST", f"/api/channels/{vc}/soundboard", MOM, expect=400, json={"sound": "builtin:airhorn"})   # too fast
heard = events(wsM, "SOUNDBOARD_PLAY")
assert heard and heard[0]["sound"]["builtin"] == "airhorn" and heard[0]["user_id"] == mom["user"]["id"], heard
assert not events(wsPal, "SOUNDBOARD_PLAY", 0.5), "pal isn't in the call"
time.sleep(1.6)
call("POST", f"/api/channels/{vc}/soundboard", M, json={"sound": sid})
heard = [h for h in events(wsMom, "SOUNDBOARD_PLAY") if "file_id" in h["sound"]]
assert heard and heard[0]["sound"]["file_id"] == wav["id"], heard
call("POST", f"/api/channels/{vc}/soundboard", M, expect=400, json={"sound": "builtin:../../etc/passwd"})
print("only people in the call hear sounds; cooldown works; unknown sounds refused")

# the sound file survives the cleanup of unattached uploads
call("DELETE", f"/api/guilds/{gid}/sounds/{sid}", M)
assert call("GET", f"/api/guilds/{gid}/sounds", M)["sounds"] == []

# ---- chat screen effects ride along with the message
events(wsPal, "x", 0.3)
m = call("POST", f"/api/channels/{tc}/messages", MOM, json={"content": "happy birthday!", "effect": "confetti"})
assert m["effect"] == "confetti"
got = events(wsPal, "MESSAGE_CREATE")
assert got and got[0]["effect"] == "confetti", got
m = call("POST", f"/api/channels/{tc}/messages", MOM, json={"content": "hi", "effect": "nuke-the-site"})
assert "effect" not in m
print("screen effects are sent with messages; unknown effects ignored")
