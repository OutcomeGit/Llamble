import requests, time, sys
B=sys.argv[1]
def ok(r):
    if r.status_code>=300: raise SystemExit(f"FAIL {r.request.method} {r.url} {r.status_code} {r.text}")
    return r.json()
assert ok(requests.get(B+"/api/info"))["setup_required"] is True
r=requests.post(B+"/api/setup",json={"username":"x","password":"short"}); assert r.status_code==400
s=ok(requests.post(B+"/api/setup",json={"username":"bran","password":"hunter2hunter2","display_name":"Bran","server_name":"Bran's Clients"}))
T={"Authorization":"Bearer "+s["token"]}; assert s["user"]["is_admin"] and s["guild_id"]
assert requests.post(B+"/api/setup",json={"username":"evil","password":"hunter2hunter2"}).status_code==409, "setup must lock after first admin"
assert ok(requests.get(B+"/api/info"))["setup_required"] is False
st=ok(requests.get(B+"/api/admin/ai",headers=T)); assert st["status"]["state"]=="none" and len(st["catalog"])>=5; print("system:", st["system"])
q=ok(requests.get(B+"/api/admin/ai/quants?repo=https://huggingface.co/tiny/Test-GGUF",headers=T))
names=[x["quant"] for x in q["quants"]]; assert names==["Q8_0","Q4_K_M"], names   # mmproj/readme excluded, sorted by size
assert requests.get(B+"/api/admin/ai/quants?repo=nope/missing",headers=T).status_code==400
ok(requests.post(B+"/api/admin/ai",headers=T,json={"repo":"tiny/Test-GGUF","quant":"q4_k_m","ctx":4096}))
seen=set()
for _ in range(60):
    st=ok(requests.get(B+"/api/admin/ai",headers=T))["status"]; seen.add(st["state"])
    if st["state"] in ("ready","error"): break
    time.sleep(0.5)
assert st["state"]=="ready", st; assert st["downloaded_bytes"]==st["total_bytes"]>3_000_000; print("states seen:", sorted(seen))
# bot uses the built-in model
text=[c for c in ok(requests.get(B+"/api/channels/x/messages",headers=T)) ] if False else None
g=requests.get(B+"/api/bot",headers=T).json(); assert g["server_backend"], g
from websocket import create_connection
import json
ws=create_connection(B.replace("http","ws")+"/api/gateway?access_token="+s["token"]); ready=json.loads(ws.recv())["d"]; ws.close()
gd=[x for x in ready["guilds"] if x["guild"]["id"]==s["guild_id"]][0]
cid=[c for c in gd["channels"] if c["kind"]=="text"][0]["id"]
ok(requests.post(B+f"/api/channels/{cid}/messages",headers=T,json={"content":"llamble, hello?"}))
for _ in range(30):
    time.sleep(0.4); last=ok(requests.get(B+f"/api/channels/{cid}/messages?limit=1",headers=T))[0]
    if last["author"]["is_bot"] and last["content"].endswith("."): break
assert last["content"]=="Built-in model says hi.", last["content"]; print("bot answered from built-in model")
def ask(text, want_end, tries=60):
    ok(requests.post(B+f"/api/channels/{cid}/messages",headers=T,json={"content":text}))
    for _ in range(tries):
        time.sleep(0.5); m=ok(requests.get(B+f"/api/channels/{cid}/messages?limit=1",headers=T))[0]
        if m["author"]["is_bot"] and m["content"].endswith(want_end): return m["content"]
    return m["content"]
# a restart reloads the model: a question asked meanwhile waits for it instead of failing
ok(requests.post(B+"/api/admin/ai",headers=T,json={"repo":"tiny/Test-GGUF","quant":"q4_k_m","ctx":4096})); time.sleep(0.3)
assert ok(requests.get(B+"/api/admin/ai",headers=T))["status"]["state"]!="ready"
got=ask("llamble, still there?", "says hi.")
assert got=="Built-in model says hi.", got; print("question asked while the model was loading got answered")
# disable
ok(requests.delete(B+"/api/admin/ai",headers=T))
got=ask("llamble, hello again?", ".*")
assert "no AI model is set up" in got, got; print("no model ->", got); assert ok(requests.get(B+"/api/admin/ai",headers=T))["status"]["state"]=="none"
print("ALL SETUP OK")
