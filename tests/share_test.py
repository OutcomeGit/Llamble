# "Share to…": a message with its picture goes to another channel/DM, credited to its
# author; you can't share what you can't see, and nobody can borrow others' files by it.
import io, json, sys, requests
from websocket import create_connection
B = sys.argv[1]
s = requests.post(B + "/api/setup", json={"username": "bran", "password": "master-pass1", "server_name": "Family"}).json()
M, gid = s["token"], s["guild_id"]
H = lambda t: {"Authorization": "Bearer " + t}
def ok(r, code=200):
    assert r.status_code == code, (r.status_code, r.text[:300]); return r.json() if r.text else None
inv = ok(requests.post(f"{B}/api/guilds/{gid}/invites", headers=H(M), json={"max_uses": 5}))["code"]
K = ok(requests.post(B + "/api/auth/register", json={"invite": inv, "username": "kiddo", "password": "pass-word-123"}))["token"]
def text_channel(tok, guild):
    ws = create_connection(B.replace("http", "ws") + "/api/gateway?access_token=" + tok)
    rd = json.loads(ws.recv())["d"]; ws.close()
    return next(c for g in rd["guilds"] if g["guild"]["id"] == guild for c in g["channels"] if c["kind"] == "text")["id"]
general = text_channel(M, gid)
other = ok(requests.post(f"{B}/api/guilds/{gid}/channels", headers=H(M), json={"name": "pictures", "kind": "text"}))["id"]
# a server the kid isn't in
g2 = ok(requests.post(B + "/api/guilds", headers=H(M), json={"name": "Grown-ups"}))
secret = text_channel(M, (g2.get("guild") or g2)["id"])

png = io.BytesIO(bytes.fromhex("89504e470d0a1a0a0000000d4948445200000001000000010806000000" "1f15c4890000000d49444154789c6360000002000100" "05fe02fea30000000049454e44ae426082"))
f = ok(requests.post(B + "/api/files", headers=H(M), files={"file": ("llama.png", png, "image/png")}))
m = ok(requests.post(f"{B}/api/channels/{general}/messages", headers=H(M), json={"content": "look at this llama\nsecond line", "attachments": [{"id": f["id"]}]}))

# kid shares bran's picture message into #pictures, with a comment
sh = ok(requests.post(f"{B}/api/messages/{m['id']}/share", headers=H(K), json={"channel_id": other, "comment": "so cute"}))
assert sh["channel_id"] == other and sh["attachments"] and sh["attachments"][0]["id"] == f["id"], sh
assert sh["content"].startswith("so cute") and "Shared from **bran" in sh["content"] and "> look at this llama" in sh["content"] and "> second line" in sh["content"], sh["content"]
print("shared with picture and credit:", sh["content"].replace("\n", " | "))

# a message the kid can't see can't be shared by the kid
hid = ok(requests.post(f"{B}/api/channels/{secret}/messages", headers=H(M), json={"content": "admin stuff"}))
r = requests.post(f"{B}/api/messages/{hid['id']}/share", headers=H(K), json={"channel_id": other})
assert r.status_code in (403, 404), r.text
# ...and can't be shared INTO a channel they can't post in
r = requests.post(f"{B}/api/messages/{m['id']}/share", headers=H(K), json={"channel_id": secret})
assert r.status_code in (403, 404), r.text
# shared_from can't be smuggled in by a client to borrow someone else's file
r = requests.post(f"{B}/api/channels/{other}/messages", headers=H(K), json={"content": "mine now", "attachments": [{"id": f["id"]}], "shared_from": m["id"]})
assert r.status_code == 400, r.text
print("can't share what you can't see, can't post where you can't, can't borrow files")
