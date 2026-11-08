// Lends this PC's GPU to the server's AI bot (opt-in). The server picks the best
// available GPU among everyone lending. This PC is only "available" while its owner
// is away (idle) and the GPU isn't busy with something else (e.g. a game). While
// unavailable, llama-server is unloaded so the game gets all the VRAM back.
import { create } from "zustand";
import { sendGateway } from "./gateway";
import { onEvent, useStore } from "./store";
import type { Gpu, LlmStatus } from "./types";

export interface AiConfig {
  consent: boolean;
  enabled: boolean;
  mode: "managed" | "external";
  serverPath: string;
  modelPath: string;
  externalUrl: string;
  ctx: number;
  port: number;
  gpuIndex: number | null; // null = auto (best)
  jinja: boolean;
  flashAttn: boolean;
  extraArgs: string;
  idleOnly: boolean; // only lend while I'm away from the keyboard
  idleMinutes: number;
  pauseWhenBusy: boolean; // pause while the GPU is busy with something else (games)
  busyThreshold: number; // % utilization that counts as "busy"
}

const DEFAULTS: AiConfig = {
  consent: false,
  enabled: false,
  mode: "managed",
  serverPath: "",
  modelPath: "",
  externalUrl: "http://127.0.0.1:8080",
  ctx: 8192,
  port: 18080,
  gpuIndex: null,
  jinja: true,
  flashAttn: true,
  extraArgs: "",
  idleOnly: true,
  idleMinutes: 5,
  pauseWhenBusy: true,
  busyThreshold: 30,
};

export function loadAiConfig(): AiConfig {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem("llamble.ai") || "{}") };
  } catch {
    return DEFAULTS;
  }
}

export function saveAiConfig(c: AiConfig) {
  localStorage.setItem("llamble.ai", JSON.stringify(c));
  useAi.setState({ config: c });
  evaluate(); // apply idle/busy setting changes right away
}

interface AiState {
  available: boolean; // native bridge present
  config: AiConfig;
  gpus: Gpu[];
  status: LlmStatus;
  log: string[];
  registered: boolean;
  rejected: string | null;
  served: number;
  active: number;
  lendable: boolean; // currently offered to the server
  pauseReason: string | null; // why we're not lending right now
  idleSeconds: number;
  gpuUtil: number | null;
}

export const useAi = create<AiState>(() => ({
  available: !!window.llambleNative?.llm,
  config: loadAiConfig(),
  gpus: [],
  status: { state: "off", error: null, port: null, url: null, model: null },
  log: [],
  registered: false,
  rejected: null,
  served: 0,
  active: 0,
  lendable: false,
  pauseReason: null,
  idleSeconds: 0,
  gpuUtil: null,
}));

export function chosenGpu(s: AiState = useAi.getState()) {
  const { gpus, config } = s;
  if (config.gpuIndex != null) return gpus.find((g) => g.index === config.gpuIndex) ?? gpus[0];
  return gpus[0]; // sorted best-first
}

function gpuLabel(s: AiState) {
  const g = chosenGpu(s);
  return s.config.mode === "external" ? "external llama-server" : g?.name ?? "GPU";
}

function register() {
  const s = useAi.getState();
  if (!s.config.enabled || !s.config.consent || s.status.state !== "ready") return;
  if (useStore.getState().conn !== "open") return;
  sendGateway("worker_register", {
    gpu: gpuLabel(s),
    vram_mb: chosenGpu(s)?.vram_mb ?? 0,
    model: s.status.model ?? "",
    available: s.lendable,
    reason: s.pauseReason ?? "",
  });
}

function unregister() {
  sendGateway("worker_unregister");
  useAi.setState({ registered: false });
}

export async function refreshGpus() {
  const llm = window.llambleNative?.llm;
  if (!llm) return;
  useAi.setState({ gpus: await llm.gpus() });
}

let pausedByMonitor = false;

export async function startLocalModel() {
  const llm = window.llambleNative?.llm;
  if (!llm) return;
  const s = useAi.getState();
  if (!s.gpus.length && s.config.mode === "managed") await refreshGpus();
  pausedByMonitor = false;
  await llm.start({ ...s.config, gpu: chosenGpu() });
}

export async function stopLocalModel() {
  unregister();
  pausedByMonitor = false;
  await window.llambleNative?.llm.stop();
}

export async function setLending(on: boolean) {
  saveAiConfig({ ...useAi.getState().config, enabled: on });
  if (on) {
    if (useAi.getState().status.state === "ready") register();
    else {
      pausedByMonitor = true; // load the model once this PC is idle
      await evaluate();
    }
  } else {
    await stopLocalModel();
  }
}

// ---- idle / busy monitor ----
let unavailableSince: number | null = null;
let lastSent: string | null = null;

async function evaluate() {
  const llm = window.llambleNative?.llm;
  const s = useAi.getState();
  if (!llm || !s.config.enabled || !s.config.consent) return;
  const c = s.config;
  let sys = { idleSeconds: 0, locked: false, gpuUtil: null as number | null };
  try {
    sys = await llm.sysState(c.mode === "managed" ? chosenGpu()?.index ?? 0 : 0);
  } catch {}

  let reason: string | null = null;
  if (c.idleOnly && !sys.locked && sys.idleSeconds < c.idleMinutes * 60) {
    reason = "you're using this PC";
  }
  // GPU busy with something other than our own generation = probably a game
  const generating = s.active > 0 || s.status.state === "starting";
  if (!reason && c.pauseWhenBusy && !generating && sys.gpuUtil != null && sys.gpuUtil >= c.busyThreshold) {
    reason = `GPU busy (${sys.gpuUtil}%), likely a game`;
  }
  const lendable = !reason;
  useAi.setState({ lendable, pauseReason: reason, idleSeconds: sys.idleSeconds, gpuUtil: sys.gpuUtil });

  if (lendable) {
    unavailableSince = null;
    if (pausedByMonitor && s.status.state === "off") {
      await startLocalModel(); // reload; registers again once ready
      return;
    }
  } else {
    unavailableSince ??= Date.now();
    // after 30s of being unavailable, unload the model to give the VRAM back
    if (c.mode === "managed" && s.status.state === "ready" && s.active === 0 && Date.now() - unavailableSince > 30_000) {
      unregister();
      await llm.stop();
      pausedByMonitor = true;
      lastSent = null;
      return;
    }
  }
  const key = `${lendable}|${reason}`;
  if (useAi.getState().registered && key !== lastSent) {
    sendGateway("worker_status", { available: lendable, reason: reason ?? "" });
    lastSent = key;
  }
}

let started = false;
export function initAiWorker() {
  const llm = window.llambleNative?.llm;
  if (!llm || started) return;
  started = true;

  llm.status().then(({ status, log }) => useAi.setState({ status, log }));
  refreshGpus();

  llm.on((kind, d) => {
    if (kind === "status") {
      const prev = useAi.getState().status.state;
      useAi.setState({ status: d });
      if (d.state === "ready" && prev !== "ready") {
        lastSent = null;
        evaluate().then(register);
      }
      if (d.state !== "ready" && prev === "ready" && !pausedByMonitor) unregister();
    } else if (kind === "log") {
      useAi.setState({ log: d });
    } else if (kind === "job") {
      if (d.type === "chunk") sendGateway("job_chunk", { job_id: d.job_id, text: d.text });
      else if (d.type === "tool_calls") sendGateway("job_tools", { job_id: d.job_id, calls: d.calls });
      else if (d.type === "done") {
        sendGateway("job_done", { job_id: d.job_id });
        useAi.setState((s) => ({ served: s.served + 1, active: Math.max(0, s.active - 1) }));
      } else {
        sendGateway("job_error", { job_id: d.job_id, error: d.error });
        useAi.setState((s) => ({ active: Math.max(0, s.active - 1) }));
      }
    }
  });

  onEvent((t, d) => {
    if (t === "READY") {
      lastSent = null;
      register(); // (re)connected
    }
    if (t === "WORKER_ACCEPTED") useAi.setState({ registered: true, rejected: null });
    if (t === "WORKER_REJECTED") useAi.setState({ registered: false, rejected: d.reason });
    if (t === "BOT_JOB") {
      useAi.setState((s) => ({ active: s.active + 1 }));
      llm.chat(d);
    }
  });

  setInterval(evaluate, 15_000);
  const c = useAi.getState().config;
  if (c.consent && c.enabled) {
    pausedByMonitor = true; // start once idle (or right away if idle-only is off)
    evaluate();
  }
}
