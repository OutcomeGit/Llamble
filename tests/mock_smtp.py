# Minimal SMTP stand-in (no TLS) on :8025. Each received message is appended to /tmp/llamble_mail.txt
import socketserver
OUT = "/tmp/llamble_mail.txt"
class H(socketserver.StreamRequestHandler):
    def w(self, s): self.wfile.write((s + "\r\n").encode())
    def handle(self):
        self.w("220 mock ESMTP")
        data = None
        while True:
            line = self.rfile.readline()
            if not line: return
            cmd = line.decode(errors="replace").strip()
            if data is not None:
                if cmd == ".":
                    open(OUT, "a").write("\n".join(data) + "\n=====\n"); data = None; self.w("250 queued")
                else:
                    data.append(cmd[1:] if cmd.startswith("..") else cmd)
                continue
            up = cmd.upper()
            if up.startswith("EHLO") or up.startswith("HELO"): self.w("250-mock"); self.w("250 AUTH PLAIN LOGIN")
            elif up.startswith("AUTH"): self.w("235 ok")
            elif up.startswith("MAIL") or up.startswith("RCPT") or up.startswith("RSET") or up.startswith("NOOP"): self.w("250 ok")
            elif up == "DATA": data = []; self.w("354 go")
            elif up == "QUIT": self.w("221 bye"); return
            else: self.w("250 ok")
class S(socketserver.ThreadingTCPServer): allow_reuse_address = True
S(("127.0.0.1", 8025), H).serve_forever()
