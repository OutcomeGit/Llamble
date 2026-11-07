import json, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
class H(BaseHTTPRequestHandler):
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["content-length"])))
        open("/tmp/last_prompt.json","w").write(json.dumps(body))
        self.send_response(200); self.send_header("content-type","text/event-stream"); self.end_headers()
        for t in ["<think>pondering</think>", "Hello ", "from ", "the server!"]:
            self.wfile.write(f"data: {json.dumps({'choices':[{'delta':{'content':t}}]})}\n\n".encode()); self.wfile.flush(); time.sleep(0.3)
        self.wfile.write(b"data: [DONE]\n\n")
    def log_message(self,*a): pass
ThreadingHTTPServer(("127.0.0.1",8098),H).serve_forever()
