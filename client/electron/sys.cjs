// Full paths to Windows' own tools. Starting "powershell.exe" by bare name lets
// Windows search the app's folder (and PATH) first, so a planted copy could run.
const path = require("path");
const root = process.env.SystemRoot || "C:\\Windows";
module.exports = {
  tar: path.join(root, "System32", "tar.exe"),
  taskkill: path.join(root, "System32", "taskkill.exe"),
  // NVIDIA's driver installs it in System32
  nvidiaSmi: process.platform === "win32" ? path.join(root, "System32", "nvidia-smi.exe") : "nvidia-smi",
};
