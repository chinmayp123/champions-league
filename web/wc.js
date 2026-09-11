// wc — the website's stand-in for widget/preload.cjs. renderer.js draws whatever window.wc hands it;
// on the desktop that came from Electron's main process, here it comes from:
//   · Firestore — the views the GitHub Actions job publishes every ~5 minutes (slate, match views,
//     table, builder, and the owner-only card + record), pushed to the page as they change
//   · the Vercel live function — a fresh match view for a game that's live or about to be, polled
//     like the widget did (30 s live, 2 min at the break), because the cron runs late
// Google sign-in unlocks the owner's record and card and lets the builder queue slips.

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import { getAuth, onAuthStateChanged, GoogleAuthProvider, signInWithPopup, signOut } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import { getFirestore, doc, onSnapshot, getDoc, addDoc, collection, serverTimestamp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";
import { COMP_KEY, LIVE_API } from "./site-config.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const ref = (...path) => doc(db, "competitions", COMP_KEY, ...path);
const parse = (snap) => (snap.exists() ? JSON.parse(snap.get("json")) : null);
const MIN = 60e3;
// the Vercel-hosted copy calls its own function; GitHub Pages and localhost call it cross-origin
const liveUrl = location.hostname.endsWith(".vercel.app") ? "/api/state" : LIVE_API;

const saved = {
  get(k) { try { return localStorage.getItem(`starball.${k}`); } catch { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem(`starball.${k}`) : localStorage.setItem(`starball.${k}`, v); } catch { /* private window */ } },
};

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

// one owner-only view: signed out → a prompt, not enrolled → says so (with the uid to enrol)
async function privateView(name, what) {
  await authReady;
  if (!user) return { error: `sign in (top right) to see ${what}` };
  try {
    return parse(await getDoc(ref("private", name))) || { error: `no ${what} published yet` };
  } catch (e) {
    return { error: e.code === "permission-denied" ? `${user.email} isn't enrolled as the owner (uid ${user.uid})` : e.message };
  }
}
async function publicView(name, missing) {
  try { return parse(await getDoc(ref("view", name))) || { error: missing }; }
  catch (e) { return { error: e.message }; }
}

// ── the live push: slate + the tracked match ─────────────────────────────────
let onUpdate = null;
let slate = null, comp = null, slateMissing = false;
let query = saved.get("query");
let cur = { id: null };

// the same choice getWidgetState makes: the saved pick, else a live game, else the soonest upcoming
function pick(matches) {
  if (query && matches.some((m) => String(m.id) === query)) return query;
  const live = matches.find((m) => m.live);
  if (live) return String(live.id);
  const next = matches.filter((m) => m.state === "pre").sort((a, b) => Date.parse(a.date) - Date.parse(b.date))[0];
  const any = next || matches[0];
  return any ? String(any.id) : null;
}

// live, kicking off within 90 minutes, or finished within the last ~2.5 hours of kickoff+play
function wantsLive(m) {
  const kick = Date.parse(m.date), now = Date.now();
  return m.state === "in" || (m.state === "pre" && kick - now < 90 * MIN) || (m.state === "post" && now - kick < 150 * MIN);
}

function push() {
  if (!onUpdate) return;
  if (slateMissing) { onUpdate({ error: "nothing published yet — the data job runs every 5 minutes", matches: [], comp }); return; }
  if (!slate || !cur.loaded) return; // don't flash an empty match while its view is on the way
  const useLive = cur.live && cur.liveAt >= (cur.snapAt || 0);
  onUpdate({ match: (useLive ? cur.live : cur.snap) || null, matches: slate, comp });
}

function select(id) {
  if (cur.id === id) return;
  cur.unsub?.();
  clearTimeout(cur.timer);
  cur = { id, snap: null, snapAt: 0, live: null, liveAt: 0, loaded: !id, forced: false, unsub: null, timer: null };
  if (!id) { push(); return; }
  cur.unsub = onSnapshot(ref("games", id), (snap) => {
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
  const m = slate?.find((x) => String(x.id) === id);
  if (m && (force || wantsLive(m))) {
    try {
      const res = await fetch(`${liveUrl}?q=${encodeURIComponent(id)}`);
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

onSnapshot(ref("view", "slate"), (snap) => {
  const d = parse(snap);
  slateMissing = !d;
  if (d) { slate = d.matches || []; comp = d.comp || null; }
  const want = slate ? pick(slate) : null;
  if (want !== cur.id) select(want);
  else push();
}, (e) => { if (onUpdate) onUpdate({ error: e.message, matches: [], comp }); });

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
    if (slate) select(pick(slate));
    return query;
  },
  getParlays: () => privateView("parlays", "tonight's card"),
  getParlayMenu: () => publicView("menu", "the builder is published with the 10:00 card"),
  getStandings: () => publicView("standings", "the table hasn't been published yet"),
  getRecord: () => privateView("record", "the bet record"),
  // the slip is queued in Firestore; the next publisher run logs it and it settles like the card
  trackParlay: async (payload) => {
    await authReady;
    if (!user) return { error: "sign in with the owner account to track a slip" };
    try {
      await addDoc(collection(db, "competitions", COMP_KEY, "slips"), { payload: JSON.stringify(payload), uid: user.uid, createdAt: serverTimestamp() });
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

paintAuth();
// renderer.js registers its callbacks as it loads, so it must run after window.wc exists
const script = document.createElement("script");
script.src = "renderer.js";
document.body.appendChild(script);
