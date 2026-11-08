# Everyone reconnecting at once (after a server restart) must still see each other online.
import requests, sys, json, threading, time
from websocket import create_connection
B = sys.argv[1]
s = requests.post(B + "/api/setup", json={"username": "bran", "password": "master-pass1", "server_name": "Family"}).json()
M, gid = s["token"], s["guild_id"]
inv = requests.post(f"{B}/api/guilds/{gid}/invites", headers={"Authorization": "Bearer " + M}, json={"max_uses": 50}).json()["code"]
toks = {"bran": M}
for i in range(7):
    r = requests.post(B + "/api/auth/register", json={"invite": inv, "username": f"user{i}", "password": "pass-word-123"}).json()
    toks[f"user{i}"] = r["token"]
ids = {}
for rnd in range(5):
    seen, socks = {}, {}
    def go(name):
        ws = create_connection(B.replace("http", "ws") + "/api/gateway?access_token=" + toks[name])
        d = json.loads(ws.recv())["d"]
        ids[name] = d["user"]["id"]
        on = {p["user_id"] for p in d["presences"] if p["status"] != "offline"}
        ws.settimeout(0.3)
        end = time.time() + 2
        while time.time() < end:
            try:
                m = json.loads(ws.recv())
            except Exception:
                continue
            if m.get("t") == "PRESENCE_UPDATE":
                (on.add if m["d"]["status"] != "offline" else on.discard)(m["d"]["user_id"])
        seen[name] = on
        socks[name] = ws
    th = [threading.Thread(target=go, args=(n,)) for n in toks]
    [t.start() for t in th]; [t.join() for t in th]
    for n, on in seen.items():
        missing = {k for k, v in ids.items() if k != n and v not in on}
        assert not missing, f"round {rnd}: {n} doesn't see {missing} online"
    for w in socks.values(): w.close()
    time.sleep(9)  # past the offline grace period
print("8 people connecting at once all see each other online (5 rounds)")
