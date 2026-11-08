// Makes pictures on this PC's GPU for the chat (opt-in, part of "Lend My GPU").
// Downloads stable-diffusion.cpp (CUDA build for NVIDIA, Vulkan otherwise) and the picture
// model from Hugging Face once, then runs sd-cli for each picture.
const { app } = require("electron");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn, execFile } = require("child_process");

let emit = () => {};
let status = { state: "off", error: null, file: null, done: 0, total: 0, model: null };
function setStatus(p) {
  status = { ...status, ...p };
  emit("img-status", status);
}
const dir = () => path.join(app.getPath("userData"), "pictures");
const binDir = () => path.join(dir(), "bin");
const modelDir = (id) => path.join(dir(), "models", id);

function findExe(root) {
  if (!fs.existsSync(root)) return null;
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    const p = path.join(root, e.name);
    if (e.isDirectory()) {
      const f = findExe(p);
      if (f) return f;
    } else if (/^sd(-cli)?\.exe$/i.test(e.name)) return p;
  }
  return null;
}

async function download(url, dst, label) {
  const part = dst + ".part";
  let have = fs.existsSync(part) ? fs.statSync(part).size : 0;
  const res = await fetch(url, { headers: have ? { Range: `bytes=${have}-` } : {} });
  if (!res.ok && res.status !== 206) throw new Error(`${label}: download failed (${res.status})`);
  if (res.status !== 206) have = 0;
  const total = have + Number(res.headers.get("content-length") || 0);
  setStatus({ state: "downloading", file: label, done: have, total });
  const out = fs.createWriteStream(part, { flags: have ? "a" : "w" });
  const reader = res.body.getReader();
  let done = have;
  let last = 0;
  for (;;) {
    const { value, done: end } = await reader.read();
    if (end) break;
    if (!out.write(Buffer.from(value))) await new Promise((r) => out.once("drain", r));
    done += value.length;
    if (Date.now() - last > 500) {
      last = Date.now();
      setStatus({ done });
    }
  }
  await new Promise((r) => out.end(r));
  fs.renameSync(part, dst);
}

function unzip(zip, to) {
  return new Promise((resolve, reject) =>
    // Windows' own tar.exe (built in since Windows 10 1803) unzips; arguments go in as a list, never as command text
    execFile(require("./sys.cjs").tar, ["-xf", zip, "-C", to], { windowsHide: true }, (e) => (e ? reject(e) : resolve())),
  );
}

/** Get sd-cli (right build for the GPU) and the model files. */
async function prepare(cfg) {
  try {
    fs.mkdirSync(binDir(), { recursive: true });
    let exe = findExe(binDir());
    if (!exe) {
      setStatus({ state: "downloading", file: "stable-diffusion.cpp", error: null });
      const rel = await (await fetch("https://api.github.com/repos/leejet/stable-diffusion.cpp/releases/latest", { headers: { "User-Agent": "Llamble" } })).json();
      const assets = rel.assets || [];
      const nvidia = cfg.gpu?.vendor === "nvidia";
      const main = assets.find((a) => (nvidia ? /bin-win-cuda12-x64\.zip$/ : /bin-win-vulkan-x64\.zip$/).test(a.name));
      if (!main) throw new Error("couldn't find a Windows build of stable-diffusion.cpp");
      const zips = [main];
      if (nvidia) {
        const rt = assets.find((a) => /^cudart-sd-bin-win-cu12-x64\.zip$/.test(a.name));
        if (rt) zips.push(rt);
      }
      for (const a of zips) {
        const z = path.join(dir(), a.name);
        await download(a.browser_download_url, z, a.name);
        await unzip(z, binDir());
        fs.rmSync(z, { force: true });
      }
      exe = findExe(binDir());
      if (!exe) throw new Error("sd-cli.exe wasn't in the download");
    }
    const md = modelDir(cfg.model);
    fs.mkdirSync(md, { recursive: true });
    for (const f of cfg.files) {
      const dst = path.join(md, f.name);
      if (fs.existsSync(dst)) continue;
      await download(`https://huggingface.co/${f.repo}/resolve/main/${f.path}`, dst, f.path.split("/").pop());
    }
    setStatus({ state: "ready", error: null, file: null, model: cfg.model });
  } catch (e) {
    setStatus({ state: "error", error: e.message });
  }
  return status;
}

/** Draw one picture; returns the PNG bytes. */
async function generate(job, gpu) {
  const exe = findExe(binDir());
  const md = modelDir(job.model);
  if (!exe || !job.files.every((f) => fs.existsSync(path.join(md, f.name)))) {
    await prepare({ model: job.model, files: job.files, gpu });
    if (status.state !== "ready") throw new Error(status.error || "picture model not ready");
  }
  const out = path.join(os.tmpdir(), `llamble-${job.job_id}.png`);
  const args = [
    "--diffusion-model", path.join(md, "diffusion.gguf"),
    "--vae", path.join(md, "vae.safetensors"),
    "--llm", path.join(md, "text-encoder.gguf"),
    "--cfg-scale", String(job.cfg ?? 1), "--steps", String(job.steps ?? 4),
    "-W", String(job.width), "-H", String(job.height), "--seed", String(job.seed ?? -1),
    "-p", job.prompt, "-o", out,
  ];
  const env = { ...process.env };
  if (gpu?.vendor === "nvidia" && gpu.index != null) env.CUDA_VISIBLE_DEVICES = String(gpu.index);
  setStatus({ busy: true });
  try {
    await new Promise((resolve, reject) => {
      const p = spawn(findExe(binDir()), args, { cwd: path.dirname(exe), env, windowsHide: true });
      drawing = p;
      p.on("exit", () => { if (drawing === p) drawing = null; });
      let err = "";
      p.stderr.on("data", (d) => (err = (err + d).slice(-2000)));
      p.stdout.on("data", (d) => (err = (err + d).slice(-2000)));
      const t = setTimeout(() => p.kill(), 10 * 60 * 1000);
      p.on("error", reject);
      p.on("exit", (code) => {
        clearTimeout(t);
        code === 0 && fs.existsSync(out) ? resolve() : reject(new Error("drawing failed: " + err.trim().split("\n").slice(-2).join(" | ")));
      });
    });
    const png = fs.readFileSync(out);
    fs.rmSync(out, { force: true });
    return png;
  } finally {
    setStatus({ busy: false });
  }
}

let drawing = null;

module.exports = {
  pid: () => (drawing ? drawing.pid : null),
  init(sender) {
    emit = sender;
  },
  status: () => status,
  prepare,
  generate,
};
