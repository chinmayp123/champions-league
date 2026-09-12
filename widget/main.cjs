// Electron main process — the Futbol Lab desktop app: a frameless window around the website.
//
// Until v1.2 this widget ran the data layer itself: it polled lib.mjs, pushed JSON to renderer.js
// over IPC, and spent the user's own odds keys. The website now does all of that — every
// competition, the publisher's rationed odds quotas, the Firestore records, sign-in — so the app is
// the site in its own window: native title-bar buttons over the site's broadcast bar (Windows Snap
// Layouts still work), a tray icon, a remembered size and position, and start-with-Windows.
const { app, BrowserWindow, Menu, Tray, nativeImage, shell } = require("electron");
const path = require("path");
const fs = require("fs");

// the site this window shows. GitHub Pages is an authorized Google sign-in domain for the Firebase
// project; futbol-lab.vercel.app isn't yet (the owner is handling Firebase) — switch once it is.
const SITE = process.env.FUTBOL_SITE || "https://chinmayp123.github.io/futbol-lab/";
const SITE_ORIGIN = new URL(SITE).origin;
// popups that stay inside the app: Google sign-in through Firebase's auth domain
const IN_APP_POPUPS = [/^https:\/\/champions-league-a650f\.firebaseapp\.com\//, /^https:\/\/accounts\.google\.com\//, /^https:\/\/apis\.google\.com\//];
const MAC = process.platform === "darwin";

// Unpackaged Electron apps all share one profile folder ("Electron") unless they name themselves,
// which made the single-instance lock and window state collide with the user's other Electron
// projects. Name the app before anything touches userData so it gets its own folder.
app.setName("Futbol Lab");
if (!app.isPackaged) app.setPath("userData", path.join(app.getPath("appData"), "Futbol Lab"));
// the app was Starball Lab until September 2026: the first time the new folder is missing, carry the
// old one over (window position, the start-with-Windows choice)
try {
  const before = path.join(app.getPath("appData"), "Starball Lab");
  if (!fs.existsSync(app.getPath("userData")) && fs.existsSync(before)) fs.cpSync(before, app.getPath("userData"), { recursive: true });
} catch { /* start fresh */ }
// Google refuses to sign in from browsers that announce themselves as embedded apps; this is Chromium,
// so present as the Chrome it is
app.userAgentFallback = app.userAgentFallback.replace(/\s+(Electron|futbol-lab|Futbol Lab|starball-lab)\/\S+/gi, "");

// ── window state ─────────────────────────────────────────────────────────────
const STATE_FILE = path.join(app.getPath("userData"), "window-state.json");
function loadState() {
  const defaults = { x: null, y: null, width: 1280, height: 900, maximized: false, openAtLogin: false };
  try { return { ...defaults, ...JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) }; } catch { /* first run of v1.2 */ }
  // the old widget's state: keep where it sat and whether it started with Windows
  try {
    const old = JSON.parse(fs.readFileSync(path.join(app.getPath("userData"), "widget-state.json"), "utf8"));
    return { ...defaults, x: old.x ?? null, y: old.y ?? null, width: old.ew || defaults.width, height: old.eh || defaults.height, openAtLogin: !!old.openAtLogin };
  } catch { return defaults; }
}
let state = loadState();
function saveState(patch) {
  state = { ...state, ...patch };
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state)); } catch { /* best-effort */ }
}

// what the page needs inside the app: the broadcast bar drags the window (the site turns dragging
// off for browsers), no "Get app" button in the app itself, room for the macOS traffic lights
const APP_CSS = [
  "#titlebar { -webkit-app-region: drag !important; user-select: none !important; }",
  "#btn-download { display: none !important; }",
  MAC ? "#titlebar { padding-left: 84px !important; }" : "",
].join("\n");

let win = null;
let tray = null;
let retryTimer = null;

function createWindow() {
  win = new BrowserWindow({
    width: state.width, height: state.height,
    x: state.x ?? undefined, y: state.y ?? undefined,
    minWidth: 360, minHeight: 480,
    icon: path.join(__dirname, MAC ? "icon.png" : "icon.ico"),
    frame: false,
    // Windows Controls Overlay: native minimize / maximize / close over the site's 50px bar — it's
    // what makes Snap Layouts appear. macOS: the traffic lights sit inset in the bar instead.
    titleBarStyle: MAC ? "hiddenInset" : "hidden",
    titleBarOverlay: MAC ? undefined : { color: "#00000000", symbolColor: "#8f9ac4", height: 50 },
    backgroundColor: "#070b1f",
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.once("ready-to-show", () => { if (state.maximized) win.maximize(); win.show(); });
  win.loadURL(SITE);

  win.webContents.on("dom-ready", () => {
    if (win.webContents.getURL().startsWith(SITE_ORIGIN)) win.webContents.insertCSS(APP_CSS);
  });
  // sign-in popups open in a small app window; any other link opens in the user's browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (IN_APP_POPUPS.some((rx) => rx.test(url))) {
      return { action: "allow", overrideBrowserWindowOptions: { width: 500, height: 660, autoHideMenuBar: true, backgroundColor: "#ffffff" } };
    }
    shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith(SITE_ORIGIN) && !url.startsWith("data:")) { e.preventDefault(); shell.openExternal(url); }
  });
  // offline or the site is down: say so and try again
  win.webContents.on("did-fail-load", (_e, code, desc, _url, isMainFrame) => {
    if (!isMainFrame || code === -3) return; // -3: aborted because another navigation replaced it
    const html = `<body style="margin:0;height:100vh;display:grid;place-items:center;background:#070b1f;color:#c3cbe8;font:14px 'Segoe UI',system-ui,sans-serif;-webkit-app-region:drag"><div style="text-align:center"><div style="font:800 24px 'Segoe UI',system-ui,sans-serif;color:#fff;letter-spacing:.5px">FUTBOL <span style="color:#4f8dff">LAB</span></div><p>Couldn't reach the site (${String(desc).replace(/[<>&]/g, "")}).<br>Trying again in 15 seconds…</p></div></body>`;
    win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => { if (win && !win.isDestroyed()) win.loadURL(SITE); }, 15000);
  });

  win.on("close", () => {
    const b = win.getNormalBounds();
    saveState({ x: b.x, y: b.y, width: b.width, height: b.height, maximized: win.isMaximized() });
  });
  win.on("closed", () => { win = null; });
}

// bring the window back from hidden/minimized cleanly
function showWindow() {
  if (!win) return createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// register (or clear) the app as a login item. In dev this launches electron.exe with the app path;
// once packaged it points at the built exe.
function applyOpenAtLogin() {
  try {
    app.setLoginItemSettings({
      openAtLogin: !!state.openAtLogin,
      path: process.execPath,
      args: app.isPackaged ? [] : [path.resolve(__dirname, "main.cjs")],
    });
  } catch { /* not supported here */ }
}

function buildTray() {
  // the Futbol Lab mark, rasterised by widget/make-icon.mjs (tray@2x.png is picked up for HiDPI)
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, "tray.png")));
  tray.setToolTip("Futbol Lab");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Show / hide", click: () => { if (win?.isVisible()) win.hide(); else showWindow(); } },
    { label: "Reload", click: () => { if (win) win.loadURL(SITE); else showWindow(); } },
    { label: "Open in browser", click: () => shell.openExternal(SITE) },
    { type: "separator" },
    { label: "Start with Windows", type: "checkbox", checked: !!state.openAtLogin, visible: !MAC,
      click: (item) => { saveState({ openAtLogin: item.checked }); applyOpenAtLogin(); } },
    { type: "separator" },
    { label: "Quit", click: () => app.quit() },
  ]));
  tray.on("click", () => { if (win?.isVisible()) win.hide(); else showWindow(); });
}

// one identity for the taskbar group and the shortcut (otherwise it's "Electron")
app.setAppUserModelId("futbol-lab");
// one copy at a time: launching again brings the running one to the front
if (!app.requestSingleInstanceLock()) app.quit();
else app.on("second-instance", () => showWindow());
app.whenReady().then(() => {
  createWindow();
  buildTray();
  applyOpenAtLogin();
});
app.on("window-all-closed", () => { if (!MAC) app.quit(); });
app.on("activate", () => { if (!win) createWindow(); });
