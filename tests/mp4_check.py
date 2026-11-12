# Checks an MP4 written by the native recorder or instant replay: the header boxes are there,
# there's video, and (for a fragmented clip) the first fragment's clock starts at zero.
# Usage: mp4_check.py file.mp4 [--fragmented]
import struct, sys

data = open(sys.argv[1], "rb").read()
frag = "--fragmented" in sys.argv

def boxes(buf, start, end):
    i = start
    while i + 8 <= end:
        size, kind = struct.unpack(">I4s", buf[i:i + 8])
        if size == 1:
            size = struct.unpack(">Q", buf[i + 8:i + 16])[0]
        if size < 8 or i + size > end:
            break
        yield kind.decode("latin1"), i, size
        i += size

top = list(boxes(data, 0, len(data)))
kinds = [k for k, _, _ in top]
print("top-level boxes:", " ".join(kinds[:8]), "…" if len(kinds) > 8 else "", f"({len(kinds)} total, {len(data) // 1024} KB)")
assert kinds[0] == "ftyp", "doesn't start with ftyp"
assert "moov" in kinds, "no moov"
_, mi, ms = next(b for b in top if b[0] == "moov")
tracks = [b for b in boxes(data, mi + 8, mi + ms) if b[0] == "trak"]
print("tracks:", len(tracks))
assert tracks, "no tracks"
if frag:
    moofs = [b for b in top if b[0] == "moof"]
    assert len(moofs) >= 2, f"only {len(moofs)} fragments"
    times, bad = [], 0
    for n, (_, fi, fs) in enumerate(moofs):
        mdat = next(((i, sz) for k, i, sz in top if k == "mdat" and i >= fi + fs), None)
        assert mdat, "a fragment without its data"
        for k, ti, ts in boxes(data, fi + 8, fi + fs):
            if k != "traf":
                continue
            base, off = fi, 0
            for k2, di, ds in boxes(data, ti + 8, ti + ts):
                if k2 == "tfhd":
                    flags = struct.unpack(">I", data[di + 8:di + 12])[0] & 0xFFFFFF
                    if flags & 1:
                        base = struct.unpack(">Q", data[di + 16:di + 24])[0]
                elif k2 == "tfdt" and n == 0:
                    v = data[di + 8]
                    times.append(struct.unpack(">Q", data[di + 12:di + 20])[0] if v == 1 else struct.unpack(">I", data[di + 12:di + 16])[0])
                elif k2 == "trun":
                    flags = struct.unpack(">I", data[di + 8:di + 12])[0] & 0xFFFFFF
                    if flags & 1:
                        off = struct.unpack(">i", data[di + 16:di + 20])[0]
            pos = base + off
            if not (mdat[0] + 8 <= pos < mdat[0] + mdat[1]):
                bad += 1
            break  # the first track of each fragment is enough to tell
    print("fragments:", len(moofs), "| first fragment's start times:", times or "none written (plays from zero)", "| fragments pointing outside their data:", bad)
    assert not times or min(times) == 0, "clip doesn't start at zero"
    assert bad == 0, "fragment data offsets are wrong"
else:
    assert "mdat" in kinds, "no media data"
print("MP4 OK")
