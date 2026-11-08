// Copies the open-source noise suppressors (RNNoise, GTCRN, noise gate; package
// @sapphi-red/web-noise-suppressor, MIT, zero dependencies) into public/audio so they run
// from Llamble's own files, never a CDN.
const fs = require("fs");
const path = require("path");
const src = path.join(__dirname, "..", "node_modules", "@sapphi-red", "web-noise-suppressor", "dist");
const dst = path.join(__dirname, "..", "public", "audio");
fs.mkdirSync(dst, { recursive: true });
const files = {
  "rnnoise/workletProcessor.js": "rnnoiseWorklet.js",
  "gtcrn/workletProcessor.js": "gtcrnWorklet.js",
  "noiseGate/workletProcessor.js": "noiseGateWorklet.js",
  "rnnoise.wasm": "rnnoise.wasm",
  "rnnoise_simd.wasm": "rnnoise_simd.wasm",
  "gtcrn.wasm": "gtcrn.wasm",
};
for (const [from, to] of Object.entries(files)) fs.copyFileSync(path.join(src, from), path.join(dst, to));
console.log("noise suppressors copied");
