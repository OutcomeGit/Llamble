# "Playing X": a game reported by one person reaches the others, survives in READY,
# is hidden while invisible, and clears when they stop playing.
import requests, sys, json, time
from websocket import create_connection
B = sys.argv[1]
s = requests.post(B + "/api/setup", json={"username": "bran", "password": "master-pass1", "server_name": "Family"}).json()
M, gid = s["token"], s["guild_id"]
inv = requests.post(f"{B}/api/guilds/{gid}/invites", headers={"Authorization": "Bearer " + M}, json={"max_uses": 5}).json()["code"]
K = requests.post(B + "/api/auth/register", json={"invite": inv, "username": "kiddo", "password": "pass-word-123"}).json()["token"]

def conn(tok):
    ws = create_connection(B.replace("http", "ws") + "/api/gateway?access_token=" + tok)
    return ws, json.loads(ws.recv())["d"]

def wait(ws, t, pred=lambda d: True, secs=3):
    ws.settimeout(0.3)
    end = time.time() + secs
    while time.time() < end:
        try:
            m = json.loads(ws.recv())
        except Exception:
            continue
        if m.get("t") == t and pred(m["d"]):
            return m["d"]
    return None

bran, _ = conn(M)
kid, kd = conn(K)
kid_id = kd["user"]["id"]
kid.send(json.dumps({"op": "activity", "game": "Roblox"}))
d = wait(bran, "ACTIVITY_UPDATE", lambda d: d["user_id"] == kid_id)
assert d and d["game"] == "Roblox", d

# someone connecting later sees it in READY
b2, rd = conn(M)
p = [x for x in rd["presences"] if x["user_id"] == kid_id]
assert p and p[0].get("game") == "Roblox", rd["presences"]
b2.close()

# junk is trimmed and control characters dropped
kid.send(json.dumps({"op": "activity", "game": "Mine\ncraft" + "x" * 200}))
d = wait(bran, "ACTIVITY_UPDATE", lambda d: d["user_id"] == kid_id)
assert d["game"].startswith("Minecraft") and len(d["game"]) == 80, d

# invisible hides it
kid.send(json.dumps({"op": "presence", "status": "invisible"}))
d = wait(bran, "ACTIVITY_UPDATE", lambda d: d["user_id"] == kid_id)
assert d and d["game"] is None, d
kid.send(json.dumps({"op": "activity", "game": "Roblox"}))
assert wait(bran, "ACTIVITY_UPDATE", lambda d: d["user_id"] == kid_id, 1.5) is None, "invisible person announced a game"

kid.send(json.dumps({"op": "presence", "status": "online"}))
kid.send(json.dumps({"op": "activity", "game": "Roblox"}))
assert wait(bran, "ACTIVITY_UPDATE", lambda d: d["user_id"] == kid_id and d["game"] == "Roblox")
kid.send(json.dumps({"op": "activity", "game": None}))
d = wait(bran, "ACTIVITY_UPDATE", lambda d: d["user_id"] == kid_id)
assert d and d["game"] is None, d
print("Playing X: shared, in READY, trimmed, hidden while invisible, cleared")
