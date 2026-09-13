// wc — the website's stand-in for widget/preload.cjs. renderer.js draws whatever window.wc hands it;
// on the desktop that came from Electron's main process, here it comes from:
//   · Firestore — the views the GitHub Actions job publishes every ~5 minutes (slates, match views,
//     tables, builder menus, and the owner-only cards + records), pushed to the page as they change
//   · the Vercel live functions — a fresh match view for a game that's live or about to be, polled
//     like the widget did (30 s live, 2 min at the break), because the cron runs late
// Google sign-in unlocks the owner's records and cards and lets the builder queue slips.
//
// Every competition in site-config.js is read at once: the Matchday calendar shows all their games,
// each tagged with its league. Match, Builder, Table and Record follow one "active" competition —
// the one of the game you open, or the pill you pick (?c=<code>, remembered). On a Champions League
// week (Monday–Thursday of a week with UCL games) the site opens on the Champions League unless the
// URL names a competition, and the payload's `uclWeek` lets the renderer lead with it.

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import { getAuth, onAuthStateChanged, GoogleAuthProvider, signInWithPopup, signOut } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import { getFirestore, doc, onSnapshot, getDoc, addDoc, collection, serverTimestamp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";
import { COMPETITIONS, LIVE_BASE } from "./site-config.js";

const saved = {
  get(k) { try { return localStorage.getItem(`futbol.${k}`); } catch { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem(`futbol.${k}`) : localStorage.setItem(`futbol.${k}`, v); } catch { /* private window */ } },
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const byCode = Object.fromEntries(COMPETITIONS.map((c) => [c.code, c]));
const refIn = (code, ...path) => doc(db, "competitions", byCode[code].key, ...path);
const parse = (snap) => (snap.exists() ? JSON.parse(snap.get("json")) : null);
const MIN = 60e3;
// the Vercel-hosted copy calls its own functions; GitHub Pages and localhost call them cross-origin
const liveUrlFor = (code) => (location.hostname.endsWith(".vercel.app") ? `/api/live/${code}` : `${LIVE_BASE}/${code}`);

// ── the active competition ───────────────────────────────────────────────────
const urlComp = new URLSearchParams(location.search).get("c");
let active = byCode[urlComp] ? urlComp : null; // otherwise decided once every slate has answered
function setActive(code, { remember = true } = {}) {
  if (!byCode[code] || active === code) return;
  active = code;
  if (remember) {
    saved.set("comp", code);
    const url = new URL(location.href);
    url.searchParams.set("c", code);
    history.replaceState(null, "", url);
  }
  paintComps();
}

// the switcher: every competition as a pill; in compact mode only the active one shows and a click
// moves on to the next
function paintComps() {
  const box = document.getElementById("comps");
  if (!box) return;
  if (!box.childElementCount) {
    for (const c of COMPETITIONS) {
      const b = document.createElement("button");
      b.className = "tab comp";
      b.dataset.code = c.code;
      b.textContent = c.short;
      b.addEventListener("click", () => {
        const compact = document.getElementById("app")?.classList.contains("compact");
        const i = COMPETITIONS.findIndex((x) => x.code === active);
        const next = c.code !== active ? c.code : compact ? COMPETITIONS[(i + 1) % COMPETITIONS.length].code : null;
        if (next && next !== active) switchComp(next);
      });
      box.appendChild(b);
    }
  }
  for (const b of box.children) {
    const on = b.dataset.code === active;
    b.classList.toggle("active", on);
    b.title = on ? `${byCode[b.dataset.code].name} (showing)` : `Switch to the ${byCode[b.dataset.code].name}`;
  }
}

// ── auth ─────────────────────────────────────────────────────────────────────
let user = null;
let authResolved = false;
const authReady = new Promise((resolve) => {
  onAuthStateChanged(auth, (u) => {
    // the renderer caches the card and record once fetched, so a sign-in/out after load starts clean
    if (authResolved && (u?.uid || null) !== (user?.uid || null)) { location.reload(); return; }
    user = u; authResolved = true;
    paintAuth();
    resolve();
  });
});
function paintAuth() {
  const btn = document.getElementById("btn-auth");
  if (!btn) return;
  btn.textContent = user ? (user.displayName || user.email || "Signed in").split(" ")[0] : "Sign in";
  btn.title = user ? `Signed in as ${user.email} · click to sign out` : "Sign in to see your record and track slips";
}
document.addEventListener("click", (e) => {
  if (!e.target.closest?.("#btn-auth")) return;
  if (user) signOut(auth);
  else signInWithPopup(auth, new GoogleAuthProvider()).catch((err) => console.warn("sign-in:", err.code || err.message));
});
const notEnrolled = () => `${user.email} isn't enrolled as the owner (uid ${user.uid})`;

// one owner-only view of the active competition: signed out → a prompt, not enrolled → says so
async function privateView(name, what) {
  await authReady;
  if (!user) return { error: `sign in (top right) to see ${what}` };
  try {
    return parse(await getDoc(refIn(active, "private", name))) || { error: `no ${what} published yet` };
  } catch (e) {
    return { error: e.code === "permission-denied" ? notEnrolled() : e.message };
  }
}
async function publicView(name, missing) {
  try { return parse(await getDoc(refIn(active, "view", name))) || { error: missing }; }
  catch (e) { return { error: e.message }; }
}

// ── the slates: every competition, merged ─────────────────────────────────────
const slates = {}; // code → { matches, comp } | null when nothing is published
const allAnswered = () => COMPETITIONS.every((c) => c.code in slates);
const rows = () => COMPETITIONS.flatMap((c) => slates[c.code]?.matches || []);
const soonest = (list) => list.filter((m) => m.state === "pre").sort((a, b) => Date.parse(a.date) - Date.parse(b.date))[0];

// Monday–Thursday of a week with Champions League games → { label } for the banner, else null
function uclWeek() {
  const ucl = slates.ucl?.matches || [];
  const now = new Date(), dow = (now.getDay() + 6) % 7; // Monday = 0
  if (!ucl.length || dow > 3) return null;
  const monday = new Date(now); monday.setHours(0, 0, 0, 0); monday.setDate(monday.getDate() - dow);
  const friday = new Date(monday); friday.setDate(monday.getDate() + 4);
  const games = ucl.filter((m) => { const t = new Date(m.date); return t >= monday && t < friday; });
  if (!games.length) return null;
  const days = [...new Set(games.map((m) => new Date(m.date).toDateString()))].map((s) => new Date(s)).sort((a, b) => a - b);
  const f = (d) => d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
  return { label: `${days.length > 1 ? `${f(days[0])} – ${f(days[days.length - 1])}` : f(days[0])} · ${games.length} games` };
}

for (const c of COMPETITIONS) {
  onSnapshot(refIn(c.code, "view", "slate"), (snap) => {
    const d = parse(snap);
    slates[c.code] = d ? { matches: (d.matches || []).map((m) => ({ ...m, compCode: c.code, compShort: c.short, compName: c.name, compKey: c.key })), comp: d.comp || null } : null;
    onSlates();
  }, () => {
    if (!(c.code in slates)) slates[c.code] = null;
    onSlates();
  });
}
function onSlates() {
  if (!allAnswered()) return;
  if (!active) {
    const remembered = byCode[saved.get("comp")] ? saved.get("comp") : null;
    setActive(uclWeek() && byCode.ucl ? "ucl" : remembered || COMPETITIONS[0].code, { remember: false });
  }
  const want = pick();
  if (String(want?.id ?? "") !== String(cur.id ?? "")) select(want);
  else push();
}

// ── the tracked match ────────────────────────────────────────────────────────
let onUpdate = null;
let query = saved.get("query");
let cur = { id: null };

// the saved pick, else a live game (active competition first), else the active competition's soonest
function pick() {
  const all = rows();
  if (query) { const q = all.find((m) => String(m.id) === query); if (q) return q; }
  const mine = all.filter((m) => m.compCode === active);
  return mine.find((m) => m.live) || all.find((m) => m.live) || soonest(mine) || mine[mine.length - 1] || soonest(all) || all[0] || null;
}
function switchComp(code) {
  setActive(code);
  query = null;
  saved.set("query", null);
  const mine = rows().filter((m) => m.compCode === code);
  select(mine.find((m) => m.live) || soonest(mine) || mine[mine.length - 1] || null);
  push();
}

// live, kicking off within 90 minutes, or finished within the last ~2.5 hours of kickoff+play
function wantsLive(m) {
  const kick = Date.parse(m.date), now = Date.now();
  return m.state === "in" || (m.state === "pre" && kick - now < 90 * MIN) || (m.state === "post" && now - kick < 150 * MIN);
}

function push() {
  if (!onUpdate || !allAnswered()) return;
  const all = rows().sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
  if (!all.length) { onUpdate({ error: "nothing published yet — the data job runs every 5 minutes", matches: [], comp: null }); return; }
  if (cur.id && !cur.loaded) return; // don't flash an empty match while its view is on the way
  const useLive = cur.live && cur.liveAt >= (cur.snapAt || 0);
  onUpdate({ match: (useLive ? cur.live : cur.snap) || null, matches: all, comp: slates[active]?.comp || null, uclWeek: uclWeek() });
}

function select(row) {
  const id = row ? String(row.id) : null;
  if (cur.id === id) { push(); return; }
  // opening a game makes its competition the active one (not remembered: a pill pick is). Only on a
  // new game, so a league opened from Matchday's "Table" isn't undone by the next slate update
  if (row && row.compCode !== active) setActive(row.compCode, { remember: false });
  cur.unsub?.();
  clearTimeout(cur.timer);
  cur = { id, code: row?.compCode || active, snap: null, snapAt: 0, live: null, liveAt: 0, loaded: !id, forced: false, unsub: null, timer: null };
  if (!id) { push(); return; }
  const code = cur.code;
  cur.unsub = onSnapshot(refIn(code, "games", id), (snap) => {
    if (cur.id !== id) return;
    cur.snap = parse(snap)?.match || null;
    cur.snapAt = snap.exists() ? (snap.get("publishedAt")?.toMillis?.() || Date.now()) : 0;
    // a game the job hasn't built yet (far-off fixture): ask the live function once
    if (!cur.snap && !cur.forced) { cur.forced = true; poll(id, true); return; }
    cur.loaded = true;
    push();
  }, () => { cur.loaded = true; push(); });
  poll(id);
}

async function poll(id, force = false) {
  clearTimeout(cur.timer);
  const m = rows().find((x) => String(x.id) === id);
  if (m && (force || wantsLive(m))) {
    try {
      const res = await fetch(`${liveUrlFor(m.compCode)}?q=${encodeURIComponent(id)}`);
      const j = await res.json();
      if (cur.id === id && j.match) { cur.live = j.match; cur.liveAt = j.at || Date.now(); }
    } catch { /* the Firestore view still stands */ }
    if (cur.id !== id) return;
    cur.loaded = true;
    push();
  }
  if (cur.id !== id) return;
  const shown = cur.live || cur.snap;
  const delay = !m || !wantsLive(m) ? 5 * MIN : shown?.halftime ? 2 * MIN : m.state === "in" ? 30e3 : MIN;
  cur.timer = setTimeout(() => poll(id), delay);
}

// ── the bridge renderer.js expects ───────────────────────────────────────────
let expanded = saved.get("expanded") != null ? saved.get("expanded") === "1" : innerWidth >= 700;
const amToDec = (ml) => (ml == null ? null : ml > 0 ? ml / 100 + 1 : 100 / -ml + 1);
const decToAm = (d) => (d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1)));

window.wc = {
  onUpdate: (cb) => { onUpdate = cb; push(); },
  onConfig: (cb) => setTimeout(() => cb({ expanded, pinned: false, query }), 0),
  setMatch: async (id) => {
    query = id ? String(id) : null;
    saved.set("query", query);
    if (allAnswered()) select(pick());
    return query;
  },
  // tonight's card across every competition: each one's singles and notes, the longest longshot
  getParlays: async () => {
    await authReady;
    if (!user) return { error: "sign in (top right) to see tonight's card" };
    let cards = [];
    for (const c of COMPETITIONS) {
      try {
        const d = parse(await getDoc(refIn(c.code, "private", "parlays")));
        if (d) cards.push([c, d]);
      } catch (e) {
        if (e.code === "permission-denied") return { error: notEnrolled() };
      }
    }
    if (!cards.length) return { error: "no card published yet" };
    const date = cards.map(([, d]) => d.date).sort().pop();
    cards = cards.filter(([, d]) => d.date === date);
    const multi = cards.length > 1;
    return {
      date, stake: cards[0][1].stake,
      singles: cards.flatMap(([, d]) => d.singles || []),
      notes: cards.flatMap(([c, d]) => (d.notes || []).map((n) => ({ ...n, text: multi ? `${c.short} · ${n.text}` : n.text }))),
      longshot: cards.map(([, d]) => d.longshot).filter(Boolean).sort((a, b) => (b.legs?.length || 0) - (a.legs?.length || 0))[0] || null,
    };
  },
  // make a competition the active one without changing the followed game (Matchday's "Table" link)
  setComp: async (code) => { setActive(code); push(); },
  getParlayMenu: () => publicView("menu", "the builder is published with the 10:00 card"),
  getStandings: () => publicView("standings", "the table hasn't been published yet"),
  getRecord: () => privateView("record", "the bet record"),
  // the slip is queued in the active competition; the next publisher run logs it and it settles like the card
  trackParlay: async (payload) => {
    await authReady;
    if (!user) return { error: "sign in with the owner account to track a slip" };
    try {
      await addDoc(collection(db, "competitions", byCode[active].key, "slips"), { payload: JSON.stringify(payload), uid: user.uid, createdAt: serverTimestamp() });
      const dec = (payload.legs || []).reduce((p, l) => p * (l.dec || amToDec(l.ml) || 1), 1);
      return { ok: true, queued: true, americanOdds: decToAm(dec) };
    } catch (e) {
      return { error: e.code === "permission-denied" ? "this account isn't enrolled as the owner" : e.message };
    }
  },
  toggleExpand: async () => { expanded = !expanded; saved.set("expanded", expanded ? "1" : "0"); return expanded; },
  togglePin: async () => false, // no always-on-top in a browser tab
  refresh: async () => { if (cur.id) poll(cur.id, true); },
  hide: async () => {},
  quit: async () => {},
};

// "Get app": the desktop installers from the latest GitHub release — the Windows setup file directly,
// the release page elsewhere (the Mac build comes in two architectures)
function paintDownload() {
  const a = document.getElementById("btn-download");
  if (!a) return;
  const latest = "https://github.com/chinmayp123/futbol-lab/releases/latest";
  a.href = /Windows/i.test(navigator.userAgent) ? `${latest}/download/Futbol-Lab-Setup.exe` : latest;
  a.title = /Windows/i.test(navigator.userAgent) ? "Download the Futbol Lab app for Windows" : "Download the Futbol Lab desktop app";
}

paintAuth();
paintComps();
paintDownload();
// renderer.js registers its callbacks as it loads, so it must run after window.wc exists
const script = document.createElement("script");
script.src = "renderer.js";
document.body.appendChild(script);
