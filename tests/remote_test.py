import requests, time, sys, socket, ssl
from websocket import create_connection
B=sys.argv[1]
s=requests.post(B+"/api/setup",json={"username":"bran","password":"hunter2hunter2","server_name":"G"}).json(); T={"Authorization":"Bearer "+s["token"]}
r=requests.get(B+"/api/admin/remote",headers=T).json(); assert r["status"]["tls_state"] in ("off",""), r
assert requests.put(B+"/api/admin/remote",headers=T,json={"enabled":True,"domain":"not a domain"}).status_code==400
# wrong password first
requests.put(B+"/api/admin/remote",headers=T,json={"enabled":True,"domain":"https://Chat.Llamble.com/","ddns_password":"bad"}); time.sleep(1.5)
r=requests.get(B+"/api/admin/remote",headers=T).json(); assert r["domain"]=="chat.llamble.com" and r["status"]["ddns_state"]=="error" and "Passwords" in r["status"]["ddns_error"], r
assert "ddns_password" not in r and r["has_ddns_secret"] and r["ddns_provider"]=="namecheap"  # secret never sent back
requests.put(B+"/api/admin/remote",headers=T,json={"enabled":True,"domain":"chat.llamble.com","ddns_password":"goodpw","email":"x@y.z"}); time.sleep(1.5)
r=requests.get(B+"/api/admin/remote",headers=T).json(); st=r["status"]
assert st["ddns_state"]=="ok" and st["ddns_ip"]=="203.0.113.7", st; print("DDNS update ok ->", st["ddns_ip"])
assert st["tls_state"] in ("obtaining","error","ready"), st
for _ in range(40):  # the listener starts in the background
    try: sock=socket.create_connection(("127.0.0.1",8443),timeout=3); break
    except OSError: time.sleep(0.25)
else: raise SystemExit("HTTPS listener never came up")
print("HTTPS listener up on 8443 (tls:", st["tls_state"]+")"); sock.close()
# voice url depends on how the client connected
ws=create_connection(B.replace("http","ws")+"/api/gateway?access_token="+s["token"]); import json; ready=json.loads(ws.recv())["d"]; ws.close()
vc=[c for g in ready["guilds"] for c in g["channels"] if c["kind"]=="voice"][0]["id"]
lan=requests.post(B+f"/api/channels/{vc}/voice",headers=T).json()["url"]
pub=requests.post(B+f"/api/channels/{vc}/voice",headers={**T,"Host":"chat.llamble.com"}).json()["url"]
assert lan=="ws://NASIP:7880" and pub=="wss://chat.llamble.com/livekit", (lan,pub); print("voice URL: LAN", lan, "| remote", pub)
# signaling proxy
w=create_connection(B.replace("http","ws")+"/livekit/rtc/v1?access_token=abc"); w.send("hello"); echo=w.recv(); w.close()
assert echo=="/rtc/v1?access_token=abc|hello", echo; print("voice proxy relays:", echo)
# other providers
M="http://127.0.0.1:8096"
def remote(**body):
    requests.put(B+"/api/admin/remote",headers=T,json={"enabled":True,"mode":"direct",**body}); time.sleep(1.5)
    return requests.get(B+"/api/admin/remote",headers=T).json()
r=remote(domain="chat.example.net",ddns_provider="cloudflare",ddns_password="wrong")
assert r["status"]["ddns_state"]=="error" and "Invalid API Token" in r["status"]["ddns_error"], r["status"]
r=remote(domain="chat.example.net",ddns_provider="cloudflare",ddns_password="cftoken")
assert r["status"]["ddns_ip"]=="192.0.2.44", r["status"]; st=requests.get(M+"/stats").json()
assert st["records"]["chat.example.net"]=="192.0.2.44" and st["last"]=="POST", st
r=remote(domain="chat.example.net",ddns_provider="cloudflare"); assert requests.get(M+"/stats").json()["last"]=="PUT"  # updates the existing record
print("Cloudflare: creates, then updates the A record ->", r["status"]["ddns_ip"])
r=remote(domain="llambletest.duckdns.org",ddns_provider="duckdns",ddns_password="ducktoken")
assert r["status"]["ddns_state"]=="ok" and r["status"]["ddns_ip"]=="198.51.100.9", r["status"]; print("DuckDNS ok ->", r["status"]["ddns_ip"])
r=remote(domain="chat.example.org",ddns_provider="custom",ddns_url=M+"/custom?key=k1&myip={ip}")
assert r["status"]["ddns_ip"]=="192.0.2.44" and requests.get(M+"/stats").json()["custom_ip"]=="192.0.2.44", r["status"]
assert "ddns_url" not in r; print("custom update URL ok ({ip} filled in)")
import socket as _s
try: _s.gethostbyname("manual.llamble.test"); has_host=True
except OSError: has_host=False
if has_host:  # run_all.sh adds this name to /etc/hosts when it can
    r=remote(domain="manual.llamble.test",ddns_provider="manual")
    assert r["status"]["ddns_state"]=="ok" and r["status"]["ddns_ip"]=="127.0.0.1", r["status"]; print("manual: reads what the address points to ->", r["status"]["ddns_ip"])
r=remote(domain="nothing-here.invalid",ddns_provider="manual")
assert r["status"]["ddns_state"]=="error" and "doesn't point anywhere" in r["status"]["ddns_error"], r["status"]
assert requests.put(B+"/api/admin/remote",headers=T,json={"enabled":True,"mode":"direct","domain":"a.b.c","ddns_provider":"godaddy"}).status_code==400
requests.put(B+"/api/admin/remote",headers=T,json={"enabled":False,"domain":""}); time.sleep(1.5)
try:
    socket.create_connection(("127.0.0.1",8443),timeout=2); raise SystemExit("listener should be off")
except OSError: print("turned off -> HTTPS listener stopped")
print("ALL REMOTE OK")
