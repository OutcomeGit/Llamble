# Stand-ins: Namecheap Dynamic DNS (:8096) and a LiveKit-like websocket endpoint (:8095) that echoes with its path
import asyncio, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs
import websockets
class DDNS(BaseHTTPRequestHandler):
    def do_GET(self):
        q = parse_qs(urlparse(self.path).query)
        ok = q.get("password",[""])[0] == "goodpw" and q.get("host",[""])[0]=="chat" and q.get("domain",[""])[0]=="llamble.com"
        body = "<interface-response><IP>203.0.113.7</IP><ErrCount>0</ErrCount></interface-response>" if ok else \
               "<interface-response><ErrCount>1</ErrCount><errors><Err1>Passwords do not match</Err1></errors></interface-response>"
        self.send_response(200); self.end_headers(); self.wfile.write(body.encode())
    def log_message(self,*a): pass
threading.Thread(target=lambda: ThreadingHTTPServer(("127.0.0.1",8096),DDNS).serve_forever(), daemon=True).start()
async def handler(ws):
    path = ws.request.path
    async for m in ws: await ws.send(f"{path}|{m}")
async def main():
    async with websockets.serve(handler, "127.0.0.1", 8095): await asyncio.Future()
asyncio.run(main())
