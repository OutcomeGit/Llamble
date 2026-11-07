// Lends this PC's GPU to the Parley bot (opt-in). Runs llama.cpp locally via the
// Electron main process and answers BOT_JOBs the server sends over the gateway.
import { create } from "zustand";
import { sendGateway } from "./gateway";
import { onEvent, useStore } from "./store";
import type { Gpu, LlmStatus } from "./types";

export interface AiConfig {
  consent: boolean; // user agreed to the disclosure
  enabled: boolean; // lend GPU when the app runs
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
};

export function loadAiConfig(): AiConfig {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem("parley.ai") || "{}") };
  } catch {
    return DEFAULTS;
  }
}

export function saveAiConfig(c: AiConfig) {
  localStorage.setItem("parley.ai", JSON.stringify(c));
  useAi.setState({ config: c });
}

interface AiState {
  available: boolean;
  config: AiConfig;
  gpus: Gpu[];
  status: LlmStatus;
  log: string[];
  registered: boolean;
  rejected: string | null;
  served: number;
  active: number;
}

export const useAi = create<AiState>(() => ({
  available: !!window.parleyNative?.llm,
  config: loadAiConfig(),
  gpus: [],
  status: { state: "off", error: null, port: null, url: null, model: null },
  log: [],
  registered: false,
  rejected: null,
  served: 0,
  active: 0,
}));

export function chosenGpu(s: AiState = useAi.getState()): Gpu | undefined {
  const { gpus, config } = s;
  if (config.gpuIndex != null) return gpus.find((g) => g.index === config.gpuIndex) ?? gpus[0];
  return gpus[0]; // already sorted best-first
}

function register() {
  const s = useAi.getState();
  if (!s.config.enabled || !s.config.consent || s.status.state !== "ready") return;
  if (useStore.getState().conn !== "open") return;
  const g = chosenGpu(s);
  sendGateway("worker_register", {
    gpu: s.config.mode === "external" ? "external llama-server" : g?.name ?? "GPU",
    vram_mb: g?.vram_mb ?? 0,
    model: s.status.model ?? "",
  });
}

function unregister() {
  sendGateway("worker_unregister");
  useAi.setState({ registered: false });
}

export async function refreshGpus() {
  const llm = window.parleyNative?.llm;
  if (!llm) return;
  const gpus = await llm.gpus();
  useAi.setState({ gpus });
}

export async function startLocalModel() {
  const llm = window.parleyNative?.llm;
  if (!llm) return;
  const s = useAi.getState();
  if (!s.gpus.length && s.config.mode === "managed") await refreshGpus();
  await llm.start({ ...s.config, gpu: chosenGpu() });
}

export async function stopLocalModel() {
  unregister();
  await window.parleyNative?.llm.stop();
}

export async function setLending(on: boolean) {
  const c = { ...useAi.getState().config, enabled: on };
  saveAiConfig(c);
  if (on) {
    if (useAi.getState().status.state === "ready") register();
    else await startLocalModel();
  } else {
    await stopLocalModel();
  }
}

let started = false;
export function initAiWorker() {
  const llm = window.parleyNative?.llm;
  if (!llm || started) return;
  started = true;

  llm.status().then(({ status, log }) => useAi.setState({ status, log }));
  refreshGpus();

  llm.on((kind, d) => {
    if (kind === "status") {
      const prev = useAi.getState().status.state;
      useAi.setState({ status: d });
      if (d.state === "ready" && prev !== "ready") register();
      if (d.state !== "ready" && prev === "ready") unregister();
    } else if (kind === "log") {
      useAi.setState({ log: d });
    } else if (kind === "job") {
      if (d.type === "chunk") sendGateway("job_chunk", { job_id: d.job_id, text: d.text });
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
    if (t === "READY") register(); // (re)connected
    if (t === "WORKER_ACCEPTED") useAi.setState({ registered: true, rejected: null });
    if (t === "WORKER_REJECTED") useAi.setState({ registered: false, rejected: d.reason });
    if (t === "BOT_JOB") {
      useAi.setState((s) => ({ active: s.active + 1 }));
      llm.chat(d);
    }
  });

  const c = useAi.getState().config;
  if (c.consent && c.enabled) startLocalModel();
}
