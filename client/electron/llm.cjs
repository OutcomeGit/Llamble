// Local llama.cpp manager: detects GPUs, runs llama-server pinned to the chosen card,
// and streams chat completions for jobs the Parley server hands to this PC.
const { execFile, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

let proc = null;
let status = { state: "off", error: null, port: null, url: null, model: null };
let logLines = [];
const jobs = new Map(); // job_id -> AbortController
let emit = () => {};

function setStatus(patch) {
  status = { ...status, ...patch };
  emit("llm-status", status);
}

function log(line) {
  for (const l of String(line).split(/\r?\n/)) {
    if (!l.trim()) continue;
    logLines.push(l);
    if (logLines.length > 300) logLines.shift();
  }
  emit("llm-log", logLines.slice(-80));
}

function run(cmd, args, timeout = 8000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true }, (err, stdout) => resolve(err ? null : String(stdout)));
  });
}

async function detectGpus(app) {
  const gpus = [];
  const smi = await run("nvidia-smi", ["--query-gpu=index,name,memory.total", "--format=csv,noheader,nounits"]);
  if (smi) {
    for (const line of smi.trim().split(/\r?\n/)) {
      const [index, name, mem] = line.split(",").map((s) => s.trim());
      if (name) gpus.push({ index: Number(index), name, vram_mb: Number(mem) || 0, vendor: "nvidia" });
    }
  }
  if (!gpus.length && process.platform === "win32") {
    const ps = await run("powershell.exe", [
      "-NoProfile", "-Command",
      "Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM | ConvertTo-Json -Compress",
    ]);
    try {
      let arr = JSON.parse(ps || "[]");
      if (!Array.isArray(arr)) arr = [arr];
      arr.forEach((g, i) => {
        const name = g.Name || "GPU";
        const vendor = /nvidia/i.test(name) ? "nvidia" : /amd|radeon/i.test(name) ? "amd" : /intel/i.test(name) ? "intel" : "other";
        gpus.push({ index: i, name, vram_mb: Math.round((g.AdapterRAM || 0) / 1048576), vendor, approximate: true });
      });
    } catch {}
  }
  if (!gpus.length && app) {
    try {
      const info = await app.getGPUInfo("basic");
      (info.gpuDevice || []).forEach((d, i) => gpus.push({ index: i, name: `GPU ${d.vendorId}:${d.deviceId}`, vram_mb: 0, vendor: "other" }));
    } catch {}
  }
  // best first: most VRAM, prefer discrete NVIDIA/AMD over integrated
  const score = (g) => g.vram_mb + (g.vendor === "nvidia" ? 1e6 : g.vendor === "amd" ? 5e5 : 0);
  gpus.sort((a, b) => score(b) - score(a));
  return gpus;
}

async function waitHealthy(url, p) {
  const started = Date.now();
  while (proc === p && Date.now() - started < 15 * 60 * 1000) {
    try {
      const r = await fetch(url + "/health");
      if (r.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

async function start(cfg) {
  await stop();
  logLines = [];
  if (cfg.mode === "external") {
    const url = String(cfg.externalUrl || "").replace(/\/+$/, "");
    if (!url) return setStatus({ state: "error", error: "Enter the llama-server URL" });
    setStatus({ state: "starting", error: null, url, model: cfg.modelName || "external" });
    try {
      const r = await fetch(url + "/health");
      if (!r.ok) throw new Error("health " + r.status);
      let model = cfg.modelName || "external";
      try {
        const m = await (await fetch(url + "/v1/models")).json();
        model = m?.data?.[0]?.id ? path.basename(m.data[0].id) : model;
      } catch {}
      setStatus({ state: "ready", model });
    } catch (e) {
      setStatus({ state: "error", error: "Can't reach " + url + " (" + e.message + ")" });
    }
    return status;
  }

  if (!cfg.serverPath || !fs.existsSync(cfg.serverPath)) return setStatus({ state: "error", error: "Pick your llama-server executable" });
  if (!cfg.modelPath || !fs.existsSync(cfg.modelPath)) return setStatus({ state: "error", error: "Pick a .gguf model file" });
  const port = Number(cfg.port) || 18080;
  const args = ["-m", cfg.modelPath, "-c", String(cfg.ctx || 8192), "-ngl", "999", "--host", "127.0.0.1", "--port", String(port)];
  if (cfg.jinja !== false) args.push("--jinja");
  if (cfg.flashAttn) args.push("-fa", "on");
  if (cfg.extraArgs) args.push(...String(cfg.extraArgs).match(/(?:[^\s"]+|"[^"]*")+/g).map((a) => a.replace(/^"|"$/g, "")));

  const env = { ...process.env };
  const gpu = cfg.gpu;
  if (gpu && gpu.vendor === "nvidia") env.CUDA_VISIBLE_DEVICES = String(gpu.index);
  if (gpu && gpu.vendor !== "nvidia" && gpu.index != null) env.GGML_VK_VISIBLE_DEVICES = String(gpu.index);

  log(`> ${path.basename(cfg.serverPath)} ${args.join(" ")}`);
  if (gpu) log(`> pinned to GPU ${gpu.index}: ${gpu.name}`);
  const url = `http://127.0.0.1:${port}`;
  setStatus({ state: "starting", error: null, port, url, model: path.basename(cfg.modelPath) });
  let p;
  try {
    p = spawn(cfg.serverPath, args, { env, windowsHide: true, cwd: path.dirname(cfg.serverPath) });
  } catch (e) {
    return setStatus({ state: "error", error: e.message });
  }
  proc = p;
  p.stdout.on("data", log);
  p.stderr.on("data", log);
  p.on("error", (e) => {
    if (proc === p) setStatus({ state: "error", error: e.message });
  });
  p.on("exit", (code) => {
    log(`llama-server exited (${code})`);
    if (proc === p) {
      proc = null;
      setStatus({ state: code === 0 || code === null ? "off" : "error", error: code ? `llama-server exited with code ${code} — see log` : null });
    }
  });
  const okay = await waitHealthy(url, p);
  if (okay && proc === p) setStatus({ state: "ready" });
  return status;
}

function killTree(p) {
  if (!p || p.exitCode !== null) return;
  if (process.platform === "win32") execFile("taskkill", ["/pid", String(p.pid), "/T", "/F"], { windowsHide: true }, () => {});
  else p.kill("SIGTERM");
}

async function stop() {
  for (const c of jobs.values()) c.abort();
  jobs.clear();
  const p = proc;
  proc = null;
  if (p) killTree(p);
  setStatus({ state: "off", error: null });
}

async function chat(job) {
  if (status.state !== "ready" || !status.url) {
    emit("llm-job", { job_id: job.job_id, type: "error", error: "local model not ready" });
    return;
  }
  const ctrl = new AbortController();
  jobs.set(job.job_id, ctrl);
  try {
    const res = await fetch(status.url + "/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: ctrl.signal,
      body: JSON.stringify({
        model: status.model || "local",
        messages: job.messages,
        stream: true,
        max_tokens: job.max_tokens || 1024,
        temperature: job.temperature ?? 0.7,
        cache_prompt: true,
      }),
    });
    if (!res.ok || !res.body) throw new Error(`llama-server returned ${res.status}`);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;
        try {
          const t = JSON.parse(data)?.choices?.[0]?.delta?.content;
          if (t) emit("llm-job", { job_id: job.job_id, type: "chunk", text: t });
        } catch {}
      }
    }
    emit("llm-job", { job_id: job.job_id, type: "done" });
  } catch (e) {
    emit("llm-job", { job_id: job.job_id, type: "error", error: e.name === "AbortError" ? "cancelled" : e.message });
  } finally {
    jobs.delete(job.job_id);
  }
}

module.exports = {
  init(sender) {
    emit = sender;
  },
  detectGpus,
  start,
  stop,
  chat,
  status: () => status,
  log: () => logLines.slice(-80),
};
