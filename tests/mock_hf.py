# Stand-in for huggingface.co: model tree listing + resumable file downloads
import json, os, re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
FILES = {"tiny/Test-GGUF": {"Test-Q4_K_M.gguf": b"GGUF" + os.urandom(3_000_000), "Test-Q8_0.gguf": b"GGUF" + os.urandom(1000),
                            "mmproj-F16.gguf": b"x", "README.md": b"hi"}}
class H(BaseHTTPRequestHandler):
    def do_GET(self):
        m = re.match(r"/api/models/([^/]+/[^/]+)/tree/main", self.path)
        if m:
            repo = m.group(1)
            if repo not in FILES: self.send_response(404); self.end_headers(); return
            body = json.dumps([{"type":"file","path":p,"size":len(b),"lfs":{"size":len(b)}} for p,b in FILES[repo].items()]).encode()
            self.send_response(200); self.send_header("content-type","application/json"); self.end_headers(); self.wfile.write(body); return
        m = re.match(r"/([^/]+/[^/]+)/resolve/main/(.+)", self.path)
        if m and m.group(1) in FILES and m.group(2) in FILES[m.group(1)]:
            data = FILES[m.group(1)][m.group(2)]
            rng = self.headers.get("Range")
            start = int(re.match(r"bytes=(\d+)-", rng).group(1)) if rng else 0
            self.send_response(206 if rng else 200)
            self.send_header("content-length", str(len(data)-start)); self.end_headers()
            self.wfile.write(data[start:]); return
        self.send_response(404); self.end_headers()
    def log_message(self,*a): pass
ThreadingHTTPServer(("127.0.0.1",8097),H).serve_forever()
