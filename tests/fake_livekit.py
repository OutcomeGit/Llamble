#!/usr/bin/env python3
# Stand-in for livekit-server: records its config, echoes on signaling (7880 ws), 7881/tcp, 7882/udp
import asyncio, os, sys, websockets
cfg = sys.argv[sys.argv.index("--config-body")+1]
open(os.environ.get("FAKE_LK_OUT","/tmp/fake_lk.yaml"),"w").write(cfg)
class Udp(asyncio.DatagramProtocol):
    def connection_made(self,t): self.t=t
    def datagram_received(self,d,a): self.t.sendto(b"lk:"+d,a)
async def tcp(r,w):
    while (d := await r.read(4096)):
        w.write(b"lk:"+d); await w.drain()
    w.close()
async def ws(c):
    async for m in c: await c.send(f"{c.request.path}|{m}")
async def main():
    loop=asyncio.get_running_loop()
    await loop.create_datagram_endpoint(Udp, local_addr=("0.0.0.0",7882))
    await asyncio.start_server(tcp,"0.0.0.0",7881)
    async with websockets.serve(ws,"127.0.0.1",7880): await asyncio.Future()
asyncio.run(main())
