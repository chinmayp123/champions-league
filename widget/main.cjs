// Electron main process — a frameless, always-on-top desktop widget around the shared
// data/model layer in ../lib.mjs. Main fetches + computes (Node, no CORS issues) and pushes
// plain JSON to the renderer, which draws the compact/full UI.
const { app, BrowserWindow, ipcMain, screen, Menu, Tray, nativeImage, Notification, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const { pathToFileURL } = require("url");

const STATE_FILE = path.join(app.getPath("userData"), "widget-state.json");
const DEFAULTS = { x: null, y: null, expanded: false, query: null, pinned: true, openAtLogin: true, ew: null, eh: null };
function loadState() {
  try { return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) }; }
  catch { return { ...DEFAULTS }; }
}
function saveState(patch) {
  state = { ...state, ...patch };
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state)); } catch {}
}
let state = loadState();

const COMPACT = { width: 300, height: 400 }; // two-row title bar (native caption overlay) + lower third + prediction
const EXPANDED = { width: 1180, height: 920 };
// the native caption overlay is as tall as the title bar's first row: 50px broadcast bar when
// expanded, the 38px logo row when compact
const overlayHeight = (expanded) => (expanded ? 50 : 38);
// the expanded size to use — the user's saved drag-size if they've resized, else the default
const expandedSize = () => ({ width: state.ew || EXPANDED.width, height: state.eh || EXPANDED.height });

let lib;       // lazily imported ESM module
let win;
let tray;
let timer;
let lastData = null;

// the user's files (odds.config.json with their keys, the bet log) live in Electron's per-user
// data folder once the app is installed — the repo itself while running from source
const DATA_DIR = app.isPackaged ? app.getPath("userData") : path.join(__dirname, "..");
process.env.STARBALL_DATA_DIR = DATA_DIR;

async function loadLib() {
  // dynamic import of an absolute path needs a file:// URL on Windows
  lib = await import(pathToFileURL(path.join(__dirname, "..", "lib.mjs")).href);
}

function createWindow() {
  const size = state.expanded ? expandedSize() : COMPACT;
  win = new BrowserWindow({
    width: size.width,
    height: size.height,
    icon: path.join(__dirname, process.platform === "win32" ? "icon.ico" : "icon.png"), // taskbar / Alt-Tab (Windows wants an .ico)
    minWidth: 260,
    minHeight: 220,
    x: state.x ?? undefined,
    y: state.y ?? undefined,
    frame: false,
    // Windows Controls Overlay: native min/max/close drawn over our title bar. It's what makes
    // Windows 11 Snap Layouts appear on hover (so several widgets can be tiled 2×2) — a plain
    // frameless window has no maximize button for the flyout to hang off. Transparent colour so
    // only the glyphs show over the glass bar; height matches .bar.
    // macOS: the traffic lights sit inset in our title bar instead of a caption overlay
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "hidden",
    titleBarOverlay: process.platform === "darwin" ? undefined : { color: "#00000000", symbolColor: "#8f9ac4", height: overlayHeight(state.expanded) },
    // opaque: the Broadcast shell paints its own navy, and an opaque window is what lets Windows
    // maximise it and hang the Snap Layouts flyout off the caption's maximise button
    transparent: false,
    resizable: true,
    maximizable: true,
    minimizable: true,  // native caption minimize; comes back from the taskbar or the tray
    alwaysOnTop: state.pinned,
    skipTaskbar: false,
    fullscreenable: false,
    backgroundColor: "#070b1f",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  if (state.pinned) win.setAlwaysOnTop(true, "screen-saver");
  win.loadFile(path.join(__dirname, "index.html"));

  // persist position when the user drags it
  win.on("moved", () => {
    const [x, y] = win.getPosition();
    saveState({ x, y });
  });
  // persist the expanded size when the user drag-resizes (so it stays put across launches);
  // ignore resizes while compact so the compact preset isn't overwritten
  win.on("resize", () => {
    const [w, h] = win.getSize();
    // a compact widget that gets snapped/dragged well past the compact preset (e.g. into a
    // Snap Layouts quadrant) flips to the expanded layout — the compact layout can't use the room
    if (!state.expanded) {
      if (w >= COMPACT.width + 120 || h >= COMPACT.height + 160) {
        saveState({ expanded: true, ew: w, eh: h });
        try { win.setTitleBarOverlay({ height: overlayHeight(true) }); } catch {}
        win.webContents.send("config", { expanded: true, pinned: state.pinned, query: state.query });
      }
      return;
    }
    saveState({ ew: w, eh: h });
  });
  // minimized widgets come back from the taskbar button, the tray, or a fresh data push (a
  // goal toast still fires while minimized — see notifyGoals)
  win.on("closed", () => { win = null; });

  // send the latest data once the page is ready
  win.webContents.on("did-finish-load", () => {
    win.webContents.send("config", { expanded: state.expanded, pinned: state.pinned, query: state.query, mac: process.platform === "darwin" });
    if (lastData) win.webContents.send("update", lastData);
  });
}

// Windows toast on goals / full time for the tracked match — the widget stays useful when it's
// buried behind other windows. Compares against the previous poll of the SAME match, so the
// first look at a game (or switching games) never fires a stale notification.
let lastScoreState = null; // { id, h, a, state }
function notifyGoals(m) {
  if (!m || !Notification.isSupported()) { lastScoreState = null; return; }
  const cur = { id: m.id, h: m.home?.score ?? null, a: m.away?.score ?? null, state: m.state };
  const prev = lastScoreState;
  lastScoreState = cur;
  if (!prev || prev.id !== cur.id || cur.state === "pre" || cur.h == null || prev.h == null) return;
  try {
    if (cur.h !== prev.h || cur.a !== prev.a) {
      new Notification({ title: `⚽ ${m.home.abbr} ${cur.h} – ${cur.a} ${m.away.abbr}`, body: m.statusText || "GOAL" }).show();
    } else if (prev.state === "in" && cur.state === "post") {
      new Notification({ title: `FT: ${m.home.abbr} ${cur.h} – ${cur.a} ${m.away.abbr}`, body: "Full time", silent: true }).show();
    }
  } catch { /* toasts are best-effort */ }
}

async function poll() {
  clearTimeout(timer);
  let nextDelay = 30000;
  try {
    const data = await lib.getWidgetState(state.query);
    lastData = data;
    notifyGoals(data.match);
    if (win && !win.isDestroyed()) win.webContents.send("update", data);
    if (data.match?.halftime) nextDelay = 120000;          // back off at the break
    else if (data.match?.state === "post" || !data.match) nextDelay = 60000;
  } catch (e) {
    if (win && !win.isDestroyed()) win.webContents.send("update", { error: String(e?.message || e), matches: [] });
  }
  // closing-line snapshot for pending bets near kickoff (CLV) — betlog throttles itself
  lib.captureClosing?.().catch(() => {});
  timer = setTimeout(poll, nextDelay);
}

// register (or clear) the widget as a Windows login item. In dev this launches electron.exe
// with the app path; once packaged it points at the built exe automatically.
function applyOpenAtLogin() {
  try {
    app.setLoginItemSettings({
      openAtLogin: !!state.openAtLogin,
      path: process.execPath,
      args: app.isPackaged ? [] : [path.resolve(__dirname, "main.cjs")], // installed: the exe alone
    });
  } catch {}
}

// bring the widget back from hidden/minimized cleanly
function showWidget() {
  if (!win) return createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function buildTray() {
  // the starball, rasterised by widget/make-icon.mjs (tray@2x.png is picked up for HiDPI)
  const img = nativeImage.createFromPath(path.join(__dirname, "tray.png"));
  tray = new Tray(img);
  tray.setToolTip("Starball Lab · Champions League");
  const menu = Menu.buildFromTemplate([
    { label: "Show / hide", click: () => { if (win?.isVisible()) win.hide(); else showWidget(); } },
    { label: "Refresh now", click: () => poll() },
    // where odds.config.json (optional API keys) and the bet log live
    { label: "Open data folder", click: () => shell.openPath(DATA_DIR) },
    { type: "separator" },
    {
      label: "Start with Windows", type: "checkbox", checked: !!state.openAtLogin,
      click: (item) => { saveState({ openAtLogin: item.checked }); applyOpenAtLogin(); },
    },
    { type: "separator" },
    { label: "Quit", click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
  tray.on("click", () => { if (win?.isVisible()) win.hide(); else showWidget(); });
}

// one identity for the taskbar group, toasts and the desktop shortcut (otherwise it's "Electron")
app.setAppUserModelId("starball-lab");
// one copy at a time: launching again just brings the running one to the front
if (!app.requestSingleInstanceLock()) app.quit();
else app.on("second-instance", () => showWidget());
app.whenReady().then(async () => {
  await loadLib();
  createWindow();
  buildTray();
  applyOpenAtLogin();
  poll();
});

// closing the window quits — a hidden-to-tray copy that lives on made every relaunch spawn a
// new instance on top of it. "Show / hide" in the tray menu is the way to tuck it away.
app.on("window-all-closed", () => app.quit());
app.on("activate", () => { if (!win) createWindow(); });

// --- IPC from the renderer ---
ipcMain.handle("set-match", (_e, query) => {
  saveState({ query: query || null });
  poll();
  return state.query;
});
ipcMain.handle("toggle-expand", () => {
  const expanded = !state.expanded;
  saveState({ expanded });
  const size = expanded ? expandedSize() : COMPACT;
  if (win) {
    win.setSize(size.width, size.height, true); // stays resizable so the user can drag it
    try { win.setTitleBarOverlay({ height: overlayHeight(expanded) }); } catch {}
  }
  return expanded;
});
ipcMain.handle("toggle-pin", () => {
  const pinned = !state.pinned;
  saveState({ pinned });
  if (win) win.setAlwaysOnTop(pinned, "screen-saver");
  return pinned;
});
// generate (or return cached) daily parlays for the Parlays view; never throws to the renderer
ipcMain.handle("get-parlays", async () => {
  try { return await lib.getDailyParlays(10); }
  catch (e) { return { error: String(e?.message || e) }; }
});
// upcoming games + priced candidate legs for the Parlay Builder; never throws to the renderer
ipcMain.handle("get-parlay-menu", async () => {
  try { return await lib.getParlayMenu(); }
  catch (e) { return { error: String(e?.message || e) }; }
});
// bet record + parlay history for the Record view; never throws to the renderer
ipcMain.handle("get-record", async () => {
  try { return await lib.getRecord(); }
  catch (e) { return { error: String(e?.message || e) }; }
});
// persist a user-built parlay from the Parlay Builder so it settles like the daily card
ipcMain.handle("track-parlay", async (_e, payload) => {
  try { return await lib.trackParlay(payload); }
  catch (e) { return { error: String(e?.message || e) }; }
});
// group standings + knockout bracket for the Standings view; never throws to the renderer
ipcMain.handle("get-standings", async () => {
  try { return await lib.getStandings(); }
  catch (e) { return { error: String(e?.message || e) }; }
});
ipcMain.handle("refresh", () => poll());
ipcMain.handle("hide", () => win?.hide()); // no longer wired to a button; tray menu uses win.hide() directly
ipcMain.handle("quit", () => app.quit());
