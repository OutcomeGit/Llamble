# Built-in voice server + relay mode end to end. Args: base_url server_binary
import requests, time, sys, socket, subprocess, re, os, json
from websocket import create_connection
B, BIN = sys.argv[1], sys.argv[2]
def wait(f, t=15):
    end=time.time()+t
    while time.time()<end:
        v=f()
        if v: return v
        time.sleep(0.3)
    raise SystemExit("timed out")
s=requests.post(B+"/api/setup",json={"username":"bran","password":"hunter2hunter2","server_name":"G"}).json(); T={"Authorization":"Bearer "+s["token"]}
# settings page: learns the home IP from how we reached it, then voice starts advertising it
r=requests.get(B+"/api/admin/settings",headers={**T,"Host":"192.168.1.50:8090"}).json()
assert r["settings"]["lan_ip"]=="192.168.1.50", r
wait(lambda: requests.get(B+"/api/admin/settings",headers=T).json()["voice"]["state"]=="running")
assert "node_ip: 192.168.1.50" in open("/tmp/fake_lk.yaml").read(); print("voice server running, media address 192.168.1.50")
# editing settings
assert requests.put(B+"/api/admin/settings",headers=T,json={"lan_ip":"nope"}).status_code==400
r=requests.put(B+"/api/admin/settings",headers=T,json={"max_upload_mb":1,"bot_name":"Spitz","guild_create":"all","unfurl_links":False}).json()["settings"]
assert r["max_upload_mb"]==1 and r["bot_name"]=="Spitz"
info=requests.get(B+"/api/info").json(); assert info["max_upload_bytes"]==1024*1024 and info["bot_name"]=="Spitz", info
big=requests.post(B+"/api/files",headers=T,files={"file":("a.bin",b"x"*(2*1024*1024))})
assert big.status_code in (400,413), big.status_code; print("settings apply live (upload limit, bot name)")
# voice join: signaling goes through Llamble's own port, signed with the generated key
ws=create_connection(B.replace("http","ws")+"/api/gateway?access_token="+s["token"]); ready=json.loads(ws.recv())["d"]; ws.close()
assert ready["config"]["voice_enabled"]
vc=[c for g in ready["guilds"] for c in g["channels"] if c["kind"]=="voice"][0]["id"]
j=requests.post(B+f"/api/channels/{vc}/voice",headers={**T,"Host":"192.168.1.50:8090"}).json()
assert j["url"]=="ws://192.168.1.50:8090/livekit" and j["token"].count(".")==2, j
w=create_connection(B.replace("http","ws")+"/livekit/rtc/v1?access_token=t"); w.send("hi"); assert w.recv()=="/rtc/v1?access_token=t|hi"; w.close()
print("voice join url", j["url"], "+ signaling proxy ok")
# relay: grab the token from the command the admin would paste on the VPS
rem=requests.get(B+"/api/admin/remote",headers=T).json()
tok=re.search(r"LLAMBLE_RELAY_TOKEN=(\S+)",rem["relay_command"]).group(1)
assert "llamble-server relay" in rem["relay_command"] and "443:8443" in rem["relay_command"]
env={**os.environ,"LLAMBLE_RELAY_PORT_SHIFT":"10000"}
bad=subprocess.Popen([BIN,"relay"],env={**env,"LLAMBLE_RELAY_TOKEN":"wrong-token-wrong-token"}); time.sleep(1)
requests.put(B+"/api/admin/remote",headers=T,json={"enabled":True,"mode":"relay","domain":"chat.example.com","relay_addr":"127.0.0.1"})
wait(lambda: "rejected" in (requests.get(B+"/api/admin/remote",headers=T).json()["status"]["relay_error"] or ""))
print("wrong token rejected"); bad.terminate(); bad.wait(); time.sleep(0.5)
relay=subprocess.Popen([BIN,"relay"],env={**env,"LLAMBLE_RELAY_TOKEN":tok})
try:
    wait(lambda: requests.get(B+"/api/admin/remote",headers=T).json()["status"]["relay_state"]=="connected", 90)
    wait(lambda: "node_ip: 127.0.0.1" in open("/tmp/fake_lk.yaml").read())
    wait(lambda: requests.get(B+"/api/admin/settings",headers=T).json()["voice"]["state"]=="running"); time.sleep(1)
    print("relay connected; voice now advertises the relay's address")
    c=socket.create_connection(("127.0.0.1",17881),timeout=3); c.sendall(b"tcp-hello"); got=c.recv(100); assert got==b"lk:tcp-hello", (got, open("/tmp/rt/log").read()[-1500:]); c.close()
    u=socket.socket(socket.AF_INET,socket.SOCK_DGRAM); u.settimeout(3)
    for i in range(5):
        u.sendto(f"pkt{i}".encode(),("127.0.0.1",17882)); assert u.recvfrom(2000)[0]==f"lk:pkt{i}".encode()
    print("voice TCP + UDP flow through the relay")
    h=socket.create_connection(("127.0.0.1",18443),timeout=3); h.close(); print("HTTPS port reachable through the relay")
    requests.put(B+"/api/admin/remote",headers=T,json={"enabled":False,"domain":""})
    wait(lambda: "node_ip: 192.168.1.50" in open("/tmp/fake_lk.yaml").read())
    print("remote off -> voice back to home address")
finally:
    relay.terminate()
print("ALL RELAY OK")
