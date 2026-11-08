#!/usr/bin/env python3
# Stand-in for sd-cli: checks the model files exist, writes a small PNG of the asked size.
import sys, os, struct, zlib
a = sys.argv
for flag in ("--diffusion-model", "--vae", "--llm"):
    assert os.path.exists(a[a.index(flag) + 1]), flag
w, h, out = int(a[a.index("-W") + 1]), int(a[a.index("-H") + 1]), a[a.index("-o") + 1]
open(os.environ.get("FAKE_SD_LOG", "/tmp/fake_sd.log"), "a").write(a[a.index("-p") + 1] + "\n")
def chunk(t, d): return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d))
raw = b"".join(b"\0" + bytes([200, 80, 40]) * w for _ in range(h))
open(out, "wb").write(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))
