#!/usr/bin/env python3
"""Builds client/src/legal/third-party-licenses.txt: every library that ships inside Llamble,
with its licence text. Run from the repo root after `npm ci` in client/ (needs cargo too):

    python3 tools/third_party_licenses.py

Bundled into the apps and shown (Settings -> About)."""
import json, os, re, subprocess, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "client/src/legal/third-party-licenses.txt"
LICENSE_OUT = ROOT / "client/src/legal/license.txt"  # Llamble's own licence + plain-English guide, for Settings -> About
LIC_NAMES = re.compile(r"^(licen[cs]e|copying|notice)([-._].*)?$", re.I)
CARGO_SRC = Path(os.environ.get("CARGO_HOME", Path.home() / ".cargo")) / "registry/src"

# Pieces that aren't npm or cargo libraries: separate programs in the server image, and models.
EXTRA = """\
== Separate programs in the server image (run as their own processes, unmodified) ==
LiveKit server .............. Apache-2.0   https://github.com/livekit/livekit
llama.cpp (llama-server) .... MIT          https://github.com/ggml-org/llama.cpp
stable-diffusion.cpp ........ MIT          https://github.com/leejet/stable-diffusion.cpp
sherpa-onnx ................. Apache-2.0   https://github.com/k2-fsa/sherpa-onnx
FFmpeg ...................... LGPL-2.1+ / GPL-2.0+ (Ubuntu package, unmodified; source:
                              https://launchpad.net/ubuntu/+source/ffmpeg)
Ubuntu base image packages .. various      https://ubuntu.com/legal/open-source-licences

== Models downloaded only when an admin turns them on ==
FLUX.2 [klein] 4B, Z-Image Turbo .... Apache-2.0
Whisper, Kokoro ..................... MIT / Apache-2.0

== Electron (Windows app) ==
Electron and Chromium ship their own notices next to the app: LICENSE and LICENSES.chromium.html
in the install folder.
"""


def licence_files(folder: Path):
    if not folder.is_dir():
        return []
    return sorted(p for p in folder.iterdir() if p.is_file() and LIC_NAMES.match(p.name))


def npm_packages():
    """Production dependencies of the client (what ends up in the app), plus the noise
    suppressor, which is copied in at build time."""
    nm = ROOT / "client/node_modules"
    pkg = json.loads((ROOT / "client/package.json").read_text())
    todo = list(pkg.get("dependencies", {})) + ["@sapphi-red/web-noise-suppressor"]
    seen, out = set(), []
    while todo:
        name = todo.pop()
        if name in seen:
            continue
        seen.add(name)
        folder = nm / name
        meta_path = folder / "package.json"
        if not meta_path.exists():
            continue
        meta = json.loads(meta_path.read_text())
        lic = meta.get("license") or meta.get("licenses") or "see licence text"
        if isinstance(lic, dict):
            lic = lic.get("type", "")
        if isinstance(lic, list):
            lic = " OR ".join(l.get("type", "") if isinstance(l, dict) else str(l) for l in lic)
        out.append((name, meta.get("version", ""), str(lic), licence_files(folder)))
        todo += list(meta.get("dependencies", {}))
    return out


def cargo_packages(manifest_dir: Path, target=None):
    cmd = ["cargo", "tree", "-e", "normal", "--prefix", "none", "--format", "{p}|{l}"]
    if target:
        cmd += ["--target", target]
    res = subprocess.run(cmd, cwd=manifest_dir, capture_output=True, text=True)
    if res.returncode:
        sys.exit(f"cargo tree failed in {manifest_dir}:\n{res.stderr}")
    out = {}
    for line in res.stdout.splitlines():
        line = line.replace(" (*)", "").strip()
        if "|" not in line:
            continue
        spec, lic = line.split("|", 1)
        parts = spec.split()
        if len(parts) < 2 or "(" in spec:  # our own crates have a path in brackets
            continue
        name, ver = parts[0], parts[1].lstrip("v")
        folders = list(CARGO_SRC.glob(f"*/{name}-{ver}"))
        out[(name, ver)] = (lic or "see licence text", licence_files(folders[0]) if folders else [])
    return out


def main():
    rust = {}
    rust.update(cargo_packages(ROOT / "server"))
    rust.update(cargo_packages(ROOT / "client/native/llamble-helper", "x86_64-pc-windows-msvc"))
    npm = npm_packages()

    lines = [
        "Third-party software in Llamble",
        "================================",
        "",
        "Llamble itself is under the PolyForm Shield License 1.0.0 (see LICENSE.txt).",
        "It includes the open-source software listed below, each under its own licence,",
        "which is reproduced in full after the lists.",
        "",
        EXTRA,
        f"== JavaScript libraries in the app ({len(npm)}) ==",
    ]
    lines += [f"{n} {v} .... {l}" for n, v, l, _ in sorted(npm)]
    lines += ["", f"== Rust libraries in the server and the Windows helper ({len(rust)}) =="]
    lines += [f"{n} {v} .... {l}" for (n, v), (l, _) in sorted(rust.items())]
    lines += ["", "", "Licence texts", "============="]

    entries = [(f"{n} {v}", files) for n, v, _, files in sorted(npm)]
    entries += [(f"{n} {v}", files) for (n, v), (_, files) in sorted(rust.items())]
    # many packages carry the exact same text (the Apache-2.0 file, say): print each text once,
    # headed by every package that uses it
    missing, texts = [], {}
    for title, files in entries:
        if not files:
            missing.append(title)
            continue
        for f in files:
            texts.setdefault(f.read_text(errors="replace").strip(), []).append(title)
    for text, users in texts.items():
        lines += ["", "-" * 78, "Used by: " + ", ".join(dict.fromkeys(users)), "-" * 78, text]
    lines += ["", "MPL-2.0 libraries (cssparser, selectors, dtoa-short) are used unmodified; their source",
              "is on crates.io at the versions listed above."]
    if missing:
        lines += ["", "-" * 78,
                  "These packages ship no separate licence file; their licence is the one listed above:",
                  ", ".join(missing)]
    OUT.write_text("\n".join(lines) + "\n")
    LICENSE_OUT.write_text((ROOT / "LICENSING.md").read_text() + "\n\n" + "=" * 78 + "\n\n" + (ROOT / "LICENSE.md").read_text())
    print(f"wrote {OUT.relative_to(ROOT)}: {len(npm)} npm, {len(rust)} cargo, "
          f"{len(missing)} without a licence file, {OUT.stat().st_size // 1024} KB")


if __name__ == "__main__":
    main()
