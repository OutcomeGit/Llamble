# News (instance / server / signed Llamble news), news writers, "Post news" and
# "Add highlights" permissions, board preferences (notes off blocks notes to you,
# highlights off / highlight kinds on Home), and the highlight "type" field.
# Usage: news_test.py BASE [nokey]
import base64, io, json, sys, threading, time
from http.server import BaseHTTPRequestHandler, HTTPServer
import requests
from websocket import create_connection

B = sys.argv[1]
MODE = sys.argv[2] if len(sys.argv) > 2 else "full"
H = lambda t: {"Authorization": "Bearer " + t}
SEED = bytes(range(32))  # run_all.sh derives LLAMBLE_NEWS_TEST_KEY from this same seed


def call(method, path, tok, expect=200, **kw):
    r = requests.request(method, B + path, headers=H(tok), **kw)
    assert r.status_code == expect, (method, path, r.status_code, r.text[:300])
    return r.json() if r.text else None


s = requests.post(B + "/api/setup", json={"username": "bran", "password": "master-pass1", "server_name": "Family"}).json()
M, gid = s["token"], s["guild_id"]

if MODE == "nokey":
    st = call("GET", "/api/news/llamble", M)
    if st["error"] and "no news key" in st["error"]:
        assert st["enabled"] is True and st["items"] == [], st
        print("Llamble news without a key in this build: enabled, but says there's no key")
    else:
        print("this build has a news key built in; nothing to check without one")
    sys.exit(0)

inv = call("POST", f"/api/guilds/{gid}/invites", M, json={"max_uses": 10})["code"]
def register(name):
    r = requests.post(B + "/api/auth/register", json={"invite": inv, "username": name, "password": "pass-word-123"}).json()
    return r["token"], r["user"]["id"]
A, aid = register("amy")      # will be a news person in the server
C, cid = register("cody")     # a plain member
W, wid = register("wren")     # will be an instance news writer

def ready(tok):
    ws = create_connection(B.replace("http", "ws") + "/api/gateway?access_token=" + tok)
    d = json.loads(ws.recv())["d"]
    return ws, d

def wait(ws, t, pred=lambda d: True, secs=5):
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

ws_c, rd = ready(C)
g = next(x for x in rd["guilds"] if x["guild"]["id"] == gid)
text = next(c for c in g["channels"] if c["kind"] == "text")["id"]

# ---- instance news: master yes, plain user no, news writer after the toggle
n1 = call("POST", "/api/news", M, json={"title": "Server maintenance tonight", "body": "Back by **10 pm**.", "pinned": True})
assert n1["scope"] == "instance" and n1["author"]["username"] == "bran" and n1["pinned"] is True, n1
assert wait(ws_c, "NEWS_CREATE", lambda d: d["id"] == n1["id"]), "everyone online hears about instance news"
call("POST", "/api/news", W, expect=403, json={"title": "hi"})
call("PUT", f"/api/admin/users/{wid}/news-writer", C, expect=403, json={"on": True})
call("PUT", f"/api/admin/users/{wid}/news-writer", M, json={"on": True})
assert call("GET", "/api/users/@me", W)["news_writer"] is True
assert any(u["id"] == wid and u["news_writer"] for u in call("GET", "/api/admin/users", M))
n2 = call("POST", "/api/news", W, json={"title": "Game night is Friday"})
assert [n["id"] for n in call("GET", "/api/news?scope=instance", C)][:2] == [n1["id"], n2["id"]], "pinned first"
call("POST", "/api/news", W, expect=400, json={"title": ""})
call("PATCH", f"/api/news/{n2['id']}", C, expect=403, json={"title": "nope"})
assert call("PATCH", f"/api/news/{n2['id']}", W, json={"title": "Game night moved to Saturday"})["edited_at"]
print("instance news: master and news writers post, others can't; pinned first; edits by author")

# ---- server news needs "Post news"
call("POST", f"/api/guilds/{gid}/news", A, expect=403, json={"title": "Patch notes"})
role = call("POST", f"/api/guilds/{gid}/roles", M, json={"name": "News", "permissions": 1 | (1 << 16)})
call("PUT", f"/api/guilds/{gid}/members/{aid}/roles/{role['id']}", M)
png = bytes.fromhex("89504e470d0a1a0a0000000d4948445200000001000000010806000000" "1f15c4890000000d49444154789c6360000002000100" "05fe02fea30000000049454e44ae426082")
img = call("POST", "/api/files", A, files={"file": ("banner.png", io.BytesIO(png), "image/png")})
gn = call("POST", f"/api/guilds/{gid}/news", A, json={"title": "Raid this weekend", "body": "Bring snacks", "image_id": img["id"]})
assert gn["scope"] == "guild" and gn["guild_id"] == gid and gn["image"]["id"] == img["id"] and gn["image"]["content_type"] == "image/png", gn
assert wait(ws_c, "NEWS_CREATE", lambda d: d["id"] == gn["id"])
r = requests.get(B + gn["image"]["url"], headers=H(C))
assert r.status_code == 200, "members can see the news picture"
home = call("GET", "/api/home", C)
assert {n["id"] for n in home["news"]} >= {n1["id"], n2["id"], gn["id"]}, home["news"]
call("DELETE", f"/api/news/{gn['id']}", C, expect=403)
print("server news: needs Post news, carries its picture, shows on Home")

# ---- board prefs: news off for a server hides its news on Home (instance news stays)
call("PUT", f"/api/board-prefs/{gid}", C, json={"news": False})
ids = {n["id"] for n in call("GET", "/api/home", C)["news"]}
assert gn["id"] not in ids and n1["id"] in ids, ids
call("PUT", f"/api/board-prefs/{gid}", C, json={"news": True})

# ---- notes off: nobody can leave notes for you there, everyone-notes skip you
call("PUT", f"/api/board-prefs/{gid}", C, json={"notes": False})
p = call("GET", "/api/board-prefs", C)
assert p["guilds"][gid]["notes"] is False and p["guilds"][gid]["highlights"] is True and p["llamble_news"] is True, p
r = requests.post(B + f"/api/guilds/{gid}/notes", headers=H(A), json={"content": "hey cody", "to": [cid]})
assert r.status_code == 400 and "cody isn't taking notes in this server" in r.text, r.text
everyone = call("POST", f"/api/guilds/{gid}/notes", A, json={"content": "pizza friday"})
assert not wait(ws_c, "NOTE_CREATE", lambda d: d["id"] == everyone["id"], secs=1.5), "no NOTE_CREATE for someone with notes off"
assert everyone["id"] not in [n["id"] for n in call("GET", "/api/home", C)["notes"]]
before = everyone["target_count"]
call("PUT", f"/api/board-prefs/{gid}", C, json={"notes": True})
assert everyone["id"] in [n["id"] for n in call("GET", "/api/home", C)["notes"]]
after = call("GET", f"/api/guilds/{gid}/notes", A)
assert next(n for n in after if n["id"] == everyone["id"])["target_count"] == before + 1, "turning notes back on counts you again"
print("notes off: targeted notes refused with a friendly message, everyone-notes skip you")

# ---- highlights: type field, Home filters, ADD_HIGHLIGHTS permission
pic_msg = call("POST", f"/api/channels/{text}/messages", M, json={"content": "look", "attachments": [{"id": call("POST", "/api/files", M, files={"file": ("p.png", io.BytesIO(png), "image/png")})["id"]}]})
post_msg = call("POST", f"/api/channels/{text}/messages", M, json={"content": "just words"})
link_msg = call("POST", f"/api/channels/{text}/messages", M, json={"content": "see https://example.com/page"})
h_pic = call("POST", f"/api/guilds/{gid}/highlights", C, json={"message_id": pic_msg["id"]})
h_post = call("POST", f"/api/guilds/{gid}/highlights", C, json={"message_id": post_msg["id"]})
h_link = call("POST", f"/api/guilds/{gid}/highlights", C, json={"message_id": link_msg["id"]})
assert (h_pic["type"], h_post["type"], h_link["type"]) == ("pictures", "posts", "links"), (h_pic["type"], h_post["type"], h_link["type"])
only = call("GET", f"/api/guilds/{gid}/highlights?type=pictures", C)
assert [h["id"] for h in only] == [h_pic["id"]], only
call("GET", f"/api/guilds/{gid}/highlights?type=bogus", C, expect=400)
call("PUT", f"/api/board-prefs/{gid}", C, json={"highlight_types": ["pictures"]})
assert [h["id"] for h in call("GET", "/api/home", C)["highlights"]] == [h_pic["id"]]
assert call("GET", "/api/board-prefs", C)["guilds"][gid]["highlight_types"] == ["pictures"]
call("PUT", f"/api/board-prefs/{gid}", C, expect=400, json={"highlight_types": ["memes"]})
call("PUT", f"/api/board-prefs/{gid}", C, json={"highlight_types": "all", "highlights": False})
assert call("GET", "/api/home", C)["highlights"] == [], "highlights off for this server"
assert len(call("GET", f"/api/guilds/{gid}/highlights", C)) == 3, "the server's own board still lists them"
call("PUT", f"/api/board-prefs/{gid}", C, json={"highlights": True})
assert len(call("GET", "/api/home", C)["highlights"]) == 3
# take "Add highlights" away from @everyone (role id = server id): members can't add any more
roles = next(x for x in ready(M)[1]["guilds"] if x["guild"]["id"] == gid)["roles"]
everyone_role = next(r for r in roles if r["id"] == gid)
assert everyone_role["permissions"] & (1 << 17), "new servers give everyone Add highlights"
call("PATCH", f"/api/guilds/{gid}/roles/{gid}", M, json={"permissions": everyone_role["permissions"] & ~(1 << 17)})
call("POST", f"/api/guilds/{gid}/highlights", C, expect=403, json={"message_id": link_msg["id"]})
print("highlights: type field, ?type filter, Home kinds/off prefs, Add highlights permission")

# ---- Llamble news: signed file, tampering rejected (old copy kept)
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
sk = Ed25519PrivateKey.from_private_bytes(SEED)
payload = json.dumps({"version": 1, "items": [
    {"id": "2026-11-08-hello", "title": "Hello from Llamble", "body": "Push to talk is here", "url": "https://llamble.com", "image": "http://evil.example/x.png", "published_at": 1731100000000},
]})
good = json.dumps({"payload": payload, "signature": base64.b64encode(sk.sign(payload.encode())).decode()}).encode()
serving = {"body": good}
class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200); self.send_header("content-type", "application/json"); self.end_headers(); self.wfile.write(serving["body"])
    def log_message(self, *a): pass
srv = HTTPServer(("127.0.0.1", 0), Handler)
threading.Thread(target=srv.serve_forever, daemon=True).start()
url = f"http://127.0.0.1:{srv.server_port}/news.json"
call("PUT", "/api/admin/settings", M, json={"llamble_news_url": url})
for _ in range(40):
    st = call("GET", "/api/news/llamble", C)
    if st["items"]:
        break
    time.sleep(0.25)
assert st["items"] and st["items"][0]["title"] == "Hello from Llamble" and st["error"] is None, st
it = st["items"][0]
assert it["scope"] == "llamble" and it["author"] is None and it["url"] == "https://llamble.com" and it["image"] is None, it
serving["body"] = json.dumps({"payload": payload.replace("Hello", "Hacked"), "signature": json.loads(good)["signature"]}).encode()
st = call("POST", "/api/admin/llamble-news/refresh", M)
assert st["error"] and "signature" in st["error"] and st["items"][0]["title"] == "Hello from Llamble", st
call("POST", "/api/admin/llamble-news/refresh", C, expect=403)
call("PUT", "/api/board-prefs/llamble", C, json={"on": False})
assert call("GET", "/api/board-prefs", C)["llamble_news"] is False
call("PUT", "/api/admin/settings", M, expect=400, json={"llamble_news_url": "ftp://nope"})
print("Llamble news: signed entries shown (non-https image dropped), tampered file rejected and old copy kept")

# ---- kids can read news but can't post it or be news writers
call("POST", f"/api/admin/users/{aid}/kid", M, json={"is_kid": True, "guardians": ["bran"]})
call("PUT", f"/api/admin/users/{aid}/news-writer", M, expect=400, json={"on": True})
r = requests.post(B + f"/api/guilds/{gid}/news", headers=H(A), json={"title": "kid news"})
assert r.status_code == 403 and "kid" in r.text, r.text
assert call("GET", "/api/news?scope=instance", A), "kids can read instance news"
call("DELETE", f"/api/news/{n2['id']}", M)
print("kids: read news, can't post it or be news writers")
print("news test passed")
