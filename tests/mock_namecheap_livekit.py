# Stand-ins (:8096): Namecheap / Cloudflare / DuckDNS / custom-URL dynamic DNS and an IP echo; and a LiveKit-like websocket endpoint (:8095) that echoes with its path
import asyncio, threading, json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs
import websockets
CF={"records":{}}  # Cloudflare stand-in state: name -> ip
class DDNS(BaseHTTPRequestHandler):
    def reply(self, body, code=200, ctype="text/plain"):
        b = body if isinstance(body, bytes) else body.encode()
        self.send_response(code); self.send_header("content-type", ctype); self.end_headers(); self.wfile.write(b)
    def j(self, v, code=200): self.reply(json.dumps(v), code, "application/json")
    def cf_ok(self):
        if self.headers.get("authorization") != "Bearer cftoken":
            self.j({"success": False, "errors": [{"message": "Invalid API Token"}]}, 403); return False
        return True
    def do_GET(self):
        u = urlparse(self.path); q = parse_qs(u.query)
        if u.path == "/update":  # Namecheap
            ok = q.get("password",[""])[0] == "goodpw" and q.get("host",[""])[0]=="chat" and q.get("domain",[""])[0]=="llamble.com"
            body = "<interface-response><IP>203.0.113.7</IP><ErrCount>0</ErrCount></interface-response>" if ok else \
                   "<interface-response><ErrCount>1</ErrCount><errors><Err1>Passwords do not match</Err1></errors></interface-response>"
            return self.reply(body)
        if u.path == "/duck/update":
            ok = q.get("token",[""])[0]=="ducktoken" and q.get("domains",[""])[0]=="llambletest"
            return self.reply("OK\n198.51.100.9\n\nUPDATED" if ok else "KO")
        if u.path == "/trace":
            return self.reply("fl=1\nip=192.0.2.44\nts=1\n")
        if u.path == "/custom":
            CF["custom_hits"] = CF.get("custom_hits", 0) + 1; CF["custom_ip"] = q.get("myip",[""])[0]
            return self.reply("good") if q.get("key",[""])[0] == "k1" else self.reply("badauth", 401)
        if u.path == "/stats": return self.j(CF)
        if u.path == "/client/v4/zones":
            if not self.cf_ok(): return
            name = q.get("name",[""])[0]
            return self.j({"success": True, "result": [{"id": "zone1"}] if name == "example.net" else []})
        if u.path == "/client/v4/zones/zone1/dns_records":
            if not self.cf_ok(): return
            name = q.get("name",[""])[0]
            return self.j({"success": True, "result": [{"id": "rec1"}] if name in CF["records"] else []})
        self.reply("nope", 404)
    def write_record(self):
        if not self.cf_ok(): return
        body = json.loads(self.rfile.read(int(self.headers["content-length"])))
        CF["records"][body["name"]] = body["content"]; CF["last"] = self.command
        self.j({"success": True, "result": {"id": "rec1"}})
    do_POST = write_record
    do_PUT = write_record
    def log_message(self,*a): pass
threading.Thread(target=lambda: ThreadingHTTPServer(("127.0.0.1",8096),DDNS).serve_forever(), daemon=True).start()
async def handler(ws):
    path = ws.request.path
    async for m in ws: await ws.send(f"{path}|{m}")
async def main():
    async with websockets.serve(handler, "127.0.0.1", 8095): await asyncio.Future()
asyncio.run(main())
