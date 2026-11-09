# Show (recording): start, consent, roles, director state, chunked upload, access rules.
import requests, sys, json, time
from websocket import create_connection
B = sys.argv[1]

def call(method, path, tok=None, expect=200, **kw):
    h = {"Authorization": "Bearer " + tok} if tok else {}
    h.update(kw.pop("headers", {}))
    r = requests.request(method, B + path, headers=h, **kw)
    if r.status_code != expect:
        raise SystemExit(f"FAIL {method} {path}: wanted {expect}, got {r.status_code} {r.text[:300]}")
    return r.json() if r.headers.get("content-type", "").startswith("application/json") else r

s = call("POST", "/api/setup", json={"username": "bran", "password": "master-pass1", "server_name": "Shows"})
M, gid = s["token"], s["guild_id"]
call("PUT", "/api/admin/settings", M, json={"lan_ip": "127.0.0.1"})
inv = call("POST", f"/api/guilds/{gid}/invites", M, json={"max_uses": 9})["code"]
reg = lambda u: call("POST", "/api/auth/register", json={"invite": inv, "username": u, "password": u + "-pass12"})
mom, guest, other = reg("mom"), reg("guest"), reg("outsider")
MOM, G, O = mom["token"], guest["token"], other["token"]
kid = call("POST", "/api/kids", MOM, json={"username": "junior", "password": "kid-pass12"})
call("POST", f"/api/kids/{kid['user']['id']}/guilds", MOM, json={"guild_id": gid})
K = call("POST", "/api/auth/login", json={"username": "junior", "password": "kid-pass12"})["token"]
ws = create_connection(B.replace("http", "ws") + "/api/gateway?access_token=" + M); ready = json.loads(ws.recv())["d"]; ws.close()
vc = [c for g in ready["guilds"] for c in g["channels"] if c["kind"] == "voice"][0]["id"]
tc = [c for g in ready["guilds"] for c in g["channels"] if c["kind"] == "text"][0]["id"]
assert ready["shows"] == []
for t in (M, MOM, G, K):
    call("POST", f"/api/channels/{vc}/voice", t)   # everyone joins the call

# saving to the server: off by default
call("POST", f"/api/channels/{vc}/shows", M, expect=400, json={"people": [{"user_id": s["user"]["id"], "voice": True}], "record_on": "server"})

# mom starts a show: herself, junior (her kid -> covered), guest (asked); bran records, guest directs
sh = call("POST", f"/api/channels/{vc}/shows", MOM, json={
    "title": "Friday Night", "recorder_id": s["user"]["id"], "director_id": guest["user"]["id"],
    "people": [{"user_id": mom["user"]["id"], "voice": True, "camera": True},
               {"user_id": kid["user"]["id"], "voice": True, "camera": True},
               {"user_id": guest["user"]["id"], "voice": True, "camera": True, "screen": True}]})
sid = sh["id"]
ppl = {p["user_id"]: p for p in sh["people"]}
assert ppl[mom["user"]["id"]]["consent"]["camera"] and ppl[kid["user"]["id"]]["consent"]["voice"], "starter and her kid are covered"
assert ppl[guest["user"]["id"]]["consent"] is None, "guest has to answer"
assert not sh["recorder_ok"] and not sh["director_ok"]
call("POST", f"/api/channels/{vc}/shows", M, expect=409, json={"people": [{"user_id": s["user"]["id"], "voice": True}]})
print("show set up: mom and her kid covered, guest asked, bran asked to record, guest asked to direct")

call("POST", f"/api/shows/{sid}/start", MOM, expect=400)              # recorder hasn't accepted
call("POST", f"/api/shows/{sid}/role", M, json={"accept": True})     # bran records
call("POST", f"/api/shows/{sid}/role", G, json={"accept": True})     # guest directs
# guest only allows voice + screen, not camera; asking for more than requested gets trimmed
c = call("POST", f"/api/shows/{sid}/consent", G, json={"voice": True, "camera": False, "screen": True})
g = [p for p in c["people"] if p["user_id"] == guest["user"]["id"]][0]["consent"]
assert g == {"voice": True, "camera": False, "screen": True}, g
call("POST", f"/api/shows/{sid}/consent", O, expect=403, json={"voice": True})  # not in the call
call("POST", f"/api/shows/{sid}/start", M)
print("recorder + director accepted, guest said voice+screen only, recording started")

# director controls: only the director (or starter)
call("POST", f"/api/shows/{sid}/state", K, expect=403, json={"hold": True})
st = call("POST", f"/api/shows/{sid}/state", G, json={"focus": mom["user"]["id"], "hold": True, "layout": "speaker", "lower_third": "Mom", "junk": 1})
assert st["state"] == {"focus": mom["user"]["id"], "hold": True, "layout": "speaker", "lower_third": "Mom"}, st["state"]
call("POST", f"/api/shows/{sid}/director", G, json={"director_id": mom["user"]["id"]})   # hand off
call("POST", f"/api/shows/{sid}/state", G, expect=403, json={"hold": False})
call("POST", f"/api/shows/{sid}/state", MOM, json={"hold": False})
print("director: holds a shot, hands controls to mom")

# guest changes their mind mid-show
c = call("POST", f"/api/shows/{sid}/consent", G, json={"voice": False, "camera": False, "screen": False})
assert [p for p in c["people"] if p["user_id"] == guest["user"]["id"]][0]["consent"] == {"voice": False, "camera": False, "screen": False}

# REC shows up for anyone connecting
ws = create_connection(B.replace("http", "ws") + "/api/gateway?access_token=" + O); r2 = json.loads(ws.recv())["d"]; ws.close()
assert r2["shows"] and r2["shows"][0]["status"] == "recording"

# kept on the recorder's device: nothing can be uploaded while it records
call("POST", f"/api/shows/{sid}/chunk", M, expect=400, data=b"x", headers={"x-seq": "0"})
call("POST", f"/api/shows/{sid}/stop", O, expect=403)
call("POST", f"/api/shows/{sid}/stop", MOM)
call("POST", f"/api/shows/{sid}/local-size", G, expect=403, json={"size": 5})
call("POST", f"/api/shows/{sid}/local-size", M, json={"size": 1604})
lst = call("GET", f"/api/channels/{vc}/shows", K)
r0 = lst["recordings"][0]
assert lst["live"] is None and r0["on_server"] is False and r0["video_url"] is None and r0["size"] == 1604, r0
call("GET", f"/api/shows/{sid}/video", K, expect=404)
mine = call("GET", "/api/shows", MOM)
assert len(mine) == 1 and mine[0]["on_server"] is False and mine[0]["record_on"] == "member", mine
assert call("GET", "/api/shows", O) == []
print("recorded on bran's device: the server only knows it exists (no video), others see it in their list")

# sharing uploads it: only the recorder's device can, in order, retry-safe, checked at the end
call("POST", f"/api/shows/{sid}/publish", MOM, expect=400, json={"channel_id": tc})   # not uploaded yet
call("POST", f"/api/shows/{sid}/upload/begin", G, expect=403)
call("POST", f"/api/shows/{sid}/upload/begin", M)
call("POST", f"/api/shows/{sid}/chunk", G, expect=403, data=b"x", headers={"x-seq": "0"})
call("POST", f"/api/shows/{sid}/chunk", M, data=b"\x1aE\xdf\xa3" + b"A" * 1000, headers={"x-seq": "0"})
assert call("POST", f"/api/shows/{sid}/chunk", M, data=b"dup", headers={"x-seq": "0"})["duplicate"]
call("POST", f"/api/shows/{sid}/chunk", M, expect=409, data=b"B", headers={"x-seq": "2"})
call("POST", f"/api/shows/{sid}/chunk", M, data=b"B" * 500, headers={"x-seq": "1"})
call("POST", f"/api/shows/{sid}/upload/done", M, expect=400, json={"size": 1604})   # a piece is missing
call("POST", f"/api/shows/{sid}/chunk", M, data=b"C" * 100, headers={"x-seq": "2"})
done = call("POST", f"/api/shows/{sid}/upload/done", M, json={"size": 1604})
assert done["on_server"] is True and done["video_url"], done
print("shared from the device: uploaded in pieces (retry-safe, checked complete)")

# who can watch: people in it, crew, parents, admins; not others (yet)
url = f"/api/shows/{sid}/video"
v = call("GET", url + "?access_token=" + K)
assert v.content.startswith(b"\x1aE\xdf\xa3") and len(v.content) == 1604
part = requests.get(B + url, headers={"Authorization": "Bearer " + MOM, "Range": "bytes=0-3"})
assert part.status_code == 206 and part.content == b"\x1aE\xdf\xa3"
call("GET", url, O, expect=404)
assert call("GET", f"/api/channels/{vc}/shows", O)["recordings"] == []
print("recording plays for the kid, mom (range requests work); hidden from others")

# Publish as a Show: a post in a text channel; everyone who can see it can watch
call("POST", f"/api/shows/{sid}/publish", O, expect=403, json={"channel_id": tc})
post = call("POST", f"/api/shows/{sid}/publish", MOM, json={"channel_id": tc, "style": "show", "comment": "our first one"})
e = post["embeds"][0]
assert e["type"] == "show" and e["style"] == "show" and e["show_id"] == sid and e["title"] == "Friday Night", e
assert guest["user"]["id"] not in e["people"] and mom["user"]["id"] in e["people"], "guest took everything back"
assert "Friday Night" in post["content"] and "our first one" in post["content"]
call("GET", url, O)
print("published as a Show: the outsider in that channel can watch it now")
call("PATCH", f"/api/messages/{post['id']}", MOM, json={"content": "edited"})
msgs = call("GET", f"/api/channels/{tc}/messages?limit=5", O)
assert any(m["id"] == post["id"] and m["embeds"] and m["embeds"][0]["type"] == "show" for m in msgs), "editing keeps the player"
vid = call("POST", f"/api/shows/{sid}/publish", MOM, json={"channel_id": tc, "style": "video"})
assert vid["embeds"][0]["style"] == "video"
print("editing a Show post keeps it; Post the video works too")

# saving to the server as it records: an instance option, off by default
call("PUT", "/api/admin/settings", M, json={"allow_server_recording": True})
s2 = call("POST", f"/api/channels/{vc}/shows", M, json={"people": [{"user_id": s["user"]["id"], "voice": True}], "record_on": "server"})
assert s2["record_on"] == "server"
call("POST", f"/api/shows/{s2['id']}/start", M)
call("POST", f"/api/shows/{s2['id']}/chunk", M, data=b"\x1aE\xdf\xa3" + b"Z" * 10, headers={"x-seq": "0"})
call("POST", f"/api/shows/{s2['id']}/stop", M)
assert call("GET", f"/api/shows/{s2['id']}/video", M).content.endswith(b"Z" * 10)
call("DELETE", f"/api/shows/{s2['id']}", M)
call("PUT", "/api/admin/settings", M, json={"allow_server_recording": False})
print("with the option on, a show can be saved to the server as it records")

call("DELETE", f"/api/shows/{sid}", G, expect=403)
call("DELETE", f"/api/shows/{sid}", MOM)
assert call("GET", "/api/shows", MOM) == []
msgs = call("GET", f"/api/channels/{tc}/messages?limit=5", O)
assert not any(m["id"] in (post["id"], vid["id"]) for m in msgs), "deleting it removes its posts"
print("starter deleted it, and its posts went with it")
print("ALL SHOWS OK")
