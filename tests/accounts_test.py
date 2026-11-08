# Account levels, kid accounts & parents, password recovery, role presets, clearing messages.
import requests, sys, time, json
from websocket import create_connection
B = sys.argv[1]

def call(method, path, tok=None, expect=200, **kw):
    h = {"Authorization": "Bearer " + tok} if tok else {}
    r = requests.request(method, B + path, headers=h, **kw)
    if r.status_code != expect:
        raise SystemExit(f"FAIL {method} {path}: wanted {expect}, got {r.status_code} {r.text[:300]}")
    return r.json() if r.text else {}

def login(u, pw):
    return call("POST", "/api/auth/login", json={"username": u, "password": pw})["token"]

def ready(tok):
    ws = create_connection(B.replace("http", "ws") + "/api/gateway?access_token=" + tok)
    d = json.loads(ws.recv())["d"]; ws.close(); return d

# ---- setup: Master Admin + recovery code
s = call("POST", "/api/setup", json={"username": "bran", "password": "master-pass1", "server_name": "Family"})
M, gid = s["token"], s["guild_id"]
assert s["user"]["instance_role"] == "master" and len(s["recovery_code"]) == 19, s
print("setup: bran is Master Admin; recovery code", s["recovery_code"])

# ---- role presets on new servers
roles = {r["name"]: r for r in ready(M)["guilds"][0]["roles"]}
assert {"Admin", "Supervisor", "Moderator", "Guest"} <= set(roles), roles.keys()
print("new server has Admin / Supervisor / Moderator / Guest roles")

# ---- people: mom (regular), helper (becomes instance admin)
inv = call("POST", f"/api/guilds/{gid}/invites", M, json={"max_uses": 10})["code"]
mom = call("POST", "/api/auth/register", json={"invite": inv, "username": "mom", "password": "mom-pass12"})
MOM, mom_id = mom["token"], mom["user"]["id"]
helper = call("POST", "/api/auth/register", json={"invite": inv, "username": "helper", "password": "helper-pass1"})
H, helper_id = helper["token"], helper["user"]["id"]
assert mom["recovery_code"], mom

# ---- levels: only the Master changes levels; instance admins can't touch NAS settings
call("POST", f"/api/admin/users/{helper_id}/role", MOM, expect=403, json={"role": "admin"})
call("POST", f"/api/admin/users/{helper_id}/role", M, json={"role": "admin"})
H = login("helper", "helper-pass1")
call("GET", "/api/admin/users", H)                                   # admin: yes
call("GET", "/api/admin/remote", H, expect=403)                      # NAS settings: Master only
call("GET", "/api/admin/settings", H, expect=403)
call("GET", "/api/admin/ai", H, expect=403)
call("GET", "/api/admin/remote", M)
master_id = s["user"]["id"]
call("POST", f"/api/admin/users/{master_id}/reset-password", H, expect=403)
call("DELETE", f"/api/admin/users/{master_id}", H, expect=403)
print("levels: Instance Admin manages accounts but not the NAS or the Master")

# ---- kid accounts made directly by a parent (mom isn't an admin)
kid = call("POST", "/api/kids", MOM, json={"username": "junior", "display_name": "Junior", "password": "kid-pass12"})
kid_id = kid["user"]["id"]
assert kid["user"]["is_kid"] and [g["id"] for g in kid["guardians"]] == [mom_id], kid
assert kid["settings"]["dm_mode"] == "approved" and kid["settings"]["kid_safe_bot"] and not kid["settings"]["can_delete"]
K = login("junior", "kid-pass12")
call("POST", f"/api/kids/{kid_id}/guardians", MOM, json={"user": "bran"})        # dad too
kids = call("GET", "/api/kids", M)
assert kids[0]["mine"] and len(kids[0]["guardians"]) == 2
call("GET", "/api/kids", K, expect=200)  # a kid just sees nothing
call("POST", "/api/kids", K, expect=403, json={"username": "x2", "password": "aaaaaaaa"})
print("mom made a kid account (no invite) and added dad as a second parent")

# parents put the kid in their server; others can't take the kid's settings
call("POST", f"/api/kids/{kid_id}/guilds", MOM, json={"guild_id": gid})
call("POST", f"/api/kids/{kid_id}/settings", H, json={"dm_mode": "anyone"})       # instance admin may
call("POST", f"/api/kids/{kid_id}/settings", MOM, json={"dm_mode": "approved"})
stranger = call("POST", "/api/auth/register", json={"invite": inv, "username": "stranger", "password": "strange-pass"})
S, stranger_id = stranger["token"], stranger["user"]["id"]
call("POST", f"/api/kids/{kid_id}/settings", S, expect=403, json={"dm_mode": "anyone"})

# ---- DMs: kid <-> stranger needs a parent's OK; parents always fine
r = requests.post(B + "/api/users/@me/channels", headers={"Authorization": "Bearer " + S}, json={"recipient_id": kid_id})
assert r.status_code == 403 and "parent" in r.json()["error"], r.text
reqs = call("GET", "/api/kids", MOM)[0]["requests"]
assert len(reqs) == 1 and reqs[0]["kind"] == "dm" and reqs[0]["target"]["username"] == "stranger", reqs
dm_mom = call("POST", "/api/users/@me/channels", MOM, json={"recipient_id": kid_id})
call("POST", f"/api/channels/{dm_mom['id']}/messages", K, json={"content": "hi mom"})
call("POST", f"/api/kid-requests/{reqs[0]['id']}", MOM, json={"approve": True})
dm = call("POST", "/api/users/@me/channels", S, json={"recipient_id": kid_id})
call("POST", f"/api/channels/{dm['id']}/messages", S, json={"content": "hey junior"})
call("POST", f"/api/kids/{kid_id}/contacts", MOM, expect=200, json={"user": "stranger"})
call("DELETE", f"/api/kids/{kid_id}/contacts/{stranger_id}", MOM)
r = requests.post(B + f"/api/channels/{dm['id']}/messages", headers={"Authorization": "Bearer " + K}, json={"content": "still there?"})
assert r.status_code == 403, r.text   # contact removed: blocked again
print("DMs: stranger needed approval; parents always allowed; removing the contact blocks it again")

# ---- parents read everything (read-only), others can't
call("GET", f"/api/channels/{dm['id']}/messages", MOM)
msgs = call("GET", f"/api/channels/{dm['id']}/messages", M)
assert any(m["content"] == "hey junior" for m in msgs)
call("GET", f"/api/channels/{dm['id']}/messages", H, expect=404)   # admin but not a parent
call("POST", f"/api/channels/{dm['id']}/messages", MOM, expect=404, json={"content": "x"})  # read-only
chans = call("GET", f"/api/kids/{kid_id}/channels", MOM)
assert chans["servers"][0]["guild"]["id"] == gid and len(chans["dms"]) == 2, chans
print("parents can read the kid's DMs and server channels; nobody else can")

# ---- kid can't delete (default), parent can allow it
mid = call("POST", f"/api/channels/{dm_mom['id']}/messages", K, json={"content": "oops"})["id"]
call("DELETE", f"/api/messages/{mid}", K, expect=403)
call("POST", f"/api/kids/{kid_id}/settings", MOM, json={"can_delete": True})
call("DELETE", f"/api/messages/{mid}", K)
print("kid deleting messages: off by default, a parent can allow it")

# ---- server joins need approval, except auto-approved owners
other = call("POST", "/api/guilds", M, json={"name": "Dad's Other Server"})  # owned by a parent -> auto
inv2 = call("POST", f"/api/guilds/{other['guild']['id']}/invites", M, json={})["code"]
assert not call("POST", f"/api/invites/{inv2}", K).get("pending")
call("POST", f"/api/admin/settings", M, expect=405) if False else None
call("PUT", "/api/admin/settings", M, json={"guild_create": "all"})
sg = call("POST", "/api/guilds", S, json={"name": "Stranger Town"})["guild"]["id"]
inv3 = call("POST", f"/api/guilds/{sg}/invites", S, json={})["code"]
assert call("POST", f"/api/invites/{inv3}", K)["pending"]
pend = [q for q in call("GET", "/api/kids", MOM)[0]["requests"] if q["kind"] == "join"]
assert pend and pend[0]["target"]["name"] == "Stranger Town"
call("POST", f"/api/kid-requests/{pend[0]['id']}", MOM, json={"approve": True})
assert sg in [g["id"] for g in call("GET", "/api/kids", MOM)[0]["guilds"]]
# parents outrank the owner: take the kid out of Stranger Town
call("DELETE", f"/api/kids/{kid_id}/guilds/{sg}", MOM)
assert sg not in [g["id"] for g in call("GET", "/api/kids", MOM)[0]["guilds"]]
print("server joins: parent's own server auto-approved, others need approval; parent can pull the kid out")

# ---- quiet hours
now = time.gmtime()
start = f"{now.tm_hour:02d}:00"; end = f"{(now.tm_hour + 2) % 24:02d}:00"
call("POST", f"/api/kids/{kid_id}/settings", MOM, json={"quiet": {"enabled": True, "start": start, "end": end, "days": [0,1,2,3,4,5,6], "utc_offset_min": 0}})
r = requests.post(B + f"/api/channels/{dm_mom['id']}/messages", headers={"Authorization": "Bearer " + K}, json={"content": "can i?"})
assert r.status_code == 400 and "quiet hours" in r.json()["error"], r.text
call("POST", f"/api/kids/{kid_id}/settings", MOM, json={"quiet": {"enabled": False}})
call("POST", f"/api/channels/{dm_mom['id']}/messages", K, json={"content": "now i can"})
print("quiet hours block chatting, and lift when turned off")

# ---- parent sets the kid's password
call("POST", f"/api/kids/{kid_id}/password", MOM, json={"password": "new-kid-pass"})
K = login("junior", "new-kid-pass")

# ---- converting an existing account into a kid (instance admin)
teen = call("POST", "/api/auth/register", json={"invite": inv, "username": "teen", "password": "teen-pass12"})
call("POST", f"/api/admin/users/{teen['user']['id']}/kid", H, expect=400, json={"is_kid": True})
call("POST", f"/api/admin/users/{teen['user']['id']}/kid", H, json={"is_kid": True, "guardians": ["mom"]})
assert len(call("GET", "/api/kids", MOM)) == 2
call("POST", f"/api/admin/users/{helper_id}/kid", M, expect=400, json={"is_kid": True, "guardians": ["mom"]})  # admins can't be kids
print("an existing account was turned into a kid linked to mom")

# ---- password recovery: code
r = requests.post(B + "/api/auth/recover", json={"username": "mom", "code": "AAAA-BBBB-CCCC-DDDD", "new_password": "whatever12"})
assert r.status_code == 401
rec = call("POST", "/api/auth/recover", json={"username": "mom", "code": mom["recovery_code"].lower(), "new_password": "mom-new-pass"})
assert rec["recovery_code"] != mom["recovery_code"]
r = requests.post(B + "/api/auth/recover", json={"username": "mom", "code": mom["recovery_code"], "new_password": "again12345"})
assert r.status_code == 401  # each code works once
MOM = login("mom", "mom-new-pass")
print("recovery code reset mom's password and was replaced with a new one")

# ---- password recovery: ask, admin/parent approves, the waiting screen sets the password
q = call("POST", "/api/auth/reset-request", json={"username": "junior"})
assert call("POST", f"/api/auth/reset-request/{q['id']}", json={"secret": q["secret"]})["status"] == "pending"
lst = call("GET", "/api/reset-requests", MOM)
assert lst and lst[0]["user"]["username"] == "junior"
assert call("GET", "/api/reset-requests", S) == []          # strangers can't approve
call("POST", f"/api/reset-requests/{q['id']}", S, expect=404 if False else 403, json={"approve": True})
call("POST", f"/api/reset-requests/{q['id']}", MOM, json={"approve": True})
assert call("POST", f"/api/auth/reset-request/{q['id']}", json={"secret": "wrong"})["status"] == "pending"
done = call("POST", f"/api/auth/reset-request/{q['id']}", json={"secret": q["secret"], "new_password": "kid-reset-1"})
assert done["status"] == "done" and done["token"]
login("junior", "kid-reset-1")
# the Master Admin can't be unlocked by other admins
q = call("POST", "/api/auth/reset-request", json={"username": "bran"})
assert call("GET", "/api/reset-requests", H) == []
# unknown usernames look the same as real ones
q2 = call("POST", "/api/auth/reset-request", json={"username": "nobody-here"})
assert q2["id"] and q2["secret"]
print("reset requests: parent approved junior's; the Master's can't be approved by others")

# ---- Master hands over the role
call("POST", "/api/admin/transfer-master", H, expect=403, json={"user_id": helper_id})
call("POST", "/api/admin/transfer-master", M, json={"user_id": helper_id})
H = login("helper", "helper-pass1"); M = login("bran", "master-pass1")
call("GET", "/api/admin/remote", H); call("GET", "/api/admin/remote", M, expect=403)
call("POST", "/api/admin/transfer-master", H, json={"user_id": master_id})
M = login("bran", "master-pass1")
print("Master role handed over and back")

# ---- password reset by email
import os, re as _re
if os.path.exists("/tmp/llamble_mail.txt"): os.remove("/tmp/llamble_mail.txt")
assert not requests.get(B + "/api/info").json()["email_reset"]
call("PUT", "/api/admin/smtp", H, expect=403, json={})
call("PUT", "/api/admin/smtp", M, expect=400, json={"host": "127.0.0.1", "from": "not an address"})
call("PUT", "/api/admin/smtp", M, json={"host": "127.0.0.1", "port": 8025, "security": "none", "username": "u", "password": "p", "from": "Llamble <noreply@example.com>"})
assert "password" not in call("GET", "/api/admin/smtp", M) and call("GET", "/api/admin/smtp", M)["has_password"]
assert requests.get(B + "/api/info").json()["email_reset"]
call("POST", "/api/admin/smtp/test", M, json={"to": "bran@example.com"})
call("PATCH", "/api/users/@me", MOM, expect=400, json={"email": "nope"})
call("PATCH", "/api/users/@me", MOM, json={"email": "mom@example.com"})
assert call("GET", "/api/me/email", MOM)["email"] == "mom@example.com"
call("POST", "/api/auth/reset-email", json={"username": "mom"})
call("POST", "/api/auth/reset-email", json={"username": "nobody-at-all"})   # same answer
for _ in range(40):
    mail = open("/tmp/llamble_mail.txt").read() if os.path.exists("/tmp/llamble_mail.txt") else ""
    if "reset=" in mail: break
    time.sleep(0.25)
assert "Llamble test email" in mail, mail[:300]
import quopri
mail = quopri.decodestring(mail.encode()).decode(errors="replace")  # mail clients decode this automatically
link = _re.search(r"reset=([0-9a-z]+)\.([A-Za-z0-9_-]+)", mail)
assert link and "mom@example.com" in mail, mail[-600:]
rid, sec = link.group(1), link.group(2)
done = call("POST", f"/api/auth/reset-request/{rid}", json={"secret": sec, "new_password": "mom-email-pass"})
assert done["status"] == "done", done
MOM = login("mom", "mom-email-pass")
assert call("POST", f"/api/auth/reset-request/{rid}", json={"secret": sec, "new_password": "again12345"})["status"] == "done"  # used up
print("email: test message sent, reset link emailed to mom and used once")

# ---- clearing messages
gen = [g for g in ready(M)["guilds"] if g["guild"]["id"] == gid][0]["channels"]
text = [c for c in gen if c["kind"] == "text"][0]["id"]
ids = [call("POST", f"/api/channels/{text}/messages", MOM, json={"content": f"m{i}"})["id"] for i in range(5)]
call("POST", f"/api/channels/{text}/messages/bulk-delete", S, expect=403, json={"ids": ids[:2]})   # not theirs
call("POST", f"/api/channels/{text}/messages/bulk-delete", MOM, json={"ids": ids[:2]})               # own
assert len(call("GET", f"/api/channels/{text}/messages", M)) == 3
call("POST", f"/api/channels/{text}/messages", S, json={"content": "spam"})
call("POST", f"/api/channels/{text}/messages", S, json={"content": "spam2"})
call("DELETE", f"/api/guilds/{gid}/members/{stranger_id}/messages", M)
assert all(m["author"]["id"] != stranger_id for m in call("GET", f"/api/channels/{text}/messages", M))
call("DELETE", f"/api/channels/{text}/messages/all", MOM, expect=403)
call("DELETE", f"/api/channels/{text}/messages/all", M)
assert call("GET", f"/api/channels/{text}/messages", M) == []
bot = call("POST", "/api/bot/dm", MOM)
call("DELETE", f"/api/channels/{dm_mom['id']}/messages/all", MOM, expect=403)   # not an AI chat
call("DELETE", f"/api/channels/{bot['id']}/messages/all", MOM)                  # own AI chat
call("PATCH", f"/api/channels/{text}", M, json={"retention_days": 7})
ch = [c for g in ready(M)["guilds"] if g["guild"]["id"] == gid for c in g["channels"] if c["id"] == text][0]
assert ch["retention_days"] == 7, ch
print("clearing: bulk delete, wipe a person's messages, clear channel, clear own AI chat, auto-delete set")

# ---- guest role takes posting away
guest = [g for g in ready(M)["guilds"] if g["guild"]["id"] == gid][0]["roles"]
gr = [r for r in guest if r["name"] == "Guest"][0]["id"]
call("PUT", f"/api/guilds/{gid}/members/{stranger_id}/roles/{gr}", M)
call("POST", f"/api/channels/{text}/messages", S, expect=403, json={"content": "can't"})
call("GET", f"/api/channels/{text}/messages", S)
print("Guest role: can read, can't post")
print("ALL ACCOUNTS OK")

# ---- server-wide voice/video limits reach every client
call("PUT", "/api/admin/settings", M, json={"max_share": "1080p30", "max_camera": "360p"})
call("PUT", "/api/admin/settings", M, expect=400, json={"max_share": "4k"})
assert ready(MOM)["config"]["media"] == {"max_share": "1080p30", "max_camera": "360p"}
print("voice/video limits set by the Master reach clients")
