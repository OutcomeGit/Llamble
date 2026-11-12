# Friends and parties.
import sys, requests
B = sys.argv[1]
H = lambda t: {"Authorization": "Bearer " + t}
def call(method, path, tok, expect=200, **kw):
    r = requests.request(method, B + path, headers=H(tok), **kw)
    assert r.status_code == expect, (method, path, r.status_code, r.text[:300])
    return r.json() if r.text else None
s = requests.post(B + "/api/setup", json={"username": "bran", "password": "master-pass1", "server_name": "Family"}).json()
A, gid = s["token"], s["guild_id"]
def join(gid, name):
    inv = call("POST", f"/api/guilds/{gid}/invites", A, json={"max_uses": 5})["code"]
    r = requests.post(B + "/api/auth/register", json={"invite": inv, "username": name, "password": "pass-word-123"}).json()
    return r["token"], call("GET", "/api/users/@me", r["token"])["id"]
Bt, b_id = join(gid, "jake")
Dt, d_id = join(gid, "dee")
# sam is only in another server (shares nothing with jake)
g2 = call("POST", "/api/guilds", A, json={"name": "Elsewhere"})
Ct, c_id = join((g2.get("guild") or g2)["id"], "sam")
a_id = call("GET", "/api/users/@me", A)["id"]

# friends: ask by username, accept; not someone who doesn't exist, not yourself
call("POST", "/api/friends", Bt, expect=400, json={"username": "nobody-here"})
call("POST", "/api/friends", Bt, expect=400, json={"username": "jake"})
call("POST", f"/api/users/@me/channels", Bt, expect=403, json={"recipient_id": c_id})  # no shared server yet
r = call("POST", "/api/friends", Bt, json={"username": "@Sam"})
assert r["state"] == "outgoing" and r["user"]["id"] == c_id, r
inc = call("GET", "/api/friends", Ct)
assert [(f["user"]["id"], f["state"]) for f in inc] == [(b_id, "incoming")], inc
call("PUT", f"/api/friends/{b_id}", Bt, expect=400)  # can't accept your own request
f = call("PUT", f"/api/friends/{b_id}", Ct)
assert f["state"] == "friend", f
assert call("GET", "/api/friends", Bt)[0]["state"] == "friend"
dm = call("POST", "/api/users/@me/channels", Bt, json={"recipient_id": c_id})
assert call("PATCH", f"/api/friends/{c_id}", Bt, json={"note": "plays Tuesdays"})["note"] == "plays Tuesdays"
assert call("GET", "/api/friends", Ct)[0]["note"] == ""  # notes are private
assert "mutual_guilds" in call("GET", f"/api/friends/{c_id}", Bt)
call("GET", f"/api/friends/{d_id}", Bt, expect=404)
pr = call("PATCH", "/api/users/@me/profile", Bt, json={"bio": "  hi, I build things  ", "banner": "sky"})
assert pr["bio"] == "hi, I build things" and pr["banner"] == "sky"
assert call("GET", f"/api/users/{pr['user']['id']}/profile", Ct)["bio"] == "hi, I build things"
call("PATCH", "/api/users/@me/profile", Bt, expect=400, json={"banner": "url(x)"})
print("profiles: about me and banner")
call("PATCH", f"/api/friends/{d_id}", Bt, expect=404, json={"note": "not a friend"})
print("friends: request by username, accept; friends can DM without sharing a server")

# parties
call("POST", "/api/parties", Bt, expect=400, json={"name": "  ", "user_ids": []})
call("POST", "/api/parties", Dt, expect=403, json={"name": "nope", "user_ids": [c_id]})  # dee doesn't know sam
p = call("POST", "/api/parties", Bt, json={"name": "Raid crew", "user_ids": [c_id, d_id]})
pid = p["id"]
assert p["kind"] == "party" and p["name"] == "Raid crew" and p["owner_id"] == b_id and len(p["recipients"]) == 3, p
call("POST", f"/api/channels/{pid}/messages", Ct, json={"content": "gg tonight?"})
msgs = call("GET", f"/api/channels/{pid}/messages?limit=5", Dt)
assert msgs[0]["content"] == "gg tonight?"
call("GET", f"/api/channels/{pid}/messages?limit=5", A, expect=404)  # private until the roles work adds logged staff access
outsider_t, _ = join(gid, "outsider")
call("GET", f"/api/channels/{pid}/messages?limit=5", outsider_t, expect=404)
call("POST", f"/api/channels/{pid}/messages", outsider_t, expect=404, json={"content": "hi"})
print("party: chat works for its members only")

call("PATCH", f"/api/parties/{pid}", Ct, expect=403, json={"name": "mine now"})
assert call("PATCH", f"/api/parties/{pid}", Bt, json={"name": "Raid crew 2"})["name"] == "Raid crew 2"
call("PUT", f"/api/parties/{pid}/members/{a_id}", Dt)  # anyone in it can add people they know
call("DELETE", f"/api/parties/{pid}/members/{d_id}", Ct, expect=403)  # only the maker removes others
call("DELETE", f"/api/parties/{pid}/members/{a_id}", Bt)
call("DELETE", f"/api/parties/{pid}/members/{d_id}", Dt)  # leave
p = call("DELETE", f"/api/parties/{pid}/members/{b_id}", Bt)  # the maker leaves: sam takes over
assert p["owner_id"] == c_id and [r["id"] for r in p["recipients"]] == [c_id], p
call("DELETE", f"/api/parties/{pid}", Bt, expect=404)
assert call("DELETE", f"/api/parties/{pid}", Ct)["deleted"]
call("GET", f"/api/channels/{pid}/messages", Ct, expect=404)
print("party: rename (maker only), add, remove, leave, hand-over, delete")

# unfriending: no new DMs without a shared server
call("DELETE", f"/api/friends/{c_id}", Bt)
assert call("GET", "/api/friends", Ct) == []
call("POST", f"/api/users/@me/channels", Bt, expect=403, json={"recipient_id": c_id})
print("ALL SOCIAL OK")
