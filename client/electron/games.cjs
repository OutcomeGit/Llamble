// Game detection (Windows). Every 15 s we list the windows that are open and pick out
// the ones that are games: anything running from a game store's install folder
// (Steam, Epic, GOG, Xbox, EA, Ubisoft, Riot), a few well-known games that live
// elsewhere (Roblox, Minecraft...), plus anything the person marked as a game.
// Launchers, updaters and crash reporters are ignored.
//
// The window list comes from llamble-helper.exe (our own small Rust program using
// Microsoft's Windows bindings): no PowerShell, a few MB, about a millisecond per check.
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

const helper = require("./helper.cjs");
let timer = null;
let current = [];
let send = () => {};
let file = null;
let custom = { enabled: true, games: {}, ignored: {} }; // exe -> name / exe -> true

function load(app) {
  file = path.join(app.getPath("userData"), "games.json");
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    custom = { enabled: j.enabled !== false, games: j.games || {}, ignored: j.ignored || {} };
  } catch {}
}
function save() {
  try {
    fs.writeFileSync(file, JSON.stringify(custom, null, 2));
  } catch {}
}

/** Open windows from llamble-helper.exe: [{ exe, path, title, hwnd }] (null if it couldn't answer). */
async function windows() {
  if (process.platform !== "win32") return [];
  const list = await helper.ask("windows");
  return Array.isArray(list) ? list : null;
}

function classify(w) {
  const exe = String(w.exe || "").toLowerCase();
  const p = String(w.path || "");
  if (!exe || custom.ignored[exe]) return null;
  if (custom.games[exe]) return custom.games[exe];
  if (exe === "javaw" && /^Minecraft/i.test(w.title || "")) return "Minecraft";
  if (KNOWN[exe]) return KNOWN[exe];
  if (NOT_GAMES.test(exe)) return null;
  for (const re of STORES) {
    const m = p.match(re);
    if (m) return m[1].replace(/[_]+/g, " ").trim();
  }
  return null;
}

async function poll() {
  if (!custom.enabled) return [];
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
      exe: String(w.exe || "").toLowerCase(),
      title: w.title || name,
      pid: w.pid || 0,
      // Electron's id for that window, so "Stream <game>" can pick it directly
      sourceId: w.hwnd ? `window:${w.hwnd}:0` : null,
    });
  }
  const before = JSON.stringify(current);
  current = found;
  if (JSON.stringify(found) !== before) send("games-update", found);
  return found;
}

function start() {
  if (timer) return;
  poll();
  timer = setInterval(poll, 15000);
}

function init(app, emit) {
  if (process.platform !== "win32") return;
  send = emit;
  load(app);
  if (custom.enabled) start();
}

function stop() {
  clearInterval(timer);
  timer = null;
}

/** Turn detection off completely: no checks at all, PowerShell closed. */
function setEnabled(on) {
  custom.enabled = !!on;
  save();
  if (on) start();
  else {
    stop();
    helper.stop();
    current = [];
    send("games-update", []);
  }
  return custom;
}

/** Open windows that aren't games, so the person can mark one ("this is a game"). */
async function running() {
  if (!custom.enabled) return [];
  const list = (await windows()) || [];
  const out = [];
  const seen = new Set();
  for (const w of list) {
    const exe = String(w.exe || "").toLowerCase();
    if (!exe || seen.has(exe) || ["llamble", "explorer", "applicationframehost", "textinputhost", "systemsettings"].includes(exe)) continue;
    seen.add(exe);
    out.push({ exe, title: w.title || exe, game: classify(w) });
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

module.exports = { init, stop, setEnabled, poll, running, mark, reset, custom: () => custom, current: () => current, classify };
