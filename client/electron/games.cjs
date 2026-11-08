// Game detection (Windows). Every 15 s we list the windows that are open and pick out
// the ones that are games: anything running from a game store's install folder
// (Steam, Epic, GOG, Xbox, EA, Ubisoft, Riot), a few well-known games that live
// elsewhere (Roblox, Minecraft...), plus anything the person marked as a game.
// Launchers, updaters and crash reporters are ignored.
//
// One PowerShell process stays open and is asked again each time, so this costs a
// few MB and a fraction of a second of CPU every 15 s instead of starting a new
// PowerShell each time.
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const STORES = [
  /\\steamapps\\common\\([^\\]+)\\/i,
  /\\Epic Games\\([^\\]+)\\/i,
  /\\GOG Galaxy\\Games\\([^\\]+)\\/i,
  /\\GOG Games\\([^\\]+)\\/i,
  /\\XboxGames\\([^\\]+)\\/i,
  /\\EA Games\\([^\\]+)\\/i,
  /\\Origin Games\\([^\\]+)\\/i,
  /\\Ubisoft Game Launcher\\games\\([^\\]+)\\/i,
  /\\Riot Games\\([^\\]+)\\/i,
  /\\Battle\.net\\Games\\([^\\]+)\\/i,
  /\\itch\\apps\\([^\\]+)\\/i,
];

// exe name (lowercase, no .exe) -> game name, for games that don't live in a store folder
const KNOWN = {
  robloxplayerbeta: "Roblox",
  "minecraft.windows": "Minecraft",
  minecraft: "Minecraft",
  wow: "World of Warcraft",
  wowclassic: "World of Warcraft Classic",
  overwatch: "Overwatch 2",
  "diablo iv": "Diablo IV",
  "valorant-win64-shipping": "VALORANT",
  "league of legends": "League of Legends",
  "fortniteclient-win64-shipping": "Fortnite",
  "rocketleague": "Rocket League",
  "gta5": "Grand Theft Auto V",
  "r5apex": "Apex Legends",
  "cs2": "Counter-Strike 2",
};

const NOT_GAMES =
  /(launcher|crash|helper|updater|update|setup|unins|redist|anticheat|easyanticheat|beservice|webhelper|cefprocess|reporter|bootstrap|riotclient|epicgames|steam$|steamwebhelper|galaxyclient|eadesktop|origin$|upc$|uplay|battle\.net|agent$|overlay|vc_redist|dxsetup|unitycrashhandler)/i;

let ps = null;
let buf = "";
let pending = null;
let timer = null;
let current = [];
let send = () => {};
let file = null;
let custom = { games: {}, ignored: {} }; // exe -> name / exe -> true

function load(app) {
  file = path.join(app.getPath("userData"), "games.json");
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    custom = { games: j.games || {}, ignored: j.ignored || {} };
  } catch {}
}
function save() {
  try {
    fs.writeFileSync(file, JSON.stringify(custom, null, 2));
  } catch {}
}

function shell() {
  if (ps && !ps.killed && ps.exitCode === null) return ps;
  ps = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-NoLogo", "-Command", "-"], { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
  buf = "";
  ps.stdout.setEncoding("utf8");
  ps.stdout.on("data", (d) => {
    buf += d;
    const i = buf.indexOf("##LLAMBLE-END##");
    if (i >= 0) {
      const out = buf.slice(0, i);
      buf = buf.slice(i + 15);
      const p = pending;
      pending = null;
      if (p) p(out);
    }
  });
  ps.on("exit", () => {
    ps = null;
    if (pending) pending("");
    pending = null;
  });
  return ps;
}

const QUERY =
  "$ErrorActionPreference='SilentlyContinue'; " +
  "Get-Process | Where-Object { $_.MainWindowHandle -ne 0 } | " +
  "Select-Object Id,ProcessName,Path,MainWindowTitle,@{n='Hwnd';e={[int64]$_.MainWindowHandle}} | " +
  "ConvertTo-Json -Compress; Write-Output '##LLAMBLE-END##'\n";

function windows() {
  if (process.platform !== "win32") return Promise.resolve([]);
  if (pending) return Promise.resolve(null); // already asking
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      pending = null;
      try { ps && ps.kill(); } catch {}
      resolve([]);
    }, 10000);
    pending = (out) => {
      clearTimeout(t);
      try {
        let arr = JSON.parse(out.trim() || "[]");
        if (!Array.isArray(arr)) arr = [arr];
        resolve(arr);
      } catch {
        resolve([]);
      }
    };
    try {
      shell().stdin.write(QUERY);
    } catch {
      clearTimeout(t);
      pending = null;
      resolve([]);
    }
  });
}

function classify(w) {
  const exe = String(w.ProcessName || "").toLowerCase();
  const p = String(w.Path || "");
  if (!exe || custom.ignored[exe]) return null;
  if (custom.games[exe]) return custom.games[exe];
  if (exe === "javaw" && /^Minecraft/i.test(w.MainWindowTitle || "")) return "Minecraft";
  if (KNOWN[exe]) return KNOWN[exe];
  if (NOT_GAMES.test(exe)) return null;
  for (const re of STORES) {
    const m = p.match(re);
    if (m) return m[1].replace(/[_]+/g, " ").trim();
  }
  return null;
}

async function poll() {
  const list = await windows();
  if (!list) return current;
  const seen = new Set();
  const found = [];
  for (const w of list) {
    const name = classify(w);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    found.push({
      name,
      exe: String(w.ProcessName || "").toLowerCase(),
      title: w.MainWindowTitle || name,
      // Electron's id for that window, so "Stream <game>" can pick it directly
      sourceId: w.Hwnd ? `window:${w.Hwnd}:0` : null,
    });
  }
  const before = JSON.stringify(current);
  current = found;
  if (JSON.stringify(found) !== before) send("games-update", found);
  return found;
}

function init(app, emit) {
  if (process.platform !== "win32") return;
  send = emit;
  load(app);
  poll();
  timer = setInterval(poll, 15000);
}

function stop() {
  clearInterval(timer);
  try { ps && ps.stdin.end("exit\n"); } catch {}
  try { ps && ps.kill(); } catch {}
}

/** Open windows that aren't games, so the person can mark one ("this is a game"). */
async function running() {
  const list = (await windows()) || [];
  const out = [];
  const seen = new Set();
  for (const w of list) {
    const exe = String(w.ProcessName || "").toLowerCase();
    if (!exe || seen.has(exe) || ["llamble", "explorer", "applicationframehost", "textinputhost", "systemsettings"].includes(exe)) continue;
    seen.add(exe);
    out.push({ exe, title: w.MainWindowTitle || exe, game: classify(w) });
  }
  return out.sort((a, b) => a.title.localeCompare(b.title));
}

function mark(exe, name) {
  exe = String(exe || "").toLowerCase().replace(/\.exe$/, "");
  if (!exe) return custom;
  if (name) {
    custom.games[exe] = String(name).slice(0, 80);
    delete custom.ignored[exe];
  } else {
    delete custom.games[exe];
    custom.ignored[exe] = true;
  }
  save();
  poll();
  return custom;
}

function reset(exe) {
  exe = String(exe || "").toLowerCase();
  delete custom.games[exe];
  delete custom.ignored[exe];
  save();
  poll();
  return custom;
}

module.exports = { init, stop, poll, running, mark, reset, custom: () => custom, current: () => current, classify };
