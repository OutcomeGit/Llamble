import requests, json, sys, time, threading, websocket
B=sys.argv[1]; INV=sys.argv[2]
def ok(r):
    if r.status_code>=300: raise SystemExit(f"FAIL {r.url} {r.status_code} {r.text}")
    return r.json()
a=ok(requests.post(B+"/api/auth/register",json={"invite":INV,"username":"bran","password":"hunter2hunter2"})); T={"Authorization":"Bearer "+a["token"]}
g=ok(requests.post(B+"/api/guilds",headers=T,json={"name":"G"})); gid=g["guild"]["id"]; text=[c for c in g["channels"] if c["kind"]=="text"][0]["id"]
st=ok(requests.get(B+"/api/bot",headers=T)); bot=st["bot_user_id"]; assert st["server_backend"]
ok(requests.patch(B+f"/api/guilds/{gid}/bot",headers=T,json={"enabled":True,"system_prompt":"Talk like a pirate."}))
def last(): return ok(requests.get(B+f"/api/channels/{text}/messages?limit=1",headers=T))[0]
ok(requests.post(B+f"/api/channels/{text}/messages",headers=T,json={"content":"just chatting"})); time.sleep(1.5)
assert last()["author"]["id"]!=bot, "bot answered untriggered"
m=ok(requests.post(B+f"/api/channels/{text}/messages",headers=T,json={"content":f"<@{bot}> hi!"}))
for _ in range(30):
    time.sleep(0.3); l=last()
    if l["author"]["id"]==bot and l["content"].endswith("server!"): break
assert l["content"]=="Hello from the server!", l["content"]; assert l["reply_to"]["id"]==m["id"]; assert l["author"]["is_bot"]
prompt=json.load(open("/tmp/last_prompt.json")); assert "pirate" in prompt["messages"][0]["content"]; assert prompt["messages"][-1]["content"].endswith("bran: @Parley hi!"), prompt["messages"][-1]
print("server backend OK")
# GPU worker
ws=websocket.create_connection(B.replace("http","ws")+"/api/gateway?access_token="+a["token"]); json.loads(ws.recv())
ws.send(json.dumps({"op":"worker_register","gpu":"RTX 4090","vram_mb":24564,"model":"qwen3-14b"}))
def worker():
    while True:
        e=json.loads(ws.recv())
        if e["t"]=="WORKER_ACCEPTED": print("worker accepted")
        if e["t"]=="BOT_JOB":
            j=e["d"]["job_id"]
            for t in ["Worker ","reply ","here."]:
                ws.send(json.dumps({"op":"job_chunk","job_id":j,"text":t})); time.sleep(0.2)
            ws.send(json.dumps({"op":"job_done","job_id":j})); return
th=threading.Thread(target=worker,daemon=True); th.start(); time.sleep(0.5)
assert ok(requests.get(B+"/api/bot",headers=T))["workers"][0]["gpu"]=="RTX 4090"
ok(requests.post(B+f"/api/channels/{text}/messages",headers=T,json={"content":"hey parley, use the gpu"}))
for _ in range(30):
    time.sleep(0.3); l=last()
    if l["author"]["id"]==bot and l["content"].endswith("."): break
assert l["content"]=="Worker reply here.", l["content"]; print("worker backend OK")
# reply-to-bot trigger falls back to server after worker disconnects
ws.close(); time.sleep(0.5)
ok(requests.post(B+f"/api/channels/{text}/messages",headers=T,json={"content":"and again","reply_to":l["id"]}))
for _ in range(30):
    time.sleep(0.3); l2=last()
    if l2["author"]["id"]==bot and l2["id"]!=l["id"] and l2["content"].endswith("!"): break
assert l2["content"]=="Hello from the server!"; print("fallback OK")
# DM bot
dm=ok(requests.post(B+"/api/bot/dm",headers=T)); ok(requests.post(B+f"/api/channels/{dm['id']}/messages",headers=T,json={"content":"secret question"}))
time.sleep(2.5); dl=ok(requests.get(B+f"/api/channels/{dm['id']}/messages?limit=1",headers=T))[0]; assert dl["author"]["id"]==bot; print("DM OK")
print("ALL BOT OK")
