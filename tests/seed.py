import requests, io, sys, time
from PIL import Image
B="http://127.0.0.1:8099"; INV=open("/tmp/pdata/ADMIN_INVITE.txt").read().strip()
a=requests.post(B+"/api/auth/register",json={"invite":INV,"username":"bran","password":"hunter2hunter2","display_name":"Bran"}).json(); T={"Authorization":"Bearer "+a["token"]}
g=requests.post(B+"/api/guilds",headers=T,json={"name":"Bran's Clients"}).json(); gid=g["guild"]["id"]; text=[c for c in g["channels"] if c["kind"]=="text"][0]["id"]
requests.patch(B+f"/api/guilds/{gid}/bot",headers=T,json={"enabled":True})
inv=requests.post(B+f"/api/guilds/{gid}/invites",headers=T,json={}).json()
b=requests.post(B+"/api/auth/register",json={"invite":inv["code"],"username":"dana","password":"password123","display_name":"Dana (Acme Co)"}).json(); T2={"Authorization":"Bearer "+b["token"]}
role=requests.post(B+f"/api/guilds/{gid}/roles",headers=T,json={"name":"Client","color":0x3ba55c,"hoist":True,"permissions":0}).json()
requests.put(B+f"/api/guilds/{gid}/members/{b['user']['id']}/roles/{role['id']}",headers=T)
requests.post(B+f"/api/channels/{text}/messages",headers=T,json={"content":"Welcome to the server! **Files**, `code`, ||spoilers|| and > quotes all work.\n```rust\nfn main() { println!(\"hi\"); }\n```"})
img=Image.new("RGB",(1200,700)); 
for x in range(1200):
    for y in range(0,700,7): img.putpixel((x,y),(x%255,80,200))
bio=io.BytesIO(); img.save(bio,"PNG"); bio.seek(0)
f=requests.post(B+"/api/files",headers=T2,files={"file":("mockup.png",bio,"image/png")}).json()
m=requests.post(B+f"/api/channels/{text}/messages",headers=T2,json={"content":"Here's the latest mockup 👀","attachments":[{"id":f["id"]}]}).json()
requests.put(B+f"/api/messages/{m['id']}/reactions/%F0%9F%94%A5",headers=T)
requests.put(B+f"/api/messages/{m['id']}/reactions/%F0%9F%91%8D",headers=T2)
requests.post(B+f"/api/channels/{text}/messages",headers=T2,json={"content":"@Parley can you summarize?".replace("@Parley",f"<@{requests.get(B+'/api/bot',headers=T).json()['bot_user_id']}>"),"reply_to":m["id"]})
time.sleep(3)
open("/tmp/token.txt","w").write(a["token"])
print("seeded")
