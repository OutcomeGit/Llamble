"""Makes Llamble's built-in soundboard clips from scratch (pure synthesis, so they're
original and free to ship). Run: python3 tools/make_sounds.py  (needs numpy, scipy, ffmpeg)"""
import numpy as np, subprocess, os, tempfile
from scipy.signal import butter, sosfilt
from scipy.io import wavfile

SR = 44100
OUT = os.path.join(os.path.dirname(__file__), "..", "client", "public", "sounds")
rng = np.random.default_rng(7)

def t(sec): return np.arange(int(SR * sec)) / SR
def env(n, a=0.01, r=0.1):
    e = np.ones(n); A = min(n, max(1, int(a * SR))); R = min(n, max(1, int(r * SR)))
    e[:A] = np.linspace(0, 1, A); e[-R:] *= np.linspace(1, 0, R); return e
def saw(f, tt): ph = np.cumsum(np.broadcast_to(f, tt.shape) / SR); return 2 * (ph % 1) - 1
def sq(f, tt): return np.sign(np.sin(2 * np.pi * np.cumsum(np.broadcast_to(f, tt.shape) / SR)))
def sine_f(f, tt): return np.sin(2 * np.pi * np.cumsum(np.broadcast_to(f, tt.shape) / SR))
def lp(x, fc, o=4): return sosfilt(butter(o, fc, "low", fs=SR, output="sos"), x)
def hp(x, fc, o=4): return sosfilt(butter(o, fc, "high", fs=SR, output="sos"), x)
def bp(x, lo, hi, o=4): return sosfilt(butter(o, [lo, hi], "band", fs=SR, output="sos"), x)
def noise(sec): return rng.standard_normal(int(SR * sec))
def place(buf, x, at):
    i = int(at * SR); n = min(len(x), len(buf) - i); buf[i:i + n] += x[:n]
def save(name, x):
    x = x / (np.max(np.abs(x)) + 1e-9) * 0.89
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
        wavfile.write(f.name, SR, (x * 32767).astype(np.int16))
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", f.name, "-ac", "1", "-b:a", "96k", os.path.join(OUT, name + ".mp3")], check=True)
    os.unlink(f.name)

def snare(d=0.18, tone=190):
    tt = t(d); n = hp(noise(d), 1500) * np.exp(-tt * 22) + 0.6 * np.sin(2 * np.pi * tone * tt) * np.exp(-tt * 35)
    return n
def crash(d=1.6):
    tt = t(d); return hp(noise(d), 4000) * np.exp(-tt * 2.6) * 0.7
def kick(d=0.25):
    tt = t(d); f = 50 + 90 * np.exp(-tt * 30); return sine_f(f, tt) * np.exp(-tt * 12)

# airhorn: short short looong, a fat detuned brassy chord with a little pitch scoop
def airhorn():
    buf = np.zeros(int(SR * 2.3))
    for at, d in [(0, 0.22), (0.3, 0.22), (0.6, 1.6)]:
        tt = t(d); scoop = 1 - 0.06 * np.exp(-tt * 25)
        x = sum(saw(f * scoop * (1 + 0.004 * k), tt) for f in (415, 523, 622) for k in (-1, 1))
        x = np.tanh(lp(x, 3500) * 1.8) * env(len(tt), 0.01, 0.05)
        place(buf, x, at)
    return buf

def rimshot():
    buf = np.zeros(int(SR * 2.0))
    place(buf, snare(), 0); place(buf, snare(), 0.16); place(buf, kick(), 0.42); place(buf, crash(1.5), 0.42)
    return buf

def crickets():
    buf = 0.04 * lp(noise(3.0), 300)
    for c in range(9):
        at = c * 0.33 + rng.uniform(-0.03, 0.03)
        for k in range(3):
            tt = t(0.035); f = 4300 + rng.uniform(-80, 80)
            place(buf, np.sin(2 * np.pi * f * tt) * np.sin(np.pi * tt / 0.035) * 0.5, at + k * 0.05)
    return buf

def sad_trombone():
    notes = [(233.1, 0.0, 0.42), (220.0, 0.48, 0.42), (207.7, 0.96, 0.42), (196.0, 1.44, 1.5)]
    buf = np.zeros(int(SR * 3.2))
    for f, at, d in notes:
        tt = t(d); vib = 1 + (0.025 * np.sin(2 * np.pi * 5.5 * tt) * np.clip((tt - 0.3) * 2, 0, 1) if d > 1 else 0)
        x = saw(f * vib, tt)
        # "wah": crossfade from a muffled to an open tone (like a plunger mute opening)
        k = np.clip(tt * 4, 0, 1)
        y = (1 - k) * lp(x, 450, 2) * 1.6 + k * lp(x, 1600, 2)
        place(buf, y * env(len(tt), 0.04, 0.12), at)
    return buf

def boing():
    tt = t(1.1)
    f = 140 + 260 * np.exp(-tt * 2.5) * (1 + 0.35 * np.sin(2 * np.pi * 14 * tt) * np.exp(-tt * 2))
    return sine_f(f, tt) * np.exp(-tt * 3.0) + 0.3 * sine_f(2 * f, tt) * np.exp(-tt * 5)

def drumroll():
    buf = np.zeros(int(SR * 3.6)); n = 2.4
    for i in range(int(n / 0.045)):
        at = i * 0.045; g = 0.25 + 0.75 * (at / n)
        place(buf, snare(0.09, 210) * g * rng.uniform(0.8, 1), at)
    place(buf, kick(0.4) * 1.3, n); place(buf, crash(1.2), n)
    return buf

def applause():
    d = 3.2; buf = np.zeros(int(SR * d))
    for _ in range(900):
        at = rng.uniform(0, d - 0.1)
        dens = min(1, at * 3) * min(1, (d - at) * 1.2)
        if rng.random() > dens: continue
        tt = t(0.02); c = bp(rng.standard_normal(len(tt)), rng.uniform(900, 1600), 5000, 2) * np.exp(-tt * 260)
        place(buf, c * rng.uniform(0.3, 1), at)
    return buf

def tada():
    buf = np.zeros(int(SR * 2.0))
    def brass(fs, d):
        tt = t(d); x = sum(saw(f * (1 + 0.003 * k), tt) for f in fs for k in (-1, 1))
        return np.tanh(lp(x, 2600) * 1.4) * env(len(tt), 0.015, 0.15)
    place(buf, brass([523.3], 0.13), 0); place(buf, brass([523.3, 659.3, 784.0, 1046.5], 1.5), 0.17)
    place(buf, crash(1.3) * 0.5, 0.17)
    return buf

def whoosh():
    d = 0.9; tt = t(d); x = noise(d); y = np.zeros_like(x)
    fc = 300 + 3500 * np.sin(np.pi * tt / d) ** 2
    # sweep by crossfading a few fixed band-passes (no filter-state clicks)
    bands = [(300, 700), (700, 1600), (1600, 3500), (3500, 7000)]
    centers = np.array([500, 1100, 2400, 5000])
    for (lo, hi), c in zip(bands, centers):
        w = np.exp(-((np.log(fc) - np.log(c)) ** 2) / 0.35)
        y += bp(x, lo, hi, 2) * w
    return y * np.sin(np.pi * tt / d) ** 1.5

def bonk():
    tt = t(0.6); f = 160 * (1 + 0.6 * np.exp(-tt * 40))
    x = sine_f(f, tt) * np.exp(-tt * 9) + 0.5 * sine_f(f * 2.76, tt) * np.exp(-tt * 18) + 0.3 * sine_f(f * 5.4, tt) * np.exp(-tt * 30)
    x[: int(0.004 * SR)] += hp(noise(0.004), 2000) * 0.8
    return x

os.makedirs(OUT, exist_ok=True)
for name, fn in [("airhorn", airhorn), ("rimshot", rimshot), ("crickets", crickets), ("sad-trombone", sad_trombone), ("boing", boing),
                 ("drumroll", drumroll), ("applause", applause), ("tada", tada), ("whoosh", whoosh), ("bonk", bonk)]:
    save(name, fn()); print("made", name)
