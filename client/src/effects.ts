// Full-screen chat effects: /confetti, /fireworks, /snow, /hearts, /balloons, /lasers, /shake.
// Played for everyone looking at the channel when the message arrives.
import confettiLib from "canvas-confetti";
import { Fireworks } from "fireworks-js";

export const EFFECTS: { name: string; emoji: string; desc: string }[] = [
  { name: "confetti", emoji: "🎉", desc: "Confetti for everyone" },
  { name: "fireworks", emoji: "🎆", desc: "Fireworks show" },
  { name: "snow", emoji: "❄️", desc: "Let it snow" },
  { name: "hearts", emoji: "💖", desc: "Shower of hearts" },
  { name: "balloons", emoji: "🎈", desc: "Balloons float up" },
  { name: "lasers", emoji: "🔦", desc: "Laser light show" },
  { name: "shake", emoji: "🫨", desc: "Shake the screen" },
];

/** Words that set off an effect by themselves (can be turned off in Settings → Notifications). */
const AUTO: [RegExp, string][] = [
  [/\bhappy\s+birthday\b|\bhbd\b/i, "confetti"],
  [/\bcongrat(s|ulations)\b/i, "confetti"],
  [/\bhappy\s+new\s+year\b/i, "fireworks"],
  [/\bi\s+love\s+you\b|\bily\b/i, "hearts"],
  [/\blet it snow\b|\bsnow day\b/i, "snow"],
];

export function autoEffect(text: string): string | null {
  if (localStorage.getItem("llamble.autoEffects") === "off") return null;
  for (const [re, fx] of AUTO) if (re.test(text)) return fx;
  return null;
}

export function effectsEnabled(): boolean {
  return localStorage.getItem("llamble.effects") !== "off";
}

/** "/confetti nice job" -> { effect: "confetti", text: "nice job" } */
export function parseEffectCommand(text: string): { effect: string; text: string } | null {
  const m = /^\/(\w+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!m) return null;
  const fx = EFFECTS.find((e) => e.name === m[1].toLowerCase());
  if (!fx) return null;
  return { effect: fx.name, text: (m[2] || "").trim() || fx.emoji };
}

// our own canvas, drawn on the main thread (the page's security policy blocks blob workers)
let fire: confettiLib.CreateTypes | null = null;
function confetti(o: confettiLib.Options) {
  if (!fire) {
    const c = document.createElement("canvas");
    c.className = "fx-canvas";
    document.body.appendChild(c);
    fire = confettiLib.create(c, { resize: true, useWorker: false });
  }
  return fire(o);
}
confetti.shapeFromText = (o: { text: string; scalar?: number }) => confettiLib.shapeFromText(o);

let busy = 0;
const reduceMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

export function playEffect(name: string) {
  if (!effectsEnabled() || reduceMotion()) return;
  // don't stack a pile of effects if a channel goes wild
  if (Date.now() - busy < 1200) return;
  busy = Date.now();
  switch (name) {
    case "confetti":
      return burstConfetti();
    case "fireworks":
      return fireworks();
    case "snow":
      return snow();
    case "hearts":
      return emojiRain(["💖", "💕", "❤️", "💗"]);
    case "balloons":
      return balloons();
    case "lasers":
      return lasers();
    case "shake":
      return shake();
  }
}

function burstConfetti() {
  const end = Date.now() + 1600;
  const colors = ["#5865f2", "#57f287", "#fee75c", "#eb459e", "#ed4245", "#ffffff"];
  confetti({ particleCount: 140, spread: 90, origin: { y: 0.65 }, colors, zIndex: 9999 });
  (function frame() {
    confetti({ particleCount: 4, angle: 60, spread: 60, origin: { x: 0, y: 0.7 }, colors, zIndex: 9999 });
    confetti({ particleCount: 4, angle: 120, spread: 60, origin: { x: 1, y: 0.7 }, colors, zIndex: 9999 });
    if (Date.now() < end) requestAnimationFrame(frame);
  })();
}

function layer(): HTMLDivElement {
  const d = document.createElement("div");
  d.className = "fx-layer";
  document.body.appendChild(d);
  return d;
}

function fireworks() {
  const d = layer();
  const fw = new Fireworks(d, { intensity: 28, explosion: 6, particles: 70, traceSpeed: 3, sound: { enabled: false } } as any);
  fw.start();
  setTimeout(() => fw.waitStop(true).then(() => d.remove()), 4500);
}

function snow() {
  const end = Date.now() + 4500;
  const flake = confetti.shapeFromText({ text: "❄️", scalar: 2 });
  (function frame() {
    confetti({ particleCount: 2, startVelocity: 0, ticks: 320, gravity: 0.35, drift: Math.random() - 0.5, origin: { x: Math.random(), y: -0.05 }, shapes: [flake, "circle"], colors: ["#ffffff", "#dfefff"], scalar: 1.4, zIndex: 9999 });
    if (Date.now() < end) requestAnimationFrame(frame);
  })();
}

function emojiRain(list: string[]) {
  const shapes = list.map((t) => confetti.shapeFromText({ text: t, scalar: 2.2 }));
  const end = Date.now() + 2200;
  (function frame() {
    confetti({ particleCount: 3, spread: 160, startVelocity: 25, ticks: 220, origin: { x: Math.random(), y: 0.95 }, angle: 90, shapes, scalar: 2.2, zIndex: 9999 });
    if (Date.now() < end) requestAnimationFrame(frame);
  })();
}

function balloons() {
  const d = layer();
  const colors = ["#ed4245", "#5865f2", "#57f287", "#fee75c", "#eb459e", "#f47b67"];
  for (let i = 0; i < 18; i++) {
    const b = document.createElement("div");
    b.className = "fx-balloon";
    b.style.left = Math.random() * 95 + "%";
    b.style.background = colors[i % colors.length];
    b.style.animationDelay = Math.random() * 1.2 + "s";
    b.style.animationDuration = 3.5 + Math.random() * 2 + "s";
    d.appendChild(b);
  }
  setTimeout(() => d.remove(), 7000);
}

function lasers() {
  const d = layer();
  d.classList.add("fx-lasers");
  for (let i = 0; i < 8; i++) {
    const l = document.createElement("div");
    l.className = "fx-laser";
    l.style.left = 5 + i * 12 + "%";
    l.style.background = ["#ff2a6d", "#05d9e8", "#57f287", "#fee75c"][i % 4];
    l.style.animationDelay = i * 0.07 + "s";
    d.appendChild(l);
  }
  setTimeout(() => d.remove(), 3600);
}

function shake() {
  const root = document.getElementById("root");
  if (!root) return;
  root.classList.remove("fx-shake");
  void root.offsetWidth;
  root.classList.add("fx-shake");
  setTimeout(() => root.classList.remove("fx-shake"), 900);
}
