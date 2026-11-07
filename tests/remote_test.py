import requests, time, sys, socket, ssl
from websocket import create_connection
B=sys.argv[1]
s=requests.post(B+"/api/setup",json={"username":"bran","password":"hunter2hunter2","server_name":"G"}).json(); T={"Authorization":"Bearer "+s["token"]}
r=requests.get(B+"/api/admin/remote",headers=T).json(); assert r["status"]["tls_state"] in ("off",""), r
assert requests.put(B+"/api/admin/remote",headers=T,json={"enabled":True,"domain":"not a domain"}).status_code==400
# wrong password first
requests.put(B+"/api/admin/remote",headers=T,json={"enabled":True,"domain":"https://Chat.Llamble.com/","ddns_password":"bad"}); time.sleep(1.5)
r=requests.get(B+"/api/admin/remote",headers=T).json(); assert r["domain"]=="chat.llamble.com" and r["status"]["ddns_state"]=="error" and "Passwords" in r["status"]["ddns_error"], r
assert "ddns_password" not in r and r["has_ddns_password"]  # secret never sent back
requests.put(B+"/api/admin/remote",headers=T,json={"enabled":True,"domain":"chat.llamble.com","ddns_password":"goodpw","email":"x@y.z"}); time.sleep(1.5)
r=requests.get(B+"/api/admin/remote",headers=T).json(); st=r["status"]
assert st["ddns_state"]=="ok" and st["ddns_ip"]=="203.0.113.7", st; print("DDNS update ok ->", st["ddns_ip"])
assert st["tls_state"] in ("obtaining","error","ready"), st
sock=socket.create_connection(("127.0.0.1",8443),timeout=3); print("HTTPS listener up on 8443 (tls:", st["tls_state"]+")"); sock.close()
# voice url depends on how the client connected
ws=create_connection(B.replace("http","ws")+"/api/gateway?access_token="+s["token"]); import json; ready=json.loads(ws.recv())["d"]; ws.close()
vc=[c for g in ready["guilds"] for c in g["channels"] if c["kind"]=="voice"][0]["id"]
lan=requests.post(B+f"/api/channels/{vc}/voice",headers=T).json()["url"]
pub=requests.post(B+f"/api/channels/{vc}/voice",headers={**T,"Host":"chat.llamble.com"}).json()["url"]
assert lan=="ws://NASIP:7880" and pub=="wss://chat.llamble.com/livekit", (lan,pub); print("voice URL: LAN", lan, "| remote", pub)
# signaling proxy
w=create_connection(B.replace("http","ws")+"/livekit/rtc/v1?access_token=abc"); w.send("hello"); echo=w.recv(); w.close()
assert echo=="/rtc/v1?access_token=abc|hello", echo; print("voice proxy relays:", echo)
requests.put(B+"/api/admin/remote",headers=T,json={"enabled":False,"domain":""}); time.sleep(1.5)
try:
    socket.create_connection(("127.0.0.1",8443),timeout=2); raise SystemExit("listener should be off")
except OSError: print("turned off -> HTTPS listener stopped")
print("ALL REMOTE OK")
