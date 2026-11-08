import json, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
def sse(w, obj):
    w.write(f"data: {json.dumps(obj)}\n\n".encode()); w.flush()
class H(BaseHTTPRequestHandler):
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["content-length"])))
        open("/tmp/last_prompt.json","w").write(json.dumps(body))
        self.send_response(200); self.send_header("content-type","text/event-stream"); self.end_headers()
        msgs = body.get("messages", [])
        last_user = next((m["content"] for m in reversed(msgs) if m["role"] == "user"), "")
        tool_result = next((m["content"] for m in reversed(msgs) if m["role"] == "tool"), None)
        names = [t["function"]["name"] for t in body.get("tools", [])]
        if tool_result is not None:
            for t in ["The tool says: ", tool_result]:
                sse(self.wfile, {"choices":[{"delta":{"content":t}}]})
        elif "get_current_time" in names and "what time" in last_user.lower():
            sse(self.wfile, {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","type":"function","function":{"name":"get_current_time","arguments":""}}]}}]})
            sse(self.wfile, {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"timezone\": \"America/New_York\"}"}}]}}]})
        elif "calculate" in names and "times" in last_user.lower():
            sse(self.wfile, {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c2","type":"function","function":{"name":"calculate","arguments":"{\"expression\":\"12*12\"}"}}]}}]})
        else:
            for t in ["<think>pondering</think>", "Hello ", "from ", "the server!"]:
                sse(self.wfile, {"choices":[{"delta":{"content":t}}]}); time.sleep(0.3)
        self.wfile.write(b"data: [DONE]\n\n")
    def log_message(self,*a): pass
ThreadingHTTPServer(("127.0.0.1",8098),H).serve_forever()
