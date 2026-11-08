// Talks to llamble-helper.exe (client/native/llamble-helper, our own Rust code built with
// Microsoft's Windows bindings). It answers "windows" (open windows: title, program,
// install path) and "gpus" (graphics cards) with one JSON line each. One small process
// stays open while it's needed; no PowerShell.
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

let proc = null;
let buf = "";
const queue = []; // { cmd, resolve }
let busy = null;

function exePath() {
  const packaged = process.resourcesPath ? path.join(process.resourcesPath, "llamble-helper.exe") : "";
  if (packaged && fs.existsSync(packaged)) return packaged;
  const dev = path.join(__dirname, "..", "native", "llamble-helper", "target", "release", "llamble-helper.exe");
  return fs.existsSync(dev) ? dev : null;
}

function start() {
  if (proc) return proc;
  const exe = process.platform === "win32" ? exePath() : null;
  if (!exe) return null;
  proc = spawn(exe, [], { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
  buf = "";
  proc.stdout.setEncoding("utf8");
  proc.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      const b = busy;
      busy = null;
      if (b) {
        clearTimeout(b.timer);
        let v = null;
        try { v = JSON.parse(line); } catch {}
        b.resolve(v);
      }
      next();
    }
  });
  const gone = () => {
    proc = null;
    if (busy) { clearTimeout(busy.timer); busy.resolve(null); busy = null; }
    while (queue.length) queue.shift().resolve(null);
  };
  proc.on("exit", gone);
  proc.on("error", gone);
  return proc;
}

function next() {
  if (busy || !queue.length) return;
  const p = start();
  const job = queue.shift();
  if (!p) return job.resolve(null);
  busy = job;
  job.timer = setTimeout(() => {
    // stuck: restart it next time
    try { p.kill(); } catch {}
  }, 10000);
  try {
    p.stdin.write(job.cmd + "\n");
  } catch {
    busy = null;
    job.resolve(null);
  }
}

/** Ask the helper; resolves to the parsed answer, or null if it's unavailable. */
function ask(cmd) {
  return new Promise((resolve) => {
    queue.push({ cmd, resolve });
    next();
  });
}

function stop() {
  if (!proc) return;
  try { proc.stdin.end("exit\n"); } catch {}
  const p = proc;
  setTimeout(() => { try { p.kill(); } catch {} }, 1000);
  proc = null;
}

module.exports = { ask, stop, pid: () => (proc ? proc.pid : null), available: () => process.platform === "win32" && !!exePath() };
