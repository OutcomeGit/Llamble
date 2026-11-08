#!/usr/bin/env python3
# Stand-in for sherpa-onnx-offline-tts: writes a short WAV and logs the text it was asked to say.
import os, sys, wave
out = [a.split("=", 1)[1] for a in sys.argv if a.startswith("--output-filename=")][0]
text = [a for a in sys.argv[1:] if not a.startswith("--")][-1]
open(os.environ.get("FAKE_TTS_LOG", "/tmp/fake_tts.log"), "a").write(text + "\n")
w = wave.open(out, "wb"); w.setnchannels(1); w.setsampwidth(2); w.setframerate(24000); w.writeframes(b"\x01\x00" * 2400); w.close()
