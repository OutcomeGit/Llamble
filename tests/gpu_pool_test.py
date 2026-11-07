# Two lenders (24 GB + 8 GB): best GPU wins, idle/gaming pause hands off, logout falls back, admin switch works
import requests, json, sys, time, threading
from websocket import create_connection
B=sys.argv[1]
def ok(r):
    if r.status_code>=300: raise SystemExit(f"FAIL {r.request.method} {r.url} {r.status_code} {r.text}")
    return r.json()
a=ok(requests.post(B+"/api/setup",json={"username":"bran","password":"hunter2hunter2","server_name":"G"})); TA={"Authorization":"Bearer "+a["token"]}
gid=a["guild_id"]
inv=ok(requests.post(B+f"/api/guilds/{gid}/invites",headers=TA,json={}))
m=ok(requests.post(B+"/api/auth/register",json={"invite":inv["code"],"username":"dana","password":"password123"})); TM={"Authorization":"Bearer "+m["token"]}

class Lender:
    def __init__(s, token, name, vram, reply):
        s.ws=create_connection(B.replace("http","ws")+"/api/gateway?access_token="+token)
        s.ready=json.loads(s.ws.recv())["d"]; s.events=[]; s.name=name; s.reply=reply; s.vram=vram
        threading.Thread(target=s.loop,daemon=True).start()
    def loop(s):
        while True:
            try: e=json.loads(s.ws.recv())
            except Exception: return
            s.events.append(e["t"])
            if e["t"]=="BOT_JOB":
                j=e["d"]["job_id"]; s.ws.send(json.dumps({"op":"job_chunk","job_id":j,"text":s.reply})); s.ws.send(json.dumps({"op":"job_done","job_id":j}))
    def register(s, available=True, reason=""):
        s.ws.send(json.dumps({"op":"worker_register","gpu":s.name,"vram_mb":s.vram,"model":"m","available":available,"reason":reason})); time.sleep(0.4)
    def status(s, available, reason=""):
        s.ws.send(json.dumps({"op":"worker_status","available":available,"reason":reason})); time.sleep(0.3)

cid=[c for c in [x for x in Lender(a["token"],"probe",0,"").ready["guilds"] if x["guild"]["id"]==gid][0]["channels"] if c["kind"]=="text"][0]["id"]
def ask(q):
    prev=ok(requests.get(B+f"/api/channels/{cid}/messages?limit=1",headers=TA)); before=prev[0]["id"] if prev else ""
    ok(requests.post(B+f"/api/channels/{cid}/messages",headers=TA,json={"content":"llamble, "+q}))
    for _ in range(40):
        time.sleep(0.25); l=ok(requests.get(B+f"/api/channels/{cid}/messages?limit=1",headers=TA))[0]
        if l["author"]["is_bot"] and l["id"]>before and (l["content"].endswith(".") or l["content"].endswith("!")): return l["content"]
    raise SystemExit("no bot reply")

dana=Lender(m["token"],"RTX 4090",24564,"Answered by the 4090.")
dana.register(); assert "WORKER_REJECTED" in dana.events, "default policy should be admins-only"
ok(requests.patch(B+"/api/admin/gpu",headers=TA,json={"policy":"members"}))
bran=Lender(a["token"],"RTX 3060",8192,"Answered by the 3060.")
bran.register(); dana.register()
pool=ok(requests.get(B+"/api/admin/gpu",headers=TA)); assert pool["workers"][0]["gpu"]=="RTX 4090" and pool["workers"][0]["in_use"], pool
assert ask("q1")=="Answered by the 4090."; print("best GPU (4090) chosen")
dana.status(False,"gaming (GPU busy)")
assert ask("q2")=="Answered by the 3060."; print("4090 owner gaming -> switched to 3060")
dana.status(True)
assert ask("q3")=="Answered by the 4090."; print("4090 idle again -> back to 4090")
dana.ws.close(); time.sleep(0.5)
assert ask("q4")=="Answered by the 3060."; print("4090 logged out -> 3060")
bran.status(False,"in use")
assert ask("q5")=="Hello from the server!"; print("no idle GPUs -> server model")
bran.status(True)
ok(requests.patch(B+"/api/admin/gpu",headers=TA,json={"policy":"off"})); time.sleep(0.3)
assert "WORKER_REJECTED" in bran.events and not ok(requests.get(B+"/api/admin/gpu",headers=TA))["workers"]
assert ask("q6")=="Hello from the server!"; print("admin turned sharing off -> server only")
print("ALL GPU POOL OK")
