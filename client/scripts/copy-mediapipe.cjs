// Copies MediaPipe's WebAssembly runtime into public/ so camera effects run fully
// offline from Llamble's own files (no Google CDN at runtime).
const fs = require("fs");
const path = require("path");
const src = path.join(__dirname, "..", "node_modules", "@mediapipe", "tasks-vision", "wasm");
const dst = path.join(__dirname, "..", "public", "mediapipe", "wasm");
fs.mkdirSync(dst, { recursive: true });
for (const f of ["vision_wasm_internal.js", "vision_wasm_internal.wasm"]) fs.copyFileSync(path.join(src, f), path.join(dst, f));
console.log("mediapipe runtime copied");
