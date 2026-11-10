# Phone notifications without Google: the Android app's listener (/api/notify/stream) gets a
# small notice for DMs and @mentions meant for that person, and nothing else.
import json, sys, threading, time, requests
from websocket import create_connection
B = sys.argv[1]
s = requests.post(B + "/api/setup", json={"username": "bran", "password": "master-pass1", "server_name": "Family"}).json()
M, gid = s["token"], s["guild_id"]
H = lambda t: {"Authorization": "Bearer " + t}
def ok(r, code=200):
    assert r.status_code == code, (r.status_code, r.text[:300]); return r.json() if r.text else None
inv = ok(requests.post(f"{B}/api/guilds/{gid}/invites", headers=H(M), json={"max_uses": 5}))["code"]
reg = ok(requests.post(B + "/api/auth/register", json={"invite": inv, "username": "kiddo", "password": "pass-word-123"}))
K = reg["token"]
kid_id = ok(requests.get(B + "/api/users/@me", headers=H(K)))["id"]
ws = create_connection(B.replace("http", "ws") + "/api/gateway?access_token=" + M)
rd = json.loads(ws.recv())["d"]; ws.close()
general = next(c for g in rd["guilds"] for c in g["channels"] if c["kind"] == "text")["id"]

got = []
def listen():
    with requests.get(B + "/api/notify/stream", headers=H(K), stream=True, timeout=30) as r:
        assert r.status_code == 200 and r.headers["content-type"].startswith("text/event-stream"), r.headers
        ev = None
        for line in r.iter_lines(decode_unicode=True):
            if line.startswith("event:"): ev = line[6:].strip()
            elif line.startswith("data:") and ev == "notify": got.append(json.loads(line[5:]))
            elif line.startswith("data:") and ev == "hello": got.append("hello")
threading.Thread(target=listen, daemon=True).start()
for _ in range(50):
    if got: break
    time.sleep(0.1)
assert got == ["hello"], got
assert requests.get(B + "/api/notify/stream").status_code == 401

ok(requests.post(f"{B}/api/channels/{general}/messages", headers=H(M), json={"content": "just chatting"}))
ok(requests.post(f"{B}/api/channels/{general}/messages", headers=H(K), json={"content": f"me myself <@{kid_id}>"}))
ok(requests.post(f"{B}/api/channels/{general}/messages", headers=H(M), json={"content": f"hey <@{kid_id}> dinner"}))
dm = ok(requests.post(B + "/api/users/@me/channels", headers=H(M), json={"recipient_id": kid_id}))
ok(requests.post(f"{B}/api/channels/{dm['id']}/messages", headers=H(M), json={"content": "come downstairs"}))
time.sleep(1)
notes = got[1:]
assert len(notes) == 2, notes
assert notes[0]["body"] == f"hey <@{kid_id}> dinner" and "(#general, Family)" in notes[0]["title"] and notes[0]["channel_id"] == general, notes[0]
assert notes[1]["body"] == "come downstairs" and notes[1]["title"] == "bran" and notes[1]["guild_id"] is None and notes[1]["tag"].startswith("m:"), notes[1]
print("listener got the @mention and the DM; not plain chat, not their own message")

# Do Not Disturb: nothing
wk = create_connection(B.replace("http", "ws") + "/api/gateway?access_token=" + K); wk.recv()
wk.send(json.dumps({"op": "presence", "status": "dnd"})); time.sleep(0.5)
ok(requests.post(f"{B}/api/channels/{dm['id']}/messages", headers=H(M), json={"content": "you there?"}))
time.sleep(1)
assert len(got) == 3, got
print("Do Not Disturb: no notice")
print("ALL PUSHES OK")
