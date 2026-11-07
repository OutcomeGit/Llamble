#!/usr/bin/env python3
# Stand-in for llama-server: parses -m/--port, checks the model file, serves /health + streaming chat
import json, os, sys, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
a = sys.argv; port = int(a[a.index("--port")+1]); model = a[a.index("-m")+1]
assert open(model,"rb").read(4) == b"GGUF", "bad model file"
print(f"fake llama-server loading {model}", flush=True); time.sleep(1)
class H(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200 if self.path=="/health" else 404); self.end_headers(); self.wfile.write(b'{"status":"ok"}')
    def do_POST(self):
        self.rfile.read(int(self.headers["content-length"]))
        self.send_response(200); self.send_header("content-type","text/event-stream"); self.end_headers()
        for t in ["Built-in ", "model ", "says hi."]:
            self.wfile.write(f"data: {json.dumps({'choices':[{'delta':{'content':t}}]})}\n\n".encode()); self.wfile.flush()
        self.wfile.write(b"data: [DONE]\n\n")
    def log_message(self,*a): pass
ThreadingHTTPServer(("127.0.0.1",port),H).serve_forever()
