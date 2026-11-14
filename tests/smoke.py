import requests, json, io, sys, threading, time, jwt
from PIL import Image
import websocket
B = sys.argv[1]; INV = sys.argv[2]
def ok(r):
    if r.status_code >= 300: raise SystemExit(f"FAIL {r.request.method} {r.url} {r.status_code} {r.text}")
    return r.json()
a = ok(requests.post(B+"/api/auth/register", json={"invite":INV,"username":"bran","password":"hunter2hunter2","display_name":"Bran"}))
T={"Authorization":"Bearer "+a["token"]}; assert a["user"]["is_admin"]
r = requests.post(B+"/api/auth/register", json={"invite":INV,"username":"x2","password":"hunter2hunter2"}); assert r.status_code==400, "bootstrap invite reuse"
g = ok(requests.post(B+"/api/guilds", headers=T, json={"name":"Clients"}))
gid=g["guild"]["id"]; text=[c for c in g["channels"] if c["kind"]=="text"][0]["id"]; voice=[c for c in g["channels"] if c["kind"]=="voice"][0]["id"]
inv = ok(requests.post(B+f"/api/guilds/{gid}/invites", headers=T, json={"max_uses":5}))
print("invite preview", ok(requests.get(B+f"/api/invites/{inv['code']}")))
b = ok(requests.post(B+"/api/auth/register", json={"invite":inv["code"],"username":"client1","password":"password123"}))
T2={"Authorization":"Bearer "+b["token"]}
# gateway for user2
events=[]
ws = websocket.create_connection(B.replace("http","ws")+"/api/gateway?access_token="+b["token"])
ready=json.loads(ws.recv()); assert ready["t"]=="READY"; assert len(ready["d"]["guilds"])==1, ready
def reader():
    while True:
        try: events.append(json.loads(ws.recv()))
        except Exception: break
threading.Thread(target=reader,daemon=True).start()
# upload image
img=Image.new("RGB",(1600,900),(200,30,30)); bio=io.BytesIO(); img.save(bio,"PNG"); bio.seek(0)
f = ok(requests.post(B+"/api/files", headers=T, files={"file":("red.png",bio,"image/png")}))
assert f["width"]==1600 and f["thumb_url"], f
m = ok(requests.post(B+f"/api/channels/{text}/messages", headers=T, json={"content":"hello **world** https://example.com","attachments":[{"id":f["id"]}],"nonce":"n1"}))
assert m["attachments"][0]["id"]==f["id"]
# user2 can view attachment, thumb
assert requests.get(B+f["url"], headers=T2).status_code==200
r=requests.get(B+f["url"], headers={**T2,"Range":"bytes=0-9"}); assert r.status_code==206 and len(r.content)==10, r.status_code
assert requests.get(B+f["thumb_url"]+"?access_token="+b["token"]).status_code==200
# a video gets a real thumbnail, even a clip shorter than the half-second the poster is taken at
import subprocess, tempfile, os
if subprocess.run(["which","ffmpeg"],capture_output=True).returncode==0:
    for secs in ("3","0.3"):
        vp=os.path.join(tempfile.mkdtemp(),"clip.webm")
        subprocess.run(["ffmpeg","-hide_banner","-loglevel","error","-f","lavfi","-i","testsrc=size=640x360:rate=30","-t",secs,"-c:v","libvpx","-f","webm",vp],check=True)
        with open(vp,"rb") as fh:
            v = ok(requests.post(B+"/api/files", headers=T, files={"file":("clip.webm",fh,"video/webm")}))
        assert v["thumb_url"], ("no thumbnail for a %ss video" % secs, v)
        tr = requests.get(B+v["thumb_url"]+"?access_token="+a["token"])  # the uploader
        assert tr.status_code==200 and tr.content[:2]==b"\xff\xd8", ("the %ss video's thumbnail isn't a picture" % secs, tr.status_code)
    print("videos get real thumbnails (3 s and 0.3 s clips)")
# user2 cannot attach admin's file
r=requests.post(B+f"/api/channels/{text}/messages", headers=T2, json={"content":"x","attachments":[{"id":f["id"]}]}); assert r.status_code==400
reply = ok(requests.post(B+f"/api/channels/{text}/messages", headers=T2, json={"content":"hi back","reply_to":m["id"]}))
assert reply["reply_to"]["id"]==m["id"]
ok(requests.put(B+f"/api/messages/{m['id']}/reactions/%F0%9F%91%8D", headers=T2))
e = ok(requests.patch(B+f"/api/messages/{reply['id']}", headers=T2, json={"content":"hi back (edited)"})); assert e["edited_at"]
r=requests.patch(B+f"/api/messages/{m['id']}", headers=T2, json={"content":"hack"}); assert r.status_code==403
msgs = ok(requests.get(B+f"/api/channels/{text}/messages?limit=10", headers=T2)); assert len(msgs)==2 and msgs[1]["reactions"][0]["users"]==[b["user"]["id"]]
assert len(ok(requests.get(B+f"/api/channels/{text}/search?q=back", headers=T2)))==1
# gif library
gif=Image.new("P",(64,64)); bio=io.BytesIO(); gif.save(bio,"GIF"); bio.seek(0)
gf = ok(requests.post(B+"/api/files", headers=T, files={"file":("dance.gif",bio,"image/gif")}))
assert gf["mime"]=="image/gif"
ok(requests.post(B+"/api/gifs", headers=T, json={"file_id":gf["id"],"title":"Dance party","tags":"dance, happy"}))
res = ok(requests.get(B+"/api/gifs?q=dance", headers=T2)); assert len(res)==1
ok(requests.post(B+f"/api/channels/{text}/messages", headers=T2, json={"attachments":[{"id":res[0]["file"]["id"]}]}))
# voice
v = ok(requests.post(B+f"/api/channels/{voice}/voice", headers=T2))
claims = jwt.decode(v["token"], "devsecretdevsecretdevsecretdevsecret", algorithms=["HS256"])
assert claims["video"]["room"]==voice and "microphone" in claims["video"]["canPublishSources"]
ok(requests.patch(B+"/api/voice/state", headers=T2, json={"muted":True}))
# DM
dm = ok(requests.post(B+"/api/users/@me/channels", headers=T2, json={"recipient_id":a["user"]["id"]}))
ok(requests.post(B+f"/api/channels/{dm['id']}/messages", headers=T2, json={"content":"private"}))
# roles / perms: strip SEND from everyone
ok(requests.patch(B+f"/api/guilds/{gid}/roles/{gid}", headers=T, json={"permissions":1}))
r=requests.post(B+f"/api/channels/{text}/messages", headers=T2, json={"content":"blocked"}); assert r.status_code==403
role = ok(requests.post(B+f"/api/guilds/{gid}/roles", headers=T, json={"name":"Client","permissions":3,"color":0x5865F2}))
ok(requests.put(B+f"/api/guilds/{gid}/members/{b['user']['id']}/roles/{role['id']}", headers=T))
ok(requests.post(B+f"/api/channels/{text}/messages", headers=T2, json={"content":"allowed via role"}))
# files of other channels not visible to outsiders
time.sleep(1.0)
ws.close()
kinds=[e["t"] for e in events]
print("events:", sorted(set(kinds)))
for need in ["MESSAGE_CREATE","MESSAGE_UPDATE","REACTION_ADD","VOICE_STATE_UPDATE","CHANNEL_CREATE","ROLE_UPDATE","GUILD_MEMBER_UPDATE"]:
    assert need in kinds, need
# login
ok(requests.post(B+"/api/auth/login", json={"username":"CLIENT1","password":"password123"}))
assert requests.post(B+"/api/auth/login", json={"username":"client1","password":"nope"}).status_code==401
print("ALL OK")
