#!/usr/bin/env python3
# Stand-in for sherpa-onnx-offline: "recognizes" a WAV by its length using FAKE_STT_MAP
# (JSON {samples: text}), printing a JSON result line like the real tool.
import json, os, sys, wave
wav = [a for a in sys.argv[1:] if not a.startswith("--")][0]
for a in sys.argv[1:]:
    if a.startswith("--whisper-encoder="): assert os.path.exists(a.split("=", 1)[1]), "missing model"
n = wave.open(wav).getnframes()
text = json.load(open(os.environ["FAKE_STT_MAP"])).get(str(n), "")
print(wav, file=sys.stderr)
print(json.dumps({"lang": "", "text": " " + text, "tokens": []}), file=sys.stderr)
