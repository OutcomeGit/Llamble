# Home: notes (for everyone / picked people, read receipts, dismiss, expiry, kids' rules)
# and highlights (add, duplicates, who can see them, cleanup, auto setting).
import io, json, sys, time, requests
from websocket import create_connection
B = sys.argv[1]

def call(method, path, tok=None, expect=200, **kw):
    h = {"Authorization": "Bearer " + tok} if tok else {}
    r = requests.request(method, B + path, headers=h, **kw)
    if r.status_code != expect:
        raise SystemExit(f"FAIL {method} {path}: wanted {expect}, got {r.status_code} {r.text[:300]}")
    return r.json() if r.text else {}

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

s = call("POST", "/api/setup", json={"username": "bran", "password": "master-pass1", "server_name": "Family"})
M, gid = s["token"], s["guild_id"]
inv = call("POST", f"/api/guilds/{gid}/invites", M, json={"max_uses": 10})["code"]
reg = lambda u: call("POST", "/api/auth/register", json={"invite": inv, "username": u, "password": "pass-word-123"})
MOM, BOB, AMY = reg("mom")["token"], reg("bob")["token"], reg("amy")["token"]
uid = lambda t: call("GET", "/api/users/@me", t)["id"]
mom_id, bob_id, amy_id = uid(MOM), uid(BOB), uid(AMY)
# someone in a different server only
g2 = call("POST", "/api/guilds", M, json={"name": "Grown-ups"})
g2id = (g2.get("guild") or g2)["id"]
inv2 = call("POST", f"/api/guilds/{g2id}/invites", M, json={"max_uses": 2})["code"]
OUT = call("POST", "/api/auth/register", json={"invite": inv2, "username": "outsider", "password": "pass-word-123"})["token"]

# ---- a note for everyone: shows on Home and arrives live
wsb, _ = conn(BOB)
n1 = call("POST", f"/api/guilds/{gid}/notes", M, json={"content": "Game night Friday 8pm!", "color": "pink"})
assert n1["audience"] == "everyone" and n1["to"] == [] and n1["read"] and n1["color"] == "pink", n1
assert n1["target_count"] == 3, n1  # mom, bob, amy (not bran)
live = wait(wsb, "NOTE_CREATE", lambda d: d["id"] == n1["id"])
assert live and not live["read"] and not live["dismissed"], live
home = call("GET", "/api/home", BOB)
assert [n["id"] for n in home["notes"]] == [n1["id"]], home
assert call("GET", "/api/home", M)["notes"] == [], "your own notes aren't in your Home pile"
print("note for everyone: on Home, live over the gateway")

# ---- a note for picked people
n2 = call("POST", f"/api/guilds/{gid}/notes", M, json={"content": "Hey Bob, on around 10 pm", "to": [bob_id, bran_id] if (bran_id := uid(M)) else []})
assert n2["audience"] == "people" and n2["to"] == [bob_id] and n2["target_count"] == 1, n2  # author dropped from targets
assert any(n["id"] == n2["id"] for n in call("GET", "/api/home", BOB)["notes"])
assert not any(n["id"] == n2["id"] for n in call("GET", "/api/home", AMY)["notes"])
assert not any(n["id"] == n2["id"] for n in call("GET", f"/api/guilds/{gid}/notes", AMY))
call("POST", f"/api/notes/{n2['id']}/read", AMY, expect=404)
call("POST", f"/api/guilds/{gid}/notes", M, expect=400, json={"content": "x", "to": ["not-a-member"]})
call("POST", f"/api/guilds/{gid}/notes", M, expect=400, json={"content": "   "})
call("POST", f"/api/guilds/{gid}/notes", M, expect=400, json={"content": "x", "color": "orange"})
print("note for picked people: only they see it")

# ---- read receipts
wsm, _ = conn(M)
call("POST", f"/api/notes/{n1['id']}/read", BOB)
call("POST", f"/api/notes/{n1['id']}/read", BOB)  # idempotent
r = wait(wsm, "NOTE_READ", lambda d: d["id"] == n1["id"])
assert r and r["user_id"] == bob_id and r["read_count"] == 1, r
mine = [n for n in call("GET", f"/api/guilds/{gid}/notes", M) if n["id"] == n1["id"]][0]
assert mine["read_count"] == 1, mine
reads = call("GET", f"/api/notes/{n1['id']}/reads", M)
assert [x["user"]["id"] for x in reads] == [bob_id], reads
call("GET", f"/api/notes/{n1['id']}/reads", BOB, expect=403)
print("author sees who read it")

# ---- dismiss / undismiss
call("POST", f"/api/notes/{n1['id']}/dismiss", AMY)
assert not any(n["id"] == n1["id"] for n in call("GET", "/api/home", AMY)["notes"])
board = [n for n in call("GET", f"/api/guilds/{gid}/notes", AMY) if n["id"] == n1["id"]][0]
assert board["dismissed"] and board["read"], board
call("POST", f"/api/notes/{n1['id']}/undismiss", AMY)
assert any(n["id"] == n1["id"] for n in call("GET", "/api/home", AMY)["notes"])
print("dismiss hides it from Home; still on the server's board")

# ---- expiry
soon = int(time.time() * 1000) + 1500
n3 = call("POST", f"/api/guilds/{gid}/notes", M, json={"content": "brb", "expires_at": soon})
assert any(n["id"] == n3["id"] for n in call("GET", "/api/home", BOB)["notes"])
time.sleep(2)
assert not any(n["id"] == n3["id"] for n in call("GET", "/api/home", BOB)["notes"])
call("POST", f"/api/guilds/{gid}/notes", M, expect=400, json={"content": "x", "expires_at": 1000})
call("POST", f"/api/guilds/{gid}/notes", M, expect=400, json={"content": "x", "expires_at": int(time.time() * 1000) + 100 * 86400000})
print("expired notes disappear")

# ---- edit / delete
e = call("PATCH", f"/api/notes/{n1['id']}", M, json={"content": "Game night moved to Saturday", "expires_at": None})
assert e["content"].startswith("Game night moved") and e["edited_at"], e
call("PATCH", f"/api/notes/{n1['id']}", BOB, expect=403, json={"content": "hacked"})
nb = call("POST", f"/api/guilds/{gid}/notes", BOB, json={"content": "bob's note"})
call("DELETE", f"/api/notes/{nb['id']}", AMY, expect=403)
call("DELETE", f"/api/notes/{nb['id']}", M)  # server owner (MANAGE_MESSAGES)
na = call("POST", f"/api/guilds/{gid}/notes", AMY, json={"content": "amy's note"})
call("DELETE", f"/api/notes/{na['id']}", AMY)
assert not any(n["id"] in (nb["id"], na["id"]) for n in call("GET", f"/api/guilds/{gid}/notes", M))
print("edit by author; delete by author or admin")

# ---- outsiders can't read another server's notes or highlights
call("GET", f"/api/guilds/{gid}/notes", OUT, expect=404)
call("GET", f"/api/guilds/{gid}/highlights", OUT, expect=404)
call("POST", f"/api/guilds/{gid}/notes", OUT, expect=404, json={"content": "hi"})
assert call("GET", "/api/home", OUT)["notes"] == []
print("non-members see nothing")

# ---- kids: notes follow the DM rules
kid = call("POST", "/api/kids", MOM, json={"username": "junior", "display_name": "Junior", "password": "kid-pass12"})
kid_id = kid["user"]["id"]
call("POST", f"/api/kids/{kid_id}/guilds", MOM, json={"guild_id": gid})
r = requests.post(f"{B}/api/guilds/{gid}/notes", headers={"Authorization": "Bearer " + BOB}, json={"content": "hey junior", "to": [kid_id]})
assert r.status_code == 403 and "parent" in r.text.lower(), r.text
assert call("GET", "/api/kids", MOM)[0]["requests"], "mom was asked"
call("POST", f"/api/guilds/{gid}/notes", MOM, json={"content": "dinner at 6", "to": [kid_id]})  # parents are always fine
print("kids: notes from strangers need a parent's OK")

# ---- highlights
png = io.BytesIO(bytes.fromhex("89504e470d0a1a0a0000000d4948445200000001000000010806000000" "1f15c4890000000d49444154789c6360000002000100" "05fe02fea30000000049454e44ae426082"))
f = requests.post(B + "/api/files", headers={"Authorization": "Bearer " + M}, files={"file": ("llama.png", png, "image/png")}).json()
rd = conn(M)[1]
general = next(c for g in rd["guilds"] if g["guild"]["id"] == gid for c in g["channels"] if c["kind"] == "text")["id"]
msg = call("POST", f"/api/channels/{general}/messages", M, json={"content": "llama pic", "attachments": [{"id": f["id"]}]})
h = call("POST", f"/api/guilds/{gid}/highlights", BOB, json={"message_id": msg["id"]})
assert h["kind"] == "message" and h["message"]["attachments"][0]["id"] == f["id"] and h["added_by"]["id"] == bob_id and not h["auto"] and h["channel_id"] == general, h
again = call("POST", f"/api/guilds/{gid}/highlights", AMY, json={"message_id": msg["id"]})
assert again["id"] == h["id"], "duplicate returns the same highlight"
assert [x["id"] for x in call("GET", "/api/home", AMY)["highlights"]] == [h["id"]]
assert [x["id"] for x in call("GET", f"/api/guilds/{gid}/highlights", AMY)] == [h["id"]]
assert call("GET", "/api/home", OUT)["highlights"] == []
call("POST", f"/api/guilds/{g2id}/highlights", M, expect=400, json={"message_id": msg["id"]})  # wrong server
call("DELETE", f"/api/highlights/{h['id']}", AMY, expect=403)
call("DELETE", f"/api/highlights/{h['id']}", BOB)
assert call("GET", f"/api/guilds/{gid}/highlights", BOB) == []
h2 = call("POST", f"/api/guilds/{gid}/highlights", BOB, json={"message_id": msg["id"]})
wsa, _ = conn(AMY)
call("DELETE", f"/api/messages/{msg['id']}", M)
assert wait(wsa, "HIGHLIGHT_DELETE", lambda d: d["id"] == h2["id"]), "deleting the message removes its highlight"
assert call("GET", f"/api/guilds/{gid}/highlights", BOB) == []
print("highlights: add, duplicate, visible only to members, delete, gone with the message")

# ---- per-server auto settings
g = call("PATCH", f"/api/guilds/{gid}", M, json={"highlights_auto_pictures": False})
assert g["highlights_auto_pictures"] is False and g["highlights_auto_recordings"] is True, g
g = call("PATCH", f"/api/guilds/{gid}", M, json={"highlights_auto_pictures": True})
assert g["highlights_auto_pictures"] is True
call("PATCH", f"/api/guilds/{gid}", BOB, expect=403, json={"highlights_auto_pictures": False})
assert next(x for x in conn(BOB)[1]["guilds"] if x["guild"]["id"] == gid)["guild"]["highlights_auto_pictures"] is True
print("auto-highlight settings per server")
