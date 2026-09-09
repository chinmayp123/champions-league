// renderer — draws the widget from the plain JSON the main process sends. No data fetching
// here; main owns that. Built with createElement + textContent (CSP blocks inline, and we
// avoid innerHTML with API strings).
//
// Shell is parlay-lab's "Broadcast" system: a 50px title bar with text tabs, a lower-third +
// crawl above the page, ticket cards with the 5-cell number strip, a board + slip rail for the
// builder. Five views: matchday (landing: hero, the card, the slate) · match (the tracked game,
// every section) · builder · standings (table / bracket) · record.
const $ = (id) => document.getElementById(id);
const app = $("app");
const body = $("body");
const thirdEl = $("third");
const tickerEl = $("ticker");
const subEl = $("subtitle");
const roundEl = $("round");
const freshEl = $("fresh");

let expanded = false;
let pinned = true;
let viewMode = "matchday"; // "matchday" | "match" | "builder" | "standings" | "record"
let last = null;        // last data payload
let parlays = null;     // daily card (lazy, on opening matchday)
let record = null;      // bet record + history (lazy)
let standings = null;   // table + bracket (lazy)
let builder = null;     // parlay-builder menu (upcoming games + priced legs)
let builderGame = null; // id of the game the board shows
const builderSel = new Map(); // selected legs, keyed by game|market|pick → leg
let builderStake = 10;
let builderMsg = null;  // transient {ok, text} after tracking a built parlay
let showPast = false;   // matchday: previous-day results expanded?
let lastUpdateAt = 0;
let kickoffAt = 0;
let prevScoreKey = "";
let loadingMatch = false; // a pick was made and the data push hasn't landed yet
const nav = [];         // view history for the back button / Esc
// win-probability timeline: each data push appends the home side's live prob
const probHist = { id: null, pts: [] };
const PROB_HIST_MAX = 400;

// ── tiny DOM helpers ──────────────────────────────────────────────────────────
function h(tag, opts = {}, kids = []) {
  const el = document.createElement(tag);
  if (opts.class) el.className = opts.class;
  if (opts.text != null) el.textContent = opts.text;
  if (opts.title) el.title = opts.title;
  if (opts.onclick) el.addEventListener("click", opts.onclick);
  if (opts.style) for (const [k, v] of Object.entries(opts.style)) el.style.setProperty(k, v);
  for (const k of [].concat(kids)) if (k) el.appendChild(k);
  return el;
}
const frag = (kids) => { const f = document.createDocumentFragment(); for (const k of kids) if (k) f.appendChild(k); return f; };
const txt = (s) => document.createTextNode(s);
const fmtAm = (ml) => (ml == null ? "-" : ml > 0 ? `+${ml}` : `${ml}`);
const pctR = (p) => `${Math.round(p * 100)}%`;
const decToAm = (d) => (d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1)));
const fmtTime = (d) => new Date(d).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const fmtDay = (d) => new Date(d).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
const fmtMD = (d) => new Date(d).toLocaleDateString([], { month: "short", day: "numeric" });

// The Odds API book keys → readable names
const BOOKS = {
  fanduel: "FanDuel", draftkings: "DraftKings", betmgm: "BetMGM", williamhill_us: "Caesars",
  caesars: "Caesars", betrivers: "BetRivers", betonlineag: "BetOnline", bovada: "Bovada",
  mybookieag: "MyBookie", betus: "BetUS", lowvig: "LowVig", pointsbetus: "PointsBet",
  superbook: "SuperBook", espnbet: "ESPN BET", fanatics: "Fanatics", hardrockbet: "Hard Rock",
  unibet_us: "Unibet", betparx: "betPARX", wynnbet: "WynnBET", twinspires: "TwinSpires",
};
const bookName = (k) => BOOKS[k] || (k ? k.charAt(0).toUpperCase() + k.slice(1) : "");
const sideLabel = (side, m) => side === "draw" ? "Draw" : side === "home" ? m.home.abbr : m.away.abbr;

// ── crests ────────────────────────────────────────────────────────────────────
// ESPN serves 500px PNGs; downscaling those to 20px in one step looks muddy. Their image
// combiner resizes server-side, so ask for 2× the display size and let the box contain it.
const CREST_PX = { big: 96, "": 36, sm: 22, xs: 18 };
function crestSrc(url, px) {
  if (!url) return null;
  const m = String(url).match(/^https?:\/\/a\.espncdn\.com(\/i\/teamlogos\/[^?]+\.png)/);
  return m ? `https://a.espncdn.com/combiner/i?img=${encodeURIComponent(m[1])}&w=${px * 2}&h=${px * 2}` : url;
}
// FIFA code → ISO for the odd national-team fixture (flagcdn SVGs); clubs use the ESPN crest
const FIFA_ISO = {
  USA: "us", CAN: "ca", MEX: "mx", BRA: "br", ARG: "ar", URU: "uy", COL: "co", ECU: "ec", PAR: "py", PER: "pe", CHI: "cl",
  ENG: "gb-eng", SCO: "gb-sct", WAL: "gb-wls", NIR: "gb-nir", IRL: "ie", FRA: "fr", GER: "de", ESP: "es", POR: "pt", NED: "nl",
  BEL: "be", ITA: "it", CRO: "hr", SUI: "ch", SWE: "se", DEN: "dk", POL: "pl", AUT: "at", SRB: "rs", CZE: "cz", TUR: "tr",
  UKR: "ua", NOR: "no", GRE: "gr", MAR: "ma", SEN: "sn", TUN: "tn", ALG: "dz", EGY: "eg", NGA: "ng", JPN: "jp", KOR: "kr", AUS: "au",
};
function crest(abbr, logo, size = "") {
  const px = CREST_PX[size] ?? 36;
  let src = crestSrc(logo, px);
  if (!src) { const code = FIFA_ISO[(abbr || "").toUpperCase()]; if (code) src = `https://flagcdn.com/${code}.svg`; }
  if (!src) return null;
  const img = h("img", { class: `crest ${size}`.trim() });
  img.src = src; img.alt = ""; img.width = px; img.height = px; img.loading = "lazy";
  return img;
}
// crest by abbreviation alone (parlay legs only carry "AEK v LAS") — looked up in the slate
function crestFor(abbr, size = "sm") {
  const t = teamIndex().get(abbr);
  return crest(abbr, t ? t.logo : null, size);
}
function teamIndex() {
  const idx = new Map();
  for (const mt of last?.matches || []) {
    idx.set(mt.homeAbbr, { abbr: mt.homeAbbr, name: mt.home, logo: mt.homeLogo, color: mt.homeColor });
    idx.set(mt.awayAbbr, { abbr: mt.awayAbbr, name: mt.away, logo: mt.awayLogo, color: mt.awayColor });
  }
  for (const g of standings?.groups || []) for (const e of g.entries) if (!idx.has(e.abbr)) idx.set(e.abbr, { abbr: e.abbr, name: e.name, logo: e.logo, color: null });
  return idx;
}
const teamName = (abbr) => teamIndex().get(abbr)?.name || abbr;

// kit colours are picked for shirts, not dark UIs — lift dark ones until they read on navy
function ensureVisible(c) {
  let [r, g, b] = [(c) => c >> 16 & 255, (c) => c >> 8 & 255, (c) => c & 255].map((f) => f(parseInt((c || "4f8dff").replace("#", ""), 16)));
  for (let i = 0; i < 3 && (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.18; i++) { r += (255 - r) * 0.4; g += (255 - g) * 0.4; b += (255 - b) * 0.4; }
  const hex = (v) => Math.round(v).toString(16).padStart(2, "0");
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}
function colorClose(a, b) {
  const rgb = (c) => { const n = parseInt((c || "").replace("#", ""), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; };
  const [r1, g1, b1] = rgb(a), [r2, g2, b2] = rgb(b);
  return Math.hypot(r1 - r2, g1 - g2, b1 - b2) < 75;
}
// [home, away] display colours for a pair of kit colours, guarding against two similar kits
function kitPair(hc, ac, alt) {
  const home = ensureVisible(hc || "#4f8dff");
  let away = ensureVisible(ac || "#ff8fb3");
  if (colorClose(home, away)) away = alt && !colorClose(home, ensureVisible(alt)) ? ensureVisible(alt) : "#ff8fb3";
  return [home, away];
}

// ── title bar: tabs, back, search, pin, expand, freshness ────────────────────
const TABS = ["matchday", "match", "builder", "standings", "record"];
function syncBar() {
  for (const t of TABS) $(`tab-${t}`).classList.toggle("active", viewMode === t);
  $("btn-expand").classList.toggle("on", expanded);
  $("back").classList.toggle("off", !nav.length);
}
function fadeBody() { body.classList.remove("swap"); void body.offsetWidth; body.classList.add("swap"); }

// switch views; the previous view goes on the history stack so Esc / ◀ walks back
async function showView(mode, { push = true } = {}) {
  if (mode === viewMode) return;
  if (push) nav.push(viewMode);
  viewMode = mode;
  loadingMatch = false;
  if (mode === "builder") {
    builderMsg = null;
    if (!expanded) { expanded = await window.wc.toggleExpand(); applyMode(); } // needs room
  }
  if (mode === "standings" && !expanded && app.classList.contains("ko")) { expanded = await window.wc.toggleExpand(); applyMode(); }
  body.scrollTop = 0;
  fadeBody(); render();
  ensureData(mode);
}
function goBack() {
  if (!nav.length) return;
  const prev = nav.pop();
  showView(prev, { push: false });
}
// lazy fetches for the views that need something beyond the live push
async function ensureData(mode) {
  if (mode === "matchday" && !parlays) { parlays = await window.wc.getParlays(); if (viewMode === "matchday") render(); }
  if (mode === "builder" && !builder) { builder = await window.wc.getParlayMenu(); if (viewMode === "builder") render(); }
  if (mode === "record" && !record) { record = await window.wc.getRecord(); if (viewMode === "record") render(); }
  if (mode === "standings" && !standings) { standings = await window.wc.getStandings(); if (viewMode === "standings") render(); }
}
for (const t of TABS) $(`tab-${t}`).addEventListener("click", () => showView(t));
$("home").addEventListener("click", () => showView("matchday"));
$("back").addEventListener("click", goBack);
$("btn-expand").addEventListener("click", async () => { expanded = await window.wc.toggleExpand(); applyMode(); fadeBody(); render(); });
$("btn-pin").addEventListener("click", async () => { pinned = await window.wc.togglePin(); $("btn-pin").classList.toggle("on", pinned); });
document.addEventListener("keydown", (e) => {
  if (/input|select|textarea/i.test(document.activeElement?.tagName || "")) return;
  if (e.key === "Escape" || e.key === "Backspace" || (e.altKey && e.key === "ArrowLeft")) { e.preventDefault(); goBack(); }
});
function applyMode() { app.classList.toggle("expanded", expanded); app.classList.toggle("compact", !expanded); }

// freshness chip: data age, click to refresh; amber once it's over ~2.5 min old
function fmtCountdown(ms) {
  if (ms <= 0) return "any moment";
  const s = Math.floor(ms / 1000), d = Math.floor(s / 86400), hr = Math.floor((s % 86400) / 3600), mi = Math.floor((s % 3600) / 60);
  return d > 0 ? `${d}d ${hr}h` : hr > 0 ? `${hr}h ${mi}m` : `${mi}m ${s % 60}s`;
}
function tickFresh() {
  if (kickoffAt) { const el = $("kick-time"); if (el) el.textContent = fmtCountdown(kickoffAt - Date.now()); }
  if (!lastUpdateAt) { freshEl.hidden = true; return; }
  const s = Math.max(0, Math.round((Date.now() - lastUpdateAt) / 1000));
  const t = s < 5 ? "now" : s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`;
  freshEl.hidden = false; freshEl.textContent = t;
  freshEl.title = `Updated ${t === "now" ? "just now" : t + " ago"} · click to refresh`;
  freshEl.classList.toggle("stale", s > 150);
}
freshEl.addEventListener("click", () => { freshEl.textContent = "…"; window.wc.refresh(); });
setInterval(tickFresh, 1000);

// ── search: a team or a fixture, Enter opens it. "/" focuses the box ─────────
let qHits = [], qSel = 0;
function searchHits(q) {
  q = q.trim().toLowerCase();
  if (q.length < 2) return [];
  const hits = [];
  for (const t of teamIndex().values())
    if (t.abbr.toLowerCase().startsWith(q) || (t.name || "").toLowerCase().includes(q)) hits.push({ kind: "team", ...t });
  for (const mt of last?.matches || []) {
    const label = `${mt.homeAbbr} v ${mt.awayAbbr}`;
    if (label.toLowerCase().includes(q) || `${mt.home} v ${mt.away}`.toLowerCase().includes(q)) hits.push({ kind: "match", id: mt.id, label, mt });
  }
  return hits.slice(0, 8);
}
function renderHits() {
  const box = $("q-results");
  box.replaceChildren();
  box.hidden = !qHits.length;
  qHits.forEach((hit, i) => {
    const row = h("div", { class: "qhit" + (i === qSel ? " sel" : "") }, [
      hit.kind === "team" ? crest(hit.abbr, hit.logo, "sm") : crest(hit.mt.homeAbbr, hit.mt.homeLogo, "sm"),
      h("span", { class: "qname", text: hit.kind === "team" ? hit.name : hit.label }),
      h("span", { class: "qsub", text: hit.kind === "team" ? `${hit.abbr} · open next game` : (hit.mt.live ? "live" : hit.mt.state === "post" ? "FT" : fmtDay(hit.mt.date)) }),
    ]);
    row.addEventListener("mousedown", (e) => { e.preventDefault(); goHit(hit); });
    box.appendChild(row);
  });
}
// a team's most relevant fixture: live, else the soonest upcoming, else the latest finished
function teamGame(abbr) {
  const mine = (last?.matches || []).filter((mt) => mt.homeAbbr === abbr || mt.awayAbbr === abbr);
  return mine.find((mt) => mt.live)
    || mine.filter((mt) => mt.state === "pre").sort((a, b) => new Date(a.date) - new Date(b.date))[0]
    || mine.filter((mt) => mt.state === "post").sort((a, b) => new Date(b.date) - new Date(a.date))[0]
    || null;
}
function goHit(hit) {
  const inp = $("q"); inp.value = ""; inp.blur(); qHits = []; renderHits();
  if (hit.kind === "match") return choose(hit.id);
  const g = teamGame(hit.abbr);
  if (g) choose(g.id);
}
{
  const inp = $("q");
  inp.addEventListener("input", () => { qHits = searchHits(inp.value); qSel = 0; renderHits(); });
  inp.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { qSel = Math.min(qSel + 1, Math.max(qHits.length - 1, 0)); renderHits(); e.preventDefault(); }
    else if (e.key === "ArrowUp") { qSel = Math.max(qSel - 1, 0); renderHits(); e.preventDefault(); }
    else if (e.key === "Enter") { if (qHits[qSel]) goHit(qHits[qSel]); e.preventDefault(); }
    else if (e.key === "Escape") { inp.value = ""; qHits = []; renderHits(); inp.blur(); }
    e.stopPropagation();
  });
  inp.addEventListener("blur", () => setTimeout(() => { qHits = []; renderHits(); }, 120));
  document.addEventListener("keydown", (e) => {
    if (e.key === "/" && document.activeElement !== inp && !/input|select|textarea/i.test(document.activeElement?.tagName || "")) {
      if (!expanded) return; // no search box in compact
      e.preventDefault(); inp.focus();
    }
  });
}

// ── data pushes from main ─────────────────────────────────────────────────────
window.wc.onConfig((cfg) => {
  if (cfg.mac) app.classList.add("mac");
  expanded = !!cfg.expanded;
  pinned = !!cfg.pinned;
  $("btn-pin").classList.toggle("on", pinned);
  applyMode(); syncBar();
});
window.wc.onUpdate((data) => {
  last = data;
  lastUpdateAt = Date.now();
  loadingMatch = false;
  const m = data?.match;
  if (m && m.state !== "pre" && (m.advance || m.prediction)) {
    if (probHist.id !== m.id) { probHist.id = m.id; probHist.pts = []; }
    const p = m.advance ? m.advance.home : m.prediction.wH;
    if (m.state === "in" && p != null) { probHist.pts.push(p); if (probHist.pts.length > PROB_HIST_MAX) probHist.pts.shift(); }
  }
  tickFresh();
  render();
  if (viewMode === "matchday" && !parlays) ensureData("matchday");
});

// CSP-safe SVG sparkline
const SVGNS = "http://www.w3.org/2000/svg";
function sparkline(pts, { height = 56, cls = "", midline = null } = {}) {
  if (!pts || pts.length < 2) return null;
  const w = 100, min = Math.min(midline ?? Infinity, ...pts), max = Math.max(midline ?? -Infinity, ...pts);
  const span = max - min || 1;
  const x = (i) => (i / (pts.length - 1)) * w;
  const y = (v) => height - ((v - min) / span) * (height - 2) - 1;
  const svg = document.createElementNS(SVGNS, "svg");
  svg.setAttribute("viewBox", `0 0 ${w} ${height}`);
  svg.setAttribute("preserveAspectRatio", "none");
  svg.classList.add("spark-svg"); if (cls) svg.classList.add(cls);
  if (midline != null) {
    const z = document.createElementNS(SVGNS, "line");
    z.setAttribute("x1", "0"); z.setAttribute("x2", String(w)); z.setAttribute("y1", String(y(midline))); z.setAttribute("y2", String(y(midline)));
    z.classList.add("spark-zero"); svg.appendChild(z);
  }
  const poly = document.createElementNS(SVGNS, "polyline");
  poly.setAttribute("points", pts.map((v, i) => `${x(i).toFixed(2)},${y(v).toFixed(2)}`).join(" "));
  poly.classList.add("spark-line"); svg.appendChild(poly);
  return svg;
}
const spinner = (text) => h("div", { class: "center" }, [h("div", { class: "spinner" }), h("div", { text })]);
const emptyState = (text, hint) => frag([h("div", { class: "empty-ball" }), h("div", { class: "center", text }), hint ? h("div", { class: "center", text: hint, style: { "padding-top": "0", "font-size": "10px" } }) : null]);

// ── shell pieces: lower third, crawl, subtitle ────────────────────────────────
function setThird(kids, color) {
  thirdEl.replaceChildren(h("div", { class: "third-block" }), h("div", { class: "third-body" }, kids));
  thirdEl.style.setProperty("--tc", color || "var(--faint)");
  thirdEl.hidden = false;
}
function setTicker(items) {
  tickerEl.replaceChildren(...items.filter(Boolean).map((it) => h("span", { class: `tk ${it.cls || ""}`, text: it.text })));
  tickerEl.hidden = false;
}
const fact = (k, v, cls = "", onclick = null) => h("div", { class: `fact${onclick ? " click" : ""}`, onclick }, [h("span", { class: "fact-k", text: k }), h("span", { class: `fact-v ${cls}`, text: v })]);
const SRC_LINE = "ESPN · FotMob xG · FanDuel · OddsPapi · Action Network";

// ── render root ───────────────────────────────────────────────────────────────
const ROUND_SHORT = { "knockout-round-playoffs": "PO", "round-of-32": "R32", "round-of-16": "R16", quarterfinals: "QF", semifinals: "SF", "third-place": "3RD", "3rd-place-match": "3RD", final: "FINAL" };
const roundShort = (slug) => ((last && last.comp && last.comp.koShort) || {})[slug] || ROUND_SHORT[slug];
const compTitle = () => (last && last.comp && last.comp.title) || "Champions League 26/27";
const compName = () => (last && last.comp && last.comp.name) || "UEFA Champions League";

function render() {
  syncBar();
  const m = last?.match;
  const ko = !!(m && m.round && m.round.knockout);
  app.classList.toggle("ko", ko);
  const md = !ko && m && m.matchday;
  roundEl.hidden = !(ko || md);
  if (md) roundEl.textContent = `MD ${md}`;
  if (ko) roundEl.textContent = `${roundShort(m.round.slug) || m.round.label}${m.round.leg ? ` L${m.round.leg.n}` : ""}`;
  thirdEl.hidden = true; tickerEl.hidden = true;
  body.classList.remove("split-host");
  body.replaceChildren();
  switch (viewMode) {
    case "builder": body.appendChild(renderBuilder(builder)); return;
    case "record": body.appendChild(renderRecord(record)); return;
    case "standings": body.appendChild(renderStandings(standings)); return;
    case "matchday": body.appendChild(renderMatchday()); return;
  }
  // match view
  if (loadingMatch) { subEl.textContent = compName(); body.appendChild(spinner("Loading match…")); return; }
  if (!last) { subEl.textContent = compName(); body.appendChild(spinner("Fetching the slate…")); return; }
  if (last.error) { subEl.textContent = compTitle(); body.appendChild(h("div", { class: "center", text: `Couldn’t load: ${last.error}` })); return; }
  if (!last.match) { subEl.textContent = compTitle(); body.appendChild(emptyState("No match live right now.", "Pick a game from Matchday.")); return; }
  renderMatch(last.match);
}

// ── MATCHDAY: hero for the tracked game, the card, the slate ─────────────────
function renderMatchday() {
  subEl.textContent = `${compTitle()} · ${app.classList.contains("ko") ? "knockout" : "league phase"} · ${(last?.matches || []).filter((mt) => mt.live).length || "no"} live`;
  const wrap = h("div", { class: "matchday" });
  if (!last) { wrap.appendChild(spinner("Fetching the slate…")); return wrap; }
  const m = last.match;
  const matches = last.matches || [];

  if (m) wrap.appendChild(heroFor(m));
  else wrap.appendChild(emptyState("No match tracked.", "Tap a game below to follow it."));

  // tonight's card — the tracked singles + the for-fun longshot
  const head = h("div", { class: "today-head" }, [
    h("div", {}, [
      h("div", { class: "eyebrow", text: parlays && !parlays.error ? `Tonight's card · straight singles · $${parlays.stake} each` : "Tonight's card" }),
      h("div", { class: "vh" }, [txt("The card "), h("span", { class: "sub", text: parlays && parlays.singles ? `${parlays.singles.length} single${parlays.singles.length === 1 ? "" : "s"}` : "" })]),
    ]),
    h("div", {}, [
      h("div", { class: "picks-sub", text: "paper until CLV says otherwise" }),
      h("div", { class: "picks-sub warn", text: "engine: market + form tilt · edges shrunk by learned trust" }),
    ]),
  ]);
  wrap.appendChild(head);
  if (!parlays) wrap.appendChild(spinner("Building the card…"));
  else if (parlays.error) wrap.appendChild(h("div", { class: "center", text: `Couldn’t build: ${parlays.error}` }));
  else {
    const singles = parlays.singles || [];
    if (!singles.length && !parlays.longshot) wrap.appendChild(h("div", { class: "center", text: "No qualifying bets on this slate yet." }));
    const grid = h("div", { class: "tk-grid" });
    for (const g of singles) grid.appendChild(ticket(g.bet, { kind: `${axisOf(g.bet.legs[0]?.market)} axis · single`, game: g.game, stake: parlays.stake }));
    if (parlays.longshot) grid.appendChild(ticket(parlays.longshot, { kind: "for fun · longshot · not tracked", game: "one leg per game", stake: parlays.stake, fun: true }));
    wrap.appendChild(grid);
  }

  // the slate: today + upcoming, grouped by day; previous results behind a toggle
  const startToday = new Date(); startToday.setHours(0, 0, 0, 0);
  const past = matches.filter((mt) => new Date(mt.date) < startToday);
  const rest = matches.filter((mt) => new Date(mt.date) >= startToday);
  const days = new Map();
  for (const mt of rest) { const d = fmtDay(mt.date); if (!days.has(d)) days.set(d, []); days.get(d).push(mt); }
  let first = true;
  for (const [day, list] of days) {
    wrap.appendChild(h("div", { class: "today-head" }, [
      h("div", { class: "vh" }, [txt(first ? "Tonight " : ""), h("span", { class: "sub", text: `${day} · ${list.length} game${list.length === 1 ? "" : "s"}` })]),
      first ? h("div", { class: "picks-sub", text: "dim line = model's predicted final · tap a game to follow it" }) : null,
    ]));
    wrap.appendChild(h("div", { class: "gamegrid" }, list.map((mt) => gameCard(mt, m && m.id === mt.id))));
    first = false;
  }
  if (!days.size) wrap.appendChild(h("div", { class: "center", text: "No upcoming games in the window." }));
  const tools = h("div", {}, [
    h("span", { class: "pick-toggle", text: "↻ Auto-follow the live game", title: "Track whichever game is live (default)", onclick: () => choose(null) }),
  ]);
  if (past.length) tools.appendChild(h("span", { class: "pick-toggle", style: { "margin-left": "8px" }, onclick: () => { showPast = !showPast; render(); },
    text: `${showPast ? "▾" : "▸"} Previous results (${past.length})` }));
  wrap.appendChild(tools);
  if (showPast && past.length) {
    const pdays = new Map();
    for (const mt of past) { const d = fmtDay(mt.date); if (!pdays.has(d)) pdays.set(d, []); pdays.get(d).push(mt); }
    for (const [day, list] of pdays) {
      wrap.appendChild(h("div", { class: "today-head" }, [h("div", { class: "vh" }, [h("span", { class: "sub", text: day })])]));
      wrap.appendChild(h("div", { class: "gamegrid" }, list.map((mt) => gameCard(mt, m && m.id === mt.id))));
    }
  }
  return wrap;
}
const axisOf = (market) => ({ Moneyline: "result", DNB: "result", Spread: "result", Total: "goals", TeamTotal: "goals", BTTS: "goals", Corners: "goals" })[market] || "player";

// the big hero: the tracked match, painted in both kits
function heroFor(m) {
  const [hc, ac] = kitPair(m.home.color, m.away.color, m.away.altColor);
  const live = m.state === "in", pre = m.state === "pre";
  const hero = h("div", { class: "hero", style: { "--a": hc, "--h": ac }, title: "Open the match", onclick: () => showView("match") });
  // crest silhouettes behind each side (the club's own badge, washed to a watermark)
  for (const [side, t] of [["left", m.home], ["right", m.away]]) {
    const src = crestSrc(t.logo, 300);
    if (!src) continue;
    const img = h("img", { class: `wm ${side}` }); img.src = src; img.alt = ""; hero.appendChild(img);
  }
  const statCls = live ? "" : pre ? " pre" : " ft";
  hero.appendChild(h("div", { class: "hero-body" }, [
    h("div", { class: "hteam" }, [crest(m.home.abbr, m.home.logo, "big"), h("div", { class: "hname" }, [h("span", { class: "hab", text: m.home.abbr }), m.home.league ? h("span", { class: "hleague", text: m.home.league }) : null])]),
    h("div", { class: "hmid" }, [
      pre ? h("div", { class: "hscore vs", text: "v" })
        : h("div", { class: "hscore" }, [h("span", { text: String(m.home.score) }), h("span", { class: "hsep", text: "–" }), h("span", { text: String(m.away.score) })]),
      h("div", { class: `hstat${statCls}` }, [live ? h("span", { class: "dot" }) : null, txt(m.statusText || "")]),
    ]),
    h("div", { class: "hteam home" }, [crest(m.away.abbr, m.away.logo, "big"), h("div", { class: "hname" }, [h("span", { class: "hab", text: m.away.abbr }), m.away.league ? h("span", { class: "hleague", text: m.away.league }) : null])]),
  ]));
  const foot = [h("span", { class: `htag${statCls}`, text: live ? "Live" : pre ? "Upcoming" : "Full time" })];
  if (m.venue) foot.push(h("span", { class: "hide-c", text: m.venue }));
  if (m.xg) foot.push(h("span", { text: `xG ${m.xg.home.xg.toFixed(2)} – ${m.xg.away.xg.toFixed(2)}` }));
  if (m.odds) foot.push(h("span", { class: "hide-c", text: `${m.home.abbr} ${m.odds.home.ml} · Draw ${m.odds.draw.ml} · ${m.away.abbr} ${m.odds.away.ml}` }));
  const top = m.recs && pickTop(m.recs, 1)[0];
  if (top) { const [pick, det] = splitBet(top.bet); foot.push(h("span", { class: "htop" }, [txt("Top rec · "), h("b", { text: pick }), txt(det ? ` ${det}` : "")])); }
  foot.push(h("button", { class: "hbtn", text: "Open match" }));
  hero.appendChild(h("div", { class: "hero-foot" }, foot));
  return hero;
}
// "Over 2.5 goals — model 72%" → ["Over 2.5 goals", "model 72%"]
const splitBet = (bet) => { const i = (bet || "").indexOf(" — "); return i < 0 ? [bet || "", ""] : [bet.slice(0, i), bet.slice(i + 3)]; };

// one slate card: crest · abbr · score | status + model line | score · abbr · crest
function gameCard(mt, mine) {
  const [hc, ac] = kitPair(mt.homeColor, mt.awayColor, null);
  const pre = mt.state === "pre";
  const line = mt.pred
    ? (pre ? `${mt.pred.wH >= mt.pred.wA ? mt.homeAbbr : mt.awayAbbr} ${Math.round(Math.max(mt.pred.wH, mt.pred.wA) * 100)}% · model ${mt.pred.ph}–${mt.pred.pa}` : `model ${mt.pred.ph}–${mt.pred.pa}`)
    : "";
  return h("div", { class: `gcard${mine ? " mine" : ""}`, style: { "--a": hc, "--h": ac }, title: `${mt.home} v ${mt.away}`, onclick: () => choose(mt.id) }, [
    h("div", { class: "gteam" }, [crest(mt.homeAbbr, mt.homeLogo), h("span", { class: "gab", text: mt.homeAbbr }), pre ? null : h("span", { class: "gsc", text: String(mt.homeScore) })]),
    h("div", { class: "gmid" }, [
      h("span", { class: `gstat${mt.live ? " on" : ""}` }, [mt.live ? h("span", { class: "dot" }) : null, txt(mt.live ? (mt.statusText || "LIVE") : mt.state === "post" ? "FT" : fmtTime(mt.date))]),
      line ? h("span", { class: "gline", text: line }) : null,
    ]),
    h("div", { class: "gteam home" }, [crest(mt.awayAbbr, mt.awayLogo), h("span", { class: "gab", text: mt.awayAbbr }), pre ? null : h("span", { class: "gsc", text: String(mt.awayScore) })]),
  ]);
}

// a ticket: head · legs · 5-cell number strip · the reasoning
function ticket(p, { kind, game, stake, fun = false, result = null, extraNums = null }) {
  const cls = `tkt${fun ? " fun" : ""}${result ? ` ${result}` : ""}`;
  const t = h("div", { class: cls });
  const headKids = [h("span", { class: "tk-kind", text: kind })];
  if (result) headKids.push(h("span", { class: `rec-badge ${result}`, text: result === "win" ? "WON" : result === "loss" ? "LOST" : result === "push" ? "PUSH" : "PENDING" }));
  const gm = gameChip(game);
  if (gm) headKids.push(gm);
  t.appendChild(h("div", { class: "tk-head" }, headKids));
  const legs = h("div", { class: "tk-legs" });
  for (const l of p.legs) {
    const e = l.edge ?? 0;
    const v = l.result ? null : e >= 0.04 ? "bet" : e >= 0.015 ? "lean" : "pass";
    legs.appendChild(h("div", { class: "tk-leg" }, [
      l.result !== undefined && result ? h("span", { class: `leg-mark ${l.result || "pend"}`, text: l.result === "hit" ? "✓" : l.result === "miss" ? "✗" : l.result === "push" ? "＝" : "·" }) : null,
      h("div", { class: "tk-leg-main" }, [
        h("div", { class: "tk-leg-label", text: l.pick }),
        h("div", { class: "tk-leg-sub", text: `${marketName(l.market)} · ${l.game}${l.finalScore ? ` · ${l.finalScore}` : ""}${l.closeMl != null ? ` · close ${fmtAm(l.closeMl)}` : ""}` }),
      ]),
      h("div", { class: "tk-leg-right" }, [
        h("span", { class: "tk-price", text: fmtAm(l.ml) }),
        v ? h("span", { class: `tk-v ${v}`, text: v }) : (l.modelProb != null ? h("span", { class: "tk-v pass", text: `model ${pctR(l.modelProb)}` }) : null),
      ]),
    ]));
  }
  t.appendChild(legs);
  const num = (v, l, c = "") => h("div", { class: "tk-num" }, [h("div", { class: `tk-num-v ${c}`, text: v }), h("div", { class: "tk-num-l", text: l })]);
  const edge = p.legs.length === 1 ? p.legs[0].edge : (p.modelProb != null && p.americanOdds != null ? p.modelProb - amProb(p.americanOdds) : null);
  const nums = extraNums || [
    num(pctR(p.modelProb), "model"),
    num(p.americanOdds != null ? pctR(amProb(p.americanOdds)) : "—", "book"),
    num(edge == null ? "—" : `${edge >= 0 ? "+" : ""}${(edge * 100).toFixed(1)}%`, "edge", edge >= 0 ? "acc" : "neg"),
    num(`${p.ev >= 0 ? "+" : "−"}$${Math.abs(p.ev).toFixed(2)}`, `EV / $${stake}`, p.ev >= 0 ? "pos" : "neg"),
    num(p.kelly > 0.002 ? `${(p.kelly * 100).toFixed(1)}%` : "skip", "½ Kelly"),
  ];
  t.appendChild(h("div", { class: "tk-nums" }, nums));
  const why = p.legs.map((l) => l.why).filter(Boolean);
  if (why.length) t.appendChild(h("div", { class: "tk-why" }, why.map((w, i) => h("div", { text: (why.length > 1 ? `${i + 1}. ` : "") + w }))));
  return t;
}
const amProb = (ml) => (ml == null ? null : ml > 0 ? 100 / (ml + 100) : -ml / (-ml + 100));
const MARKET_NAME = { Moneyline: "Moneyline", DNB: "Draw no bet", Spread: "Asian handicap", Total: "Match total", TeamTotal: "Team total", BTTS: "Both teams to score", Corners: "Corners", Scorer: "Anytime scorer" };
const marketName = (mk) => MARKET_NAME[mk] || mk || "";
// "AEK v LAS" → chip with both crests + kickoff time from the slate; plain text otherwise
function gameChip(game) {
  const parts = (game || "").split(" v ");
  if (parts.length !== 2) return game ? h("span", { class: "tk-game", text: game }) : null;
  const [hAb, aAb] = parts.map((s) => s.trim());
  const mt = (last?.matches || []).find((x) => x.homeAbbr === hAb && x.awayAbbr === aAb);
  const when = mt ? (mt.live ? mt.statusText || "LIVE" : mt.state === "post" ? `FT ${mt.homeScore}–${mt.awayScore}` : fmtTime(mt.date)) : "";
  return h("span", { class: "tk-game", title: mt ? `${mt.home} v ${mt.away}` : "", onclick: mt ? () => choose(mt.id) : null }, [
    crestFor(hAb, "xs"), txt(` ${hAb} v ${aAb} `), crestFor(aAb, "xs"), when ? txt(` · ${when}`) : null,
  ]);
}

// ── MATCH: lower third + crawl + every section ───────────────────────────────
function liveSwitcherChips(curId) {
  const others = (last?.matches || []).filter((mt) => mt.live && mt.id !== curId);
  if (!others.length) return null;
  const strip = h("div", { class: "alsolive" }, [h("span", { class: "al-lbl" }, [h("span", { class: "dot" }), txt("Also live")])]);
  for (const mt of others) strip.appendChild(h("div", { class: "al-chip", title: "Switch to this game", onclick: () => choose(mt.id) }, [
    crest(mt.homeAbbr, mt.homeLogo, "xs"), txt(`${mt.homeAbbr} ${mt.homeScore}–${mt.awayScore} ${mt.awayAbbr}`), crest(mt.awayAbbr, mt.awayLogo, "xs"),
    h("span", { class: "al-min", text: mt.statusText || "LIVE" }),
  ]));
  return strip;
}

function renderMatch(m) {
  const [homeColor, awayColor] = kitPair(m.home.color, m.away.color, m.away.altColor);
  app.style.setProperty("--home", homeColor);
  app.style.setProperty("--away", awayColor);
  const live = m.state === "in", pre = m.state === "pre", post = m.state === "post";
  const p = m.prediction;
  subEl.textContent = [`${m.home.name} v ${m.away.name}`, m.venue, m.matchday ? `MD ${m.matchday}` : m.round ? m.round.label : null].filter(Boolean).join(" · ");

  // full-time winner: higher score, shootout decides level games
  let winSide = null;
  if (post) {
    if (m.home.score !== m.away.score) winSide = m.home.score > m.away.score ? "home" : "away";
    else if (m.home.shoot != null || m.away.shoot != null)
      winSide = (m.home.shoot ?? 0) > (m.away.shoot ?? 0) ? "home" : (m.away.shoot ?? 0) > (m.home.shoot ?? 0) ? "away" : null;
  }
  // one-shot goal pulse: same match as last render but the score moved while live
  const scoreKey = `${m.id}|${m.home.score}-${m.away.score}`;
  const bump = live && prevScoreKey.startsWith(`${m.id}|`) && prevScoreKey !== scoreKey;
  prevScoreKey = scoreKey;

  // lower third: crests · score · status · headline facts
  kickoffAt = 0;
  const kick = h("span", { class: `kick${live ? " on" : ""}` });
  if (live) { kick.appendChild(h("span", { class: "dot" })); kick.appendChild(txt(m.statusText)); }
  else if (pre && m.date) {
    kickoffAt = new Date(m.date).getTime();
    const kt = h("span", { text: fmtCountdown(kickoffAt - Date.now()) }); kt.id = "kick-time";
    kick.appendChild(txt(`${m.statusText} · in `)); kick.appendChild(kt);
  } else kick.appendChild(txt(m.statusText));
  const facts = [];
  if (p) {
    if (m.advance) facts.push(fact("To advance", `${m.advance.home >= m.advance.away ? m.home.abbr : m.away.abbr} ${Math.round(Math.max(m.advance.home, m.advance.away) * 100)}%`));
    else facts.push(fact("Win prob", `${p.wH >= p.wA ? m.home.abbr : m.away.abbr} ${Math.round(Math.max(p.wH, p.wA) * 100)}%`));
    facts.push(fact("Predicted", `${p.ph}–${p.pa}`, "acc"));
  }
  if (m.odds) {
    const fav = m.odds.home.prob >= m.odds.away.prob ? [m.home.abbr, m.odds.home.ml] : [m.away.abbr, m.odds.away.ml];
    facts.push(fact(m.odds.source === "live" ? "Live ML" : "ML", `${fav[0]} ${fav[1]}`, "book"));
  }
  if (m.xg) facts.push(fact("xG", `${m.xg.home.xg.toFixed(2)} – ${m.xg.away.xg.toFixed(2)}`));
  const other = (last?.matches || []).find((mt) => mt.live && mt.id !== m.id);
  if (other) { const f = fact("Also live", `${other.homeAbbr} ${other.homeScore}–${other.awayScore} ${other.awayAbbr} ${other.statusText || ""}`, "dim", () => choose(other.id)); f.classList.add("also"); facts.push(f); }
  setThird([
    h("span", { class: "matchup" }, [
      crest(m.home.abbr, m.home.logo, "sm"), h("span", { class: winSide === "home" ? "won" : "", text: m.home.abbr }),
      pre ? h("span", { class: "vs", text: "v" }) : h("span", { class: `sc${bump ? " bump" : ""}`, text: `${m.home.score}–${m.away.score}` }),
      h("span", { class: winSide === "away" ? "won" : "", text: m.away.abbr }), crest(m.away.abbr, m.away.logo, "sm"),
    ]),
    kick,
    h("div", { class: "facts" }, facts),
  ], homeColor);
  setTicker([
    { text: pre ? "Pregame: market prior + form tilt · retires at kickoff" : live ? "Run of play · real xG · pregame priors retired at kickoff" : "Final · settled from the box score" },
    p && p.early ? { text: "Early minutes — low confidence", cls: "warn" } : null,
    { text: "Scorer, corner and keeper projections are display only", cls: "warn" },
    { text: SRC_LINE, cls: "src" },
  ]);

  const blocks = [];
  // header extras: pens, kick-by-kick shootout, champions banner, venue (compact)
  const extra = [];
  if (m.home.shoot != null || m.away.shoot != null) extra.push(h("div", { class: "pens", text: `Penalties · ${m.home.abbr} ${m.home.shoot ?? 0}–${m.away.shoot ?? 0} ${m.away.abbr}` }));
  if (m.shootoutKicks && m.shootoutKicks.length) {
    const kickRow = (abbr) => {
      const kicks = m.shootoutKicks.filter((k) => k.teamAbbr === abbr);
      if (!kicks.length) return null;
      return h("div", { class: "pso-row" }, [h("span", { class: "pso-ab", text: abbr }), ...kicks.map((k) => h("span", { class: `pso-dot ${k.scored ? "ok" : "no"}`, text: k.scored ? "●" : "✗", title: k.player }))]);
    };
    extra.push(h("div", { class: "pso" }, [kickRow(m.home.abbr), kickRow(m.away.abbr)].filter(Boolean)));
  }
  if (post && m.round && m.round.slug === "final" && winSide) {
    const champ = winSide === "home" ? m.home : m.away;
    extra.push(h("div", { class: "champs", text: `🏆 ${(champ.name || champ.abbr).toUpperCase()} — CHAMPIONS OF EUROPE` }));
  }
  if (!expanded && m.venue) extra.push(h("div", { class: "venue", text: m.venue }));
  if (extra.length) blocks.push(h("div", { class: "hero-extra" }, extra));
  if (!expanded) { const sw = liveSwitcherChips(m.id); if (sw) blocks.push(sw); }

  // expanded: the six-tile stat strip under the crawl
  if (expanded) {
    const tile = (v, k, c = "") => h("div", { class: "stat" }, [h("div", { class: `sv ${c}`, text: v }), h("div", { class: "sk", text: k })]);
    const tiles = [];
    if (m.possession) tiles.push(tile(`${m.possession.home}%`, `Possession · ${m.home.abbr}`));
    if (m.xg) {
      tiles.push(tile(`${m.xg.home.shots} (${m.xg.home.sot})`, `Shots (on target) · ${m.home.abbr}`));
      tiles.push(tile(m.xg.home.xg.toFixed(2), `xG · ${m.home.abbr}`, m.xg.home.xg >= m.xg.away.xg ? "acc" : "muted"));
      tiles.push(tile(m.xg.away.xg.toFixed(2), `xG · ${m.away.abbr}`, m.xg.away.xg > m.xg.home.xg ? "acc" : "muted"));
    }
    if (m.corners) tiles.push(tile(`${m.corners.home} – ${m.corners.away}`, "Corners"));
    if (p) {
      if (m.advance) tiles.push(tile(`${Math.round(Math.max(m.advance.home, m.advance.away) * 100)}%`, `${m.advance.home >= m.advance.away ? m.home.abbr : m.away.abbr} to advance`, "good"));
      else tiles.push(tile(`${Math.round(Math.max(p.wH, p.wA) * 100)}%`, `${p.wH >= p.wA ? m.home.abbr : m.away.abbr} win prob`, "good"));
      if (tiles.length < 6 && p.pOver25 != null) tiles.push(tile(pctR(p.pOver25), "Over 2.5"));
      if (tiles.length < 6 && p.pBTTS != null) tiles.push(tile(pctR(p.pBTTS), "BTTS"));
      if (tiles.length < 6) tiles.push(tile(`${p.expH.toFixed(1)}–${p.expA.toFixed(1)}`, "Expected goals (model)"));
    }
    if (tiles.length) blocks.push(h("div", { class: `stat-grid c${Math.min(6, Math.max(3, tiles.length))}` }, tiles.slice(0, 6)));
    // the pitch: formations, ratings and the shot map, with hover zones for corners / goals / boxes
    if (m.pitch) blocks.push(pitchCard(m));
  }

  // prediction: the story of the game
  if (p) {
    blocks.push(h("div", { class: "label", text: `Win probability · ${expanded ? p.basis : "model"}${p.early ? " · low conf" : ""}` }));
    const pred = h("div", { class: "pred" }, [h("span", { class: "h", text: m.home.abbr }), txt(` ${p.ph} – ${p.pa} `), h("span", { class: "a", text: m.away.abbr })]);
    if (expanded) pred.appendChild(h("span", { class: "exp", text: `expected ${p.expH.toFixed(1)}–${p.expA.toFixed(1)}` }));
    blocks.push(pred);
    if (probHist.id === m.id && probHist.pts.length >= 3 && !pre) {
      const graph = sparkline(probHist.pts, { midline: 0.5 });
      if (graph) blocks.push(h("div", { class: "probwrap" }, [graph]));
    }
    const wH = Math.round(p.wH * 100), wD = Math.round(p.wD * 100), wA = Math.round(p.wA * 100);
    if (m.advance) {
      const aH = Math.max(m.advance.home, 0.001), aA = Math.max(m.advance.away, 0.001);
      blocks.push(h("div", { class: "stline" }, [h("span", { class: "l", text: `${m.home.abbr} ${Math.round(m.advance.home * 100)}%` }), h("span", { class: "k", text: "to advance" }), h("span", { class: "r", text: `${m.away.abbr} ${Math.round(m.advance.away * 100)}%` })]));
      blocks.push(h("div", { class: "advbar" }, [h("span", { class: "h", style: { flex: String(aH) } }), h("span", { class: "a", style: { flex: String(aA) } })]));
      blocks.push(h("div", { class: "adv90", text: `In 90′: ${m.home.abbr} ${wH}% · Draw ${wD}% · ${m.away.abbr} ${wA}% · draw goes to ET/pens` }));
    } else {
      blocks.push(h("div", { class: "stline" }, [h("span", { class: "l", text: `${m.home.abbr} ${wH}%` }), h("span", { class: "k", text: `Draw ${wD}%` }), h("span", { class: "r", text: `${m.away.abbr} ${wA}%` })]));
      blocks.push(h("div", { class: "winbar" }, [
        h("span", { class: "h", style: { flex: String(Math.max(p.wH, 0.001)) } }), h("span", { class: "d", style: { flex: String(Math.max(p.wD, 0.001)) } }), h("span", { class: "a", style: { flex: String(Math.max(p.wA, 0.001)) } }),
      ]));
    }
    if (expanded && p.pOver25 != null) blocks.push(h("div", { class: "winlegend" }, [h("span", { text: `Over 2.5: ${pctR(p.pOver25)}` }), h("span", { text: `BTTS: ${pctR(p.pBTTS)}` })]));
    if (expanded && m.momentum && m.momentum.length >= 5) {
      blocks.push(h("div", { class: "label best-lbl", text: "Momentum · FotMob pressure" }));
      const max = Math.max(1, ...m.momentum.map((d) => Math.abs(d.v)));
      const spark = h("div", { class: "spark" });
      for (const d of m.momentum) { const bar = h("span", { class: "sb " + (d.v >= 0 ? "h" : "a") }); bar.style.height = `${Math.max(3, Math.round((Math.abs(d.v) / max) * 100))}%`; spark.appendChild(bar); }
      blocks.push(spark);
      blocks.push(h("div", { class: "winlegend" }, [h("span", { text: `◀ ${m.home.abbr}` }), h("span", { text: `${m.away.abbr} ▶` })]));
    }
  }

  // recommended bets — the compact view's top two (expanded: the sheet's Recommended card)
  if (!expanded && m.state !== "post" && m.recs && m.recs.length) {
    const note = m.dominance ? `${m.dominance.leader} ${m.dominance.pct}% dominance` : m.recsBasis || "";
    blocks.push(h("div", { class: "label", text: "Recommended bets" + (note ? ` · ${note}` : "") }));
    blocks.push(recCells(m, false));
  }

  // ---- expanded: the match sheet goes under the pitch (before the first card); the model's
  // pre-match projections and FanDuel props stay as cards ----
  if (expanded) {
    const firstLabel = blocks.findIndex((b) => b.classList && b.classList.contains("label"));
    blocks.splice(firstLabel < 0 ? blocks.length : firstLabel, 0, ...matchSheet(m));
    const kv = (a, b, cls = "est", title = null) => h("div", { class: "gk" }, [h("span", { text: a, title }), h("span", { class: cls, text: b })]);
    if (m.pregameProj) {
      const pg = m.pregameProj, c = pg.corners;
      blocks.push(h("div", { class: "label", text: `Pregame projections · ${pg.basis} · model est.` }));
      if (pg.shots) blocks.push(kv(`${m.home.abbr} shots ${pg.shots.home.shots.toFixed(1)} (${pg.shots.home.sot.toFixed(1)} on target)`, `${pg.shots.away.shots.toFixed(1)} (${pg.shots.away.sot.toFixed(1)} on target) ${m.away.abbr}`));
      blocks.push(kv(`Corners total ${c.total.toFixed(1)}`, `O${c.line} ${Math.round(c.pOver * 100)}%${c.odds != null ? ` (${fmtAm(c.odds)})` : ""}`));
      blocks.push(kv(`${m.home.abbr} ${c.home.toFixed(1)} · ${m.away.abbr} ${c.away.toFixed(1)}`, "corners per side"));
      const sv = (abbr, s) => blocks.push(kv(`${abbr} keeper saves`, `proj ${s.proj.toFixed(1)} · O${s.line} ${Math.round(s.pOver * 100)}%${s.odds != null ? ` (${fmtAm(s.odds)})` : ""}`));
      sv(m.home.abbr, pg.saves.home); sv(m.away.abbr, pg.saves.away);
    }
    if (m.playerProj && ((m.playerProj.home || []).length || (m.playerProj.away || []).length)) {
      const all = [...(m.playerProj.home || []).map((x) => ({ ...x, abbr: m.home.abbr })), ...(m.playerProj.away || []).map((x) => ({ ...x, abbr: m.away.abbr }))];
      const fdScorers = m.fdScorers || [];
      const nrm = (s) => (s || "").toLowerCase().replace(/[^a-z]/g, "");
      const lastTok = (s) => nrm((s || "").split(/\s+/).filter(Boolean).pop());
      const fdFor = (name) => fdScorers.find((f) => { const a = nrm(name), b = nrm(f.player); if (!a || !b) return false; return a === b || a.includes(lastTok(f.player)) || b.includes(lastTok(name)); });
      const scorers = all.filter((x) => x.scoreProb > 0).sort((a, b) => b.scoreProb - a.scoreProb).slice(0, 6);
      if (scorers.length) {
        blocks.push(h("div", { class: "label", text: "Predicted scorers · anytime" + (fdScorers.length ? " · FanDuel price" : " · model est.") }));
        blocks.push(h("div", { class: "hint", text: "Model % from recent xG (adjusted for the opponent's defence) vs FanDuel's price (implied %). ▲ = model rates higher than the price. Display-only." }));
        for (const x of scorers) {
          const fdp = fdFor(x.name);
          const value = fdp && fdp.implied != null && x.scoreProb > fdp.implied;
          const priceTxt = fdp ? ` · FD ${fmtAm(fdp.ml)}${fdp.implied != null ? ` (${Math.round(fdp.implied * 100)}%)` : ""}` : "";
          blocks.push(kv(`${x.abbr} ${x.name}`, `${Math.round(x.scoreProb * 100)}%${priceTxt}${value ? " ▲" : ""}`, value ? "est up" : "est"));
        }
      }
      blocks.push(h("div", { class: "label", text: "Projected shots on target · per player · model est." }));
      const rows = (arr, abbr) => [...(arr || [])].sort((a, b) => b.projSOT - a.projSOT).slice(0, 4).forEach((x) => blocks.push(kv(`${abbr} ${x.name}`, `proj ${x.projSOT.toFixed(1)} SOT (${x.games}g)`)));
      rows(m.playerProj.home, m.home.abbr); rows(m.playerProj.away, m.away.abbr);
    }
    if (m.playerProps && (m.playerProps.scorers.length || m.playerProps.sot.length)) {
      const pp = m.playerProps;
      const priceEl = (pv) => {
        if (pv.primary) { const span = h("span", { class: "est", text: `FD ${pv.primary}` }); if (pv.beats && pv.best) span.appendChild(h("span", { class: "up", text: `  ▲ ${pv.best} ${bookName(pv.bestBook)}` })); return span; }
        return h("span", { class: "est", text: pv.best ? `${pv.best} ${bookName(pv.bestBook)} (no FD)` : "" });
      };
      if (pp.scorers.length) {
        blocks.push(h("div", { class: "label", text: "Anytime scorer · FanDuel" }));
        for (const s of pp.scorers.slice(0, 5)) blocks.push(h("div", { class: "gk" }, [h("span", { text: `${s.player} · ${s.prob != null ? `${Math.round(s.prob * 100)}% devig` : `${Math.round((s.price.implied || 0) * 100)}%`}` }), priceEl(s.price)]));
      }
      if (pp.sot.length) {
        blocks.push(h("div", { class: "label", text: "Shots on target · FanDuel · de-vigged" }));
        for (const s of pp.sot.slice(0, 5)) blocks.push(h("div", { class: "gk" }, [h("span", { text: `${s.player} O${s.line} · ${Math.round(s.fairOver * 100)}%` }), priceEl(s.price)]));
      }
    }
    blocks.push(h("div", { class: "disc", text: "⚠ Model estimates, not financial advice. Odds are −EV on average; stake small." }));
  }

  if (expanded) flushCards(blocks);
  else body.appendChild(frag(blocks));
}
// ── PITCH: both XIs as headshots on the grass; every number lives in a popover above whatever
// you hover (a player, a sub, a shot, a corner flag, a goalmouth, a box, the centre spot).
// FotMob gives each starter a slot in their own half (x 0 = own goal → 1 = halfway, y across);
// the shot map has every shot attacking x = 105. Home attacks left → right, away mirrored.
// Click pins the popover so the 30-second refresh doesn't lose it. Layers: Lineups / Shots / Both.
let pitchPin = null;
let pitchLayer = "lineups";
const headshot = (id) => `https://images.fotmob.com/image_resources/playerimages/${id}.png`;
const ratingCls = (r) => (r == null ? "" : r >= 8 ? "hi" : r >= 7 ? "good" : r >= 6 ? "ok" : "low");
const nrmName = (s) => (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z]/g, "");
const lastTokOf = (s) => nrmName((s || "").split(/\s+/).filter(Boolean).pop());
const fmtMin = (s) => `${s.min}${s.minAdded ? `+${s.minAdded}` : ""}'`;
const POS_LONG = { GK: "Goalkeeper", DEF: "Defender", MID: "Midfielder", ATT: "Forward" };
let ballSeq = 0;
function ballSvg(cls = "ball") {
  const pent = (cx, cy, r, rot = -90) => Array.from({ length: 5 }, (_, i) => { const a = (rot + i * 72) * Math.PI / 180; return `${(cx + r * Math.cos(a)).toFixed(2)},${(cy + r * Math.sin(a)).toFixed(2)}`; }).join(" ");
  const id = `bc${ballSeq++}`;
  const svg = svgEl("svg", { viewBox: "0 0 24 24", class: cls });
  const clip = svgEl("clipPath", { id }, [svgEl("circle", { cx: 12, cy: 12, r: 10.5 })]);
  svg.appendChild(svgEl("defs", {}, [clip]));
  svg.appendChild(svgEl("circle", { cx: 12, cy: 12, r: 10.5, fill: "#ffffff" }));
  const g = svgEl("g", { "clip-path": `url(#${id})`, fill: "#070b1f" });
  g.appendChild(svgEl("polygon", { points: pent(12, 12, 4.2) }));
  for (let i = 0; i < 5; i++) { const a = (-90 + i * 72) * Math.PI / 180; g.appendChild(svgEl("polygon", { points: pent(12 + 10.2 * Math.cos(a), 12 + 10.2 * Math.sin(a), 3.6, -90 + i * 72 + 36) })); g.appendChild(svgEl("line", { x1: 12 + 4.2 * Math.cos(a), y1: 12 + 4.2 * Math.sin(a), x2: 12 + 8 * Math.cos(a), y2: 12 + 8 * Math.sin(a), stroke: "#070b1f", "stroke-width": 1.1 })); }
  svg.appendChild(g);
  svg.appendChild(svgEl("circle", { cx: 12, cy: 12, r: 10.5, fill: "none", stroke: "#070b1f", "stroke-width": 1.4 }));
  return svg;
}
// a per-player row from any name-keyed list (xg.players, playerProj, fdScorers)
function findByName(list, name, key = "name") {
  const a = nrmName(name), t = lastTokOf(name);
  return (list || []).find((p) => { const b = nrmName(p[key]); return b && (b === a || b.includes(t) || a.includes(lastTokOf(p[key]))); }) || null;
}
// shots by this player: full-name match first; the surname fallback only when it's unique in the squad
function playerShots(m, p, side) {
  const P = m.pitch, all = (P.shots || []).filter((s) => s.side === side);
  const exact = all.filter((s) => nrmName(s.player) === nrmName(p.name));
  const tok = lastTokOf(p.name);
  const squad = [...(P.lineups?.[side]?.starters || []), ...(P.lineups?.[side]?.subs || [])];
  const shared = squad.filter((q) => lastTokOf(q.name) === tok).length > 1;
  return exact.length || shared ? exact : all.filter((s) => nrmName(s.player).includes(tok));
}
const sumXg = (arr) => arr.reduce((a, s) => a + s.xg, 0);
// headshot with an initials fallback
function avatar(p, side, cls = "") {
  const av = h("div", { class: `av ${cls}`, style: { "border-color": side === "home" ? "var(--home)" : "var(--away)" } });
  const img = h("img"); img.src = headshot(p.id); img.alt = ""; img.loading = "lazy";
  img.addEventListener("error", () => { img.remove(); av.classList.add("noimg"); av.appendChild(h("span", { class: "ini", text: (p.short || "?").slice(0, 2).toUpperCase() })); });
  av.appendChild(img);
  return av;
}
function pitchLinesSvg() {
  const g = svgEl("svg", { viewBox: "0 0 105 68", preserveAspectRatio: "none", class: "lines" });
  g.appendChild(svgEl("rect", { x: 0, y: 0, width: 105, height: 68 }));
  g.appendChild(svgEl("line", { x1: 52.5, y1: 0, x2: 52.5, y2: 68 }));
  g.appendChild(svgEl("circle", { cx: 52.5, cy: 34, r: 9.15 }));
  for (const left of [true, false]) {
    g.appendChild(svgEl("rect", { x: left ? 0 : 88.5, y: 13.84, width: 16.5, height: 40.32 }));
    g.appendChild(svgEl("rect", { x: left ? 0 : 99.5, y: 24.84, width: 5.5, height: 18.32 }));
    g.appendChild(svgEl("path", { d: left ? "M16.5 26.7 A9.15 9.15 0 0 1 16.5 41.3" : "M88.5 26.7 A9.15 9.15 0 0 0 88.5 41.3" }));
  }
  return g;
}
const svgEl = (tag, attrs = {}, kids = []) => {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, String(v));
  for (const k of [].concat(kids)) if (k) el.appendChild(k);
  return el;
};

function pitchCard(m) {
  const P = m.pitch, lu = P.lineups, shots = P.shots || [];
  const card = h("section", { class: "card pitchcard" });
  const subTxt = lu ? `${lu.type === "standard" ? "confirmed XIs" : "predicted XIs"} · ${m.home.abbr} ${lu.home?.formation || "—"} · ${m.away.abbr} ${lu.away?.formation || "—"}` : "lineups post about an hour before kickoff";
  const seg = h("div", { class: "seg" }, ["lineups", "shots", "both"].map((l) => h("span", { class: pitchLayer === l ? "on" : "", text: l, onclick: () => { pitchLayer = l; render(); } })));
  card.appendChild(h("div", { class: "card-h" }, [
    h("div", { class: "card-hl" }, [h("span", { class: "card-t", text: "Pitch" }), h("span", { class: "card-s", text: `${subTxt} · FotMob` })]),
    h("div", { class: "card-hl" }, [h("span", { class: "card-s", text: "hover a player, a flag, a goal or a box · click a player to pin and see their shots" }), seg]),
  ]));
  const wrap = h("div", { class: `pitchwrap l-${pitchLayer}` });
  wrap.appendChild(pitchLinesSvg());
  wrap.appendChild(h("span", { class: "endlbl home", text: `${m.home.abbr} ▶` }));
  wrap.appendChild(h("span", { class: "endlbl away", text: `◀ ${m.away.abbr}` }));
  const pop = h("div", { class: "pop" }); pop.hidden = true;

  // one popover, moved to whatever is hovered. x/y are % of the pitch box.
  const showPop = (key, x, y) => {
    const content = popContent(m, key);
    if (!content) { pop.hidden = true; return; }
    pop.replaceChildren(content);
    pop.className = "pop";
    const below = y < 30;
    pop.classList.add(below ? "down" : "up");
    const sx = x < 10 ? 8 : x > 90 ? 92 : x; // keep it on the pitch
    pop.style.left = `${sx}%`; pop.style.top = `${y}%`;
    pop.style.transform = below ? "translate(-50%, 34px)" : "translate(-50%, calc(-100% - 34px))";
    pop.hidden = false;
  };
  const hidePop = () => { pop.hidden = true; };
  const anchors = new Map(); // key → [x, y]
  const shotEls = new Map(); // shot id → dot, so a pinned player's shots can light up
  // a pinned player (or sub) shows their shots whatever the layer; everything else dims
  const applyFocus = () => {
    const key = pitchPin || "", isP = key.startsWith("player-") || key.startsWith("sub-");
    wrap.classList.toggle("focus", isP);
    for (const el of shotEls.values()) el.classList.remove("mine");
    if (!isP) return;
    const [kind, side, id] = key.split("-");
    const list = kind === "player" ? lu?.[side]?.starters : lu?.[side]?.subs;
    const p = (list || []).find((x) => String(x.id) === id);
    if (p) for (const sh of playerShots(m, p, side)) shotEls.get(sh.id)?.classList.add("mine");
  };
  const hot = (el, key, x, y) => {
    anchors.set(key, [x, y]);
    el.addEventListener("mouseenter", () => showPop(key, x, y));
    el.addEventListener("mouseleave", () => { if (pitchPin && anchors.has(pitchPin)) showPop(pitchPin, ...anchors.get(pitchPin)); else hidePop(); });
    el.addEventListener("click", (e) => { e.stopPropagation(); pitchPin = pitchPin === key ? null : key; wrap.querySelectorAll(".pinned").forEach((n) => n.classList.remove("pinned")); if (pitchPin) { el.classList.add("pinned"); showPop(key, x, y); } else hidePop(); applyFocus(); });
    if (pitchPin === key) el.classList.add("pinned");
    return el;
  };
  const pct = (x, y) => ({ left: `${x.toFixed(2)}%`, top: `${y.toFixed(2)}%` });

  // landmarks: corners · goals · boxes · centre (drawn under players so a player wins the hover)
  const zone = (cls, key, x, y, w = null, hgt = null) => {
    const st = pct(x, y); if (w != null) { st.width = `${w}%`; st.height = `${hgt}%`; }
    return hot(h("div", { class: `hs ${cls}`, style: st }), key, w != null ? x + w / 2 : x, w != null ? y + hgt / 2 : y);
  };
  wrap.appendChild(zone("box", "box-away", 0, 13.84 / 68 * 100, 16.5 / 105 * 100, 40.32 / 68 * 100));
  wrap.appendChild(zone("box", "box-home", 88.5 / 105 * 100, 13.84 / 68 * 100, 16.5 / 105 * 100, 40.32 / 68 * 100));
  for (const [x, y, key] of [[0, 0, "corners-away"], [0, 100, "corners-away"], [100, 0, "corners-home"], [100, 100, "corners-home"]]) wrap.appendChild(zone("corner", key, x, y));
  wrap.appendChild(zone("goal", "goal-home", 0, 50));
  wrap.appendChild(zone("goal", "goal-away", 100, 50));
  wrap.appendChild(zone("centre", "centre", 50, 50));

  // shots: dots sized by xG, goals ringed
  for (const s of shots) {
    const x = (s.side === "home" ? s.x : 105 - s.x) / 105 * 100, y = (s.side === "home" ? s.y : 68 - s.y) / 68 * 100;
    const d = 8 + Math.min(18, Math.sqrt(s.xg) * 28);
    const dot = h("div", { class: `shot ${s.side}${s.type === "Goal" ? " goal" : s.onTarget ? " sot" : s.blocked ? " blk" : ""}`, style: { ...pct(x, y), width: `${d}px`, height: `${d}px` } });
    shotEls.set(s.id, dot);
    wrap.appendChild(hot(dot, `shot-${s.id}`, x, y));
  }
  // players
  const drawSide = (side, team) => {
    if (!team) return;
    for (const p of team.starters) {
      if (p.x == null) continue;
      const x = (side === "home" ? p.x / 2 : 1 - p.x / 2) * 100, y = (side === "home" ? p.y : 1 - p.y) * 100;
      const goals = playerShots(m, p, side).filter((s) => s.type === "Goal" && !s.ownGoal).length;
      const og = playerShots(m, p, side).some((s) => s.ownGoal);
      const av = avatar(p, side);
      av.appendChild(h("span", { class: "num", text: p.num }));
      if (p.rating != null) av.appendChild(h("span", { class: `rt ${ratingCls(p.rating)}`, text: p.rating.toFixed(1) }));
      if (goals) av.appendChild(h("span", { class: "badge goal" }, Array.from({ length: goals }, () => ballSvg())));
      if (og) av.appendChild(h("span", { class: "badge og", text: "OG" }));
      if (p.events.includes("redCard")) av.appendChild(h("span", { class: "badge rc" }));
      else if (p.events.includes("yellowCard")) av.appendChild(h("span", { class: "badge yc" }));
      const node = h("div", { class: `pl ${side}`, style: pct(x, y) }, [av, h("div", { class: "nm", text: p.short })]);
      wrap.appendChild(hot(node, `player-${side}-${p.id}`, x, y));
    }
  };
  if (lu) { drawSide("home", lu.home); drawSide("away", lu.away); }
  else wrap.appendChild(h("div", { class: "nolu", text: "lineups post about an hour before kickoff · shots and goals still light up once the game is on" }));
  wrap.appendChild(pop);
  applyFocus();
  wrap.addEventListener("click", () => { if (pitchPin) { pitchPin = null; wrap.querySelectorAll(".pinned").forEach((n) => n.classList.remove("pinned")); hidePop(); applyFocus(); } });
  card.appendChild(wrap);

  // benches: formation · team rating · coach · out, then the subs as small avatars (hoverable)
  if (lu) {
    const bench = (side, team) => {
      if (!team) return null;
      const t = side === "home" ? m.home : m.away;
      const out = (team.unavailable || []).slice(0, 4).map((u) => u.name.split(" ").pop()).join(", ");
      const subs = h("div", { class: "subs" }, team.subs.slice(0, 9).map((p) => {
        const node = h("div", { class: "sub" }, [avatar(p, side, "sm"), h("div", { class: "snm", text: p.short }), h("div", { class: `srt ${ratingCls(p.rating)}`, text: p.rating != null ? p.rating.toFixed(1) : "—" })]);
        // a sub's popover opens at the bench edge of the pitch on their side
        return hot(node, `sub-${side}-${p.id}`, side === "home" ? 25 : 75, 96);
      }));
      return h("div", { class: `bench ${side}` }, [
        h("div", { class: "bh" }, [
          h("span", { class: "bt" }, [txt(`${t.abbr} · ${team.formation || "—"}`), team.rating != null ? h("em", { text: ` · ${team.rating.toFixed(1)}` }) : null]),
          team.coach ? h("span", { class: "bc", text: team.coach }) : null,
          out ? h("span", { class: "bo", text: `Out: ${out}` }) : null,
        ]),
        subs,
      ]);
    };
    card.appendChild(h("div", { class: "benches" }, [bench("home", lu.home), bench("away", lu.away)]));
  }
  return card;
}

// the popover body for a hotspot key
function popContent(m, key) {
  const P = m.pitch, lu = P.lineups;
  const box = h("div", { class: "popc" });
  const head = (t, s) => box.appendChild(h("div", { class: "pop-hd" }, [h("div", {}, [h("div", { class: "pop-n", text: t }), s ? h("div", { class: "pop-s", text: s }) : null])]));
  const row = (a, b, cls = "") => box.appendChild(h("div", { class: "pop-row" }, [h("span", { text: a }), h("b", { class: cls, text: b })]));
  const note = (t) => box.appendChild(h("div", { class: "pop-note", text: t }));
  const team = (side) => (side === "home" ? m.home : m.away);
  const oppo = (side) => (side === "home" ? "away" : "home");
  const shotsOf = (side) => (P.shots || []).filter((s) => s.side === side);
  const sideOf = (k) => (k.endsWith("home") ? "home" : "away");

  if (key.startsWith("player-") || key.startsWith("sub-")) {
    const [kind, side, id] = key.split("-");
    const list = kind === "player" ? lu?.[side]?.starters : lu?.[side]?.subs;
    const p = (list || []).find((x) => String(x.id) === id);
    if (!p) return null;
    const mine = playerShots(m, p, side);
    const goals = mine.filter((s) => s.type === "Goal" && !s.ownGoal), ogs = mine.filter((s) => s.ownGoal);
    const hd = h("div", { class: "pop-hd" }, [
      avatar(p, side, "sm"),
      h("div", {}, [h("div", { class: "pop-n", text: p.name }), h("div", { class: "pop-s", text: `${team(side).abbr} · ${p.num ? `#${p.num} · ` : ""}${POS_LONG[p.pos] || p.pos}${kind === "sub" ? " · bench" : ""}` })]),
      p.rating != null ? h("div", { class: `pop-r ${ratingCls(p.rating)}`, text: p.rating.toFixed(1) }) : null,
    ]);
    box.appendChild(hd);
    const num = (v, l) => h("div", {}, [h("b", { text: v }), h("i", { text: l })]);
    const ga = goals.length || p.events.includes("assist") ? `${goals.length}G${p.events.includes("assist") ? " 1A" : ""}` : "—";
    box.appendChild(h("div", { class: "pop-nums" }, [num(sumXg(mine).toFixed(2), "xG"), num(`${mine.length} (${mine.filter((s) => s.onTarget).length})`, "Shots (on target)"), num(ga, "Goals · assists")]));
    const ev = [];
    for (const g of goals) ev.push(`Goal ${fmtMin(g)}`);
    for (const g of ogs) ev.push(`Own goal ${fmtMin(g)}`);
    if (p.events.includes("assist")) ev.push("Assist");
    if (p.events.includes("yellowCard")) ev.push("Yellow card");
    if (p.events.includes("redCard")) ev.push("Red card");
    if (ev.length) box.appendChild(h("div", { class: "pop-ev", text: ev.join(" · ") }));
    const pj = findByName(m.playerProj?.[side], p.name); if (pj) row("Projected", `${pj.projSOT.toFixed(1)} SOT · ${Math.round(pj.scoreProb * 100)}% to score (model est.)`);
    const fd = findByName(m.fdScorers, p.name, "player"); if (fd) row("FanDuel anytime", `${fmtAm(fd.ml)}${fd.implied != null ? ` (${Math.round(fd.implied * 100)}%)` : ""}`);
    if (p.pos === "GK") { const k = (m.keepers || []).find((k) => k.abbr === team(side).abbr); if (k) keeperRows(k); }
    return box;
  }
  if (key.startsWith("shot-")) {
    const s = (P.shots || []).find((x) => `shot-${x.id}` === key);
    if (!s) return null;
    const kind = s.type === "Goal" ? (s.ownGoal ? "Own goal" : "GOAL") : s.type === "AttemptSaved" ? "Saved" : s.type === "Post" ? "Hit the post" : s.blocked ? "Blocked" : "Missed";
    head(s.player, `${team(s.side).abbr} · ${fmtMin(s)}`);
    row(kind, `${s.xg.toFixed(2)} xG${s.xgot != null && s.onTarget ? ` · ${s.xgot.toFixed(2)} xGOT` : ""}`, s.type === "Goal" ? "up" : "");
    const words = (t) => (t || "").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
    row("How", `${words(s.shotType)} · ${words(s.situation)} · ${s.inBox ? "inside" : "outside"} the box`);
    return box;
  }
  if (key.startsWith("goal-")) {
    const side = sideOf(key), k = (m.keepers || []).find((k) => k.abbr === team(side).abbr), against = shotsOf(oppo(side));
    head(`${team(side).abbr} goal`, k ? k.name : "keeper");
    if (k) keeperRows(k);
    else if (m.pregameProj?.saves) { const s = m.pregameProj.saves[side]; row("Saves projected", `${s.proj.toFixed(1)} · O${s.line} ${Math.round(s.pOver * 100)}%${s.odds != null ? ` (${fmtAm(s.odds)})` : ""}`); }
    if (against.length) row("Faced", `${against.length} shots · ${against.filter((s) => s.onTarget).length} on target · ${sumXg(against).toFixed(2)} xG · ${against.filter((s) => s.type === "Goal").length} conceded`);
    if (m.xg?.xgot) row("xGOT against", (side === "home" ? m.xg.xgot.away : m.xg.xgot.home).toFixed(2));
    return box;
  }
  if (key.startsWith("corners-")) {
    const side = sideOf(key), c = m.corners;
    head(`${team(side).abbr} corners`, "attacking end");
    if (c) {
      row("Won", String(side === "home" ? c.home : c.away));
      if (!c.settled) row("Projected", `${(side === "home" ? c.projH : c.projA).toFixed(1)} · total ${c.totalProj.toFixed(1)}`);
      row(`Total O${c.line}`, c.settled ? `final ${c.total} · ${c.over ? "over ✓" : "under ✗"}` : c.need <= 0 ? "already over ✓" : `${Math.round(c.pOver * 100)}%${c.odds != null ? ` (${fmtAm(c.odds)})` : ""}`);
    } else if (m.pregameProj?.corners) {
      const pc = m.pregameProj.corners;
      row("Projected", `${(side === "home" ? pc.home : pc.away).toFixed(1)} · total ${pc.total.toFixed(1)}`);
      row(`Total O${pc.line}`, `${Math.round(pc.pOver * 100)}%${pc.odds != null ? ` (${fmtAm(pc.odds)})` : ""}`);
    } else note("Corner counts arrive with the live box score.");
    note("Display only — corners are benched from the card.");
    return box;
  }
  if (key.startsWith("box-")) {
    const side = sideOf(key), inBox = shotsOf(side).filter((s) => s.inBox), outBox = shotsOf(side).filter((s) => !s.inBox);
    head(`${team(side).abbr} in the box`, "attacking");
    row("Inside the box", `${inBox.length} shots · ${inBox.filter((s) => s.onTarget).length} on target · ${sumXg(inBox).toFixed(2)} xG`);
    row("Outside the box", `${outBox.length} shots · ${outBox.filter((s) => s.onTarget).length} on target · ${sumXg(outBox).toFixed(2)} xG`);
    if (m.xg?.bigChances) row("Big chances", `${side === "home" ? m.xg.bigChances.home : m.xg.bigChances.away}${m.xg.bigChancesMissed ? ` (${side === "home" ? m.xg.bigChancesMissed.home : m.xg.bigChancesMissed.away} missed)` : ""}`);
    if (P.zones?.[side]) { const z = P.zones[side]; row("Attacks by flank", `L ${z.left}% · C ${z.center}% · R ${z.right}%`); }
    return box;
  }
  if (key === "centre") {
    head("Match state", m.statusText);
    if (m.possession) row("Possession", `${m.home.abbr} ${m.possession.home}% · ${m.possession.away}% ${m.away.abbr}`);
    if (m.momentum?.length) { const tail = m.momentum.slice(-10); const v = tail.reduce((a, d) => a + d.v, 0) / tail.length; row("Momentum · last 10", `${v >= 0 ? m.home.abbr : m.away.abbr} pressing ${Math.abs(v).toFixed(0)}`); }
    if (m.prediction) row("Model", `${m.home.abbr} ${Math.round(m.prediction.wH * 100)}% · draw ${Math.round(m.prediction.wD * 100)}% · ${m.away.abbr} ${Math.round(m.prediction.wA * 100)}% → ${m.prediction.ph}–${m.prediction.pa}`);
    if (m.odds) row("Market", `${m.home.abbr} ${m.odds.home.ml} · draw ${m.odds.draw.ml} · ${m.away.abbr} ${m.odds.away.ml}`);
    if (m.dominance) row("Dominance", `${m.dominance.leader} ${m.dominance.pct}%`);
    return box;
  }
  return null;

  function keeperRows(k) {
    row("Saves", `${k.saves}${k.faced ? ` of ${k.faced} faced` : ""} · ${k.ga} conceded`);
    if (k.line && !k.line.settled) row(`Saves O${k.line.value}`, k.line.need <= 0 ? "already over ✓" : `proj ${k.line.proj.toFixed(1)} · ${Math.round(k.line.pOver * 100)}%${k.line.odds != null ? ` (${fmtAm(k.line.odds)})` : ""}`);
    else if (k.line && k.line.settled) row(`Saves O${k.line.value}`, `final ${k.saves} · ${k.line.over ? "over ✓" : "under ✗"}`);
  }
}

// ── MATCH SHEET: the cards below the pitch as four reads — timeline · comparison + players ·
// market row · lines tiles. Replaces the old stats / xG / top performers / odds / public betting /
// keepers / corners / events / conditions / recommended cards; nothing they showed is dropped.
function matchSheet(m) {
  const out = [];
  const cardEl = (title, sub, kids, cls = "") => h("section", { class: `card ${cls}` }, [h("div", { class: "card-h" }, [h("span", { class: "card-t", text: title }), sub ? h("span", { class: "card-s", text: sub }) : null]), ...kids]);
  const homeAb = m.home.abbr, awayAb = m.away.abbr;

  // --- timeline (goals · cards · subs), home lane above the axis, away below ---
  const evs = (m.events || []).map((e) => {
    const mm = String(e.min || "").match(/(\d+)(?:'?\s*\+\s*(\d+))?/);
    const t = (e.type || "").toLowerCase();
    const kind = t.includes("goal") || t.includes("penalty - scored") ? "goal" : t.includes("red") ? "rc" : t.includes("yellow") ? "yc" : t.includes("substitution") ? "sub" : null;
    return mm && kind ? { min: Number(mm[1]), add: Number(mm[2] || 0), kind, side: e.teamAbbr === homeAb ? "home" : e.teamAbbr === awayAb ? "away" : null, who: e.players || "", og: t.includes("own") } : null;
  }).filter((e) => e && e.side);
  if (evs.length) {
    const span = Math.max(93, ...evs.map((e) => e.min + e.add)) + 2;
    const lane = (side) => {
      const mine = evs.filter((e) => e.side === side);
      const xs = [];
      for (const e of mine) { let x = (e.min + e.add * 0.3) / span * 100; if (xs.length && x - xs[xs.length - 1] < 6.5) x = xs[xs.length - 1] + 6.5; xs.push(Math.min(x, 100)); }
      return h("div", { class: `lane ${side}` }, mine.map((e, i) => {
        const who = e.kind === "sub" ? "sub" : (e.who.split(",")[0] || "").split(" ").pop() + (e.og ? " (OG)" : "");
        return h("div", { class: `tm ${e.kind} r${i % 2}`, style: { left: `${xs[i].toFixed(1)}%` }, title: `${e.min}${e.add ? "+" + e.add : ""}' ${e.who}` }, [e.kind === "goal" ? ballSvg("tball") : h("i", { class: e.kind }), h("span", { text: `${e.min}${e.add ? "+" + e.add : ""}′ ${who}` })]);
      }));
    };
    out.push(cardEl("Timeline", "goals · cards · subs · minute by minute", [h("div", { class: "tl" }, [
      h("span", { class: "lbl home", text: homeAb }), h("span", { class: "lbl away", text: awayAb }),
      h("div", { class: "axis" }), h("div", { class: "half", style: { left: `calc(18px + ${(45 / span * 100).toFixed(1)}% * 0.96)` } }),
      lane("home"), lane("away"),
    ])]));
  }

  // --- team comparison: mirrored bars from a centre label column ---
  const rows = [];
  const num = (s) => parseFloat(String(s).replace(/[^\d.]/g, "")) || 0;
  if (m.possession) rows.push(["Possession", m.possession.home, m.possession.away, `${m.possession.home}%`, `${m.possession.away}%`]);
  if (m.xg) {
    rows.push(["Expected goals", m.xg.home.xg, m.xg.away.xg, m.xg.home.xg.toFixed(2), m.xg.away.xg.toFixed(2)]);
    if (m.xg.xgot) rows.push(["xG on target", m.xg.xgot.home, m.xg.xgot.away, m.xg.xgot.home.toFixed(2), m.xg.xgot.away.toFixed(2)]);
    rows.push(["Shots (on target)", m.xg.home.shots, m.xg.away.shots, `${m.xg.home.shots} (${m.xg.home.sot})`, `${m.xg.away.shots} (${m.xg.away.sot})`]);
    if (m.xg.bigChances) rows.push(["Big chances", m.xg.bigChances.home, m.xg.bigChances.away, `${m.xg.bigChances.home}${m.xg.bigChancesMissed ? ` · ${m.xg.bigChancesMissed.home} missed` : ""}`, `${m.xg.bigChances.away}${m.xg.bigChancesMissed ? ` · ${m.xg.bigChancesMissed.away} missed` : ""}`]);
  }
  if (m.corners) rows.push(["Corners", m.corners.home, m.corners.away, String(m.corners.home), String(m.corners.away)]);
  for (const s of m.stats || []) {
    if (/shots|corner|possession/i.test(s.label) && (m.xg || m.corners)) continue;
    rows.push([s.label, num(s.home), num(s.away), s.home, s.away]);
  }
  const cmpKids = rows.map(([label, hv, av, ht, at]) => {
    const mx = Math.max(hv, av) || 1;
    return h("div", { class: "cmp" }, [
      h("span", { class: `cv${hv > av ? " lead" : ""}`, text: ht }),
      h("div", { class: "cbar l" }, [h("div", { class: `cl${hv >= av ? " lead" : ""}`, style: { width: `${(hv / mx * 100).toFixed(1)}%` } })]),
      h("div", { class: "ck", text: label }),
      h("div", { class: "cbar r" }, [h("div", { class: `cr${av >= hv ? " lead" : ""}`, style: { width: `${(av / mx * 100).toFixed(1)}%` } })]),
      h("span", { class: `cv r${av > hv ? " lead" : ""}`, text: at }),
    ]);
  });
  if (m.form) cmpKids.push(h("div", { class: "cmp form" }, [
    h("span", { class: "formrow" }, (m.form.home || []).map((r) => h("i", { class: r, text: r }))), h("div"), h("div", { class: "ck", text: "Form · last 5" }), h("div"),
    h("span", { class: "formrow r" }, (m.form.away || []).map((r) => h("i", { class: r, text: r }))),
  ]));
  if (m.xg) cmpKids.push(h("div", { class: "foot", text: "xG = chance quality (a 0.30 shot ≈ 30% to score) · xGOT = xG after where the shot went · big chances = clear-cut, from FotMob" }));
  const cmpCard = cmpKids.length ? cardEl("Team comparison", "ESPN · FotMob · solid bar = the leader", cmpKids) : null;

  // --- players table: starters + subs who played, top rated plus everyone with real chances ---
  const lu = m.pitch?.lineups;
  let people = [];
  if (lu) for (const side of ["home", "away"]) {
    for (const p of lu[side]?.starters || []) people.push({ ...p, side, bench: false });
    for (const p of lu[side]?.subs || []) if (p.rating != null) people.push({ ...p, side, bench: true });
  }
  people = people.map((p) => { const mine = playerShots(m, p, p.side); return { ...p, mine, xg: sumXg(mine), goals: mine.filter((s) => s.type === "Goal" && !s.ownGoal).length, og: mine.some((s) => s.ownGoal) }; });
  people.sort((a, b) => (b.rating || 0) - (a.rating || 0));
  const picked = new Map();
  for (const p of people.slice(0, 8)) picked.set(p.id, p);
  for (const p of people) if (p.xg >= 0.15) picked.set(p.id, p);
  const tableRows = [...picked.values()].sort((a, b) => (b.rating || 0) - (a.rating || 0));
  let playersCard = null;
  if (tableRows.length) {
    const hdr = h("div", { class: "ptr h" }, ["", "Player", "Rating", "xG", "Shots", "G", "A", "Events"].map((t) => h("span", { text: t })));
    playersCard = cardEl("Players", "top rated + everyone with real chances · sorted by rating", [hdr, ...tableRows.map((p) => {
      const ev = [];
      for (const g of p.mine.filter((s) => s.type === "Goal" && !s.ownGoal)) ev.push(`Goal ${fmtMin(g)}`);
      if (p.og) ev.push("Own goal");
      if (p.events.includes("assist")) ev.push("Assist");
      if (p.events.includes("yellowCard")) ev.push("Yellow card");
      if (p.events.includes("redCard")) ev.push("Red card");
      return h("div", { class: "ptr" }, [
        avatar(p, p.side, "xs"),
        h("span", { class: "tn" }, [txt(p.name), h("em", { text: `${(p.side === "home" ? homeAb : awayAb)} · ${p.pos}${p.bench ? " · sub" : ""}` })]),
        h("span", { class: `trt ${ratingCls(p.rating)}`, text: p.rating != null ? p.rating.toFixed(1) : "—" }),
        h("span", { text: p.xg.toFixed(2) }), h("span", { text: `${p.mine.length} (${p.mine.filter((s) => s.onTarget).length})` }),
        h("span", { text: p.goals ? String(p.goals) : "–" }), h("span", { text: p.events.includes("assist") ? "1" : "–" }),
        h("span", { class: "tev", text: ev.join(" · ") }),
      ]);
    })]);
  } else if (m.topPlayers || (m.xg && m.xg.players.length)) {
    // no lineup yet: the flat lists the old cards carried
    const kids = [];
    for (const side of ["home", "away"]) for (const x of m.topPlayers?.[side] || []) kids.push(h("div", { class: "gk" }, [h("span", { text: `${side === "home" ? homeAb : awayAb} ${x.name}` }), h("span", { class: "est", text: x.rating.toFixed(1) })]));
    for (const x of m.xg?.players || []) if (x.xg >= 0.05) kids.push(h("div", { class: "gk" }, [h("span", { text: `${x.side === "home" ? homeAb : awayAb} ${x.name}${x.goals ? " ⚽" + x.goals : ""}` }), h("span", { class: "est", text: `${x.xg.toFixed(2)} xG · ${x.sot} on target` })]));
    if (kids.length) playersCard = cardEl("Players", "FotMob rating · xG", kids);
  }
  if (cmpCard || playersCard) out.push(h("div", { class: "two sheet2" }, [cmpCard || h("div"), playersCard || h("div")]));

  // --- market row: odds · public betting · recommended ---
  const mk = [];
  const done = m.state === "post";
  // the result, once there is one: which 1X2 side landed, total goals, both scored
  const hs = m.home.score ?? 0, as = m.away.score ?? 0;
  const winner = !done ? null : hs > as ? "home" : as > hs ? "away" : "draw";
  if (m.odds) {
    const o = m.odds;
    const src = done ? "FanDuel · settled" : o.source === "live" ? "FanDuel · live" : o.source === "pre" ? "FanDuel · pre" : o.source === "fanduel-an" ? "FanDuel" : `${o.provider || "book"} · pre`;
    const ob = (ml, lbl, prob, side) => h("div", { class: `ob${done ? (winner === side ? " won" : " lost") : ""}` }, [h("b", { text: `${ml}${done && winner === side ? " ✓" : ""}` }), h("i", { text: `${lbl}${prob != null ? ` · implied ${prob}%` : ""}` }), prob != null ? h("div", { class: "p" }, [h("span", { style: { width: `${prob}%` } })]) : null]);
    const kids = [h("div", { class: "odds3" }, [ob(o.home.ml, homeAb, o.home.prob, "home"), ob(o.draw.ml, "Draw", o.draw.prob, "draw"), ob(o.away.ml, awayAb, o.away.prob, "away")])];
    if (o.home.best) {
      const cell = (s, ab) => h("span", { text: `${ab} ${s.best} ${bookName(s.bestBook)}${s.beatsFd ? " ▲" : ""}`, class: s.beatsFd ? "up" : "" });
      kids.push(h("div", { class: "odds" }, [h("div", { class: "label best-lbl", text: "Best price across books" }), h("div", { class: "row best" }, [cell(o.home, homeAb), cell(o.draw, "Draw"), cell(o.away, awayAb)])]));
    }
    mk.push(cardEl(done ? "Close" : "Odds", `${src} · bar = implied chance, vig removed`, kids));
  }
  if (m.publicBetting && m.publicBetting.outcomes) {
    const pb = m.publicBetting;
    const hasData = (c) => c && c.tickets != null && !(c.tickets === 0 && c.money === 0);
    const line = (lbl, c, tags = [], hit = null) => h("div", { class: `pub${hit == null ? "" : hit ? " hit" : " miss"}` }, [
      h("span", { text: `${lbl}${tags.length ? ` (${tags.join(", ")})` : ""}${hit == null ? "" : hit ? " ✓" : " ✗"}` }),
      h("div", { class: "pb" }, [h("div", { class: "t" }, [h("span", { style: { width: `${c.tickets}%` } })]), h("div", { class: "m" }, [h("span", { style: { width: `${c.money}%` } })])]),
      h("span", { class: "pv" }, [h("b", { text: `${c.tickets}%` }), txt(" · "), h("em", { text: `${c.money}%` })]),
    ]);
    const kids = [h("div", { class: "legend" }, [h("span", {}, [h("i", { class: "t" }), txt("tickets · share of slips")]), h("span", {}, [h("i", { class: "m" }), txt("money · share of dollars")]), h("span", { class: "hint", text: "money ahead of tickets = bigger bets lean there" })])];
    for (const side of ["home", "draw", "away"]) {
      const c = pb.outcomes[side]; if (!hasData(c)) continue;
      const tags = []; if (side === pb.publicSide) tags.push("public"); if (pb.fade && side === pb.fade.sharpSide) tags.push("sharp lean");
      kids.push(line(`${sideLabel(side, m)}${c.odds != null ? ` ${fmtAm(c.odds)}` : ""}`, c, tags, done ? winner === side : null));
    }
    if (pb.spread && hasData(pb.spread.home)) kids.push(line(`${homeAb} ${pb.spread.home.line > 0 ? "+" : ""}${pb.spread.home.line}`, pb.spread.home, [], done ? hs + pb.spread.home.line > as : null));
    if (pb.total && hasData(pb.total.over)) kids.push(line(`Over ${pb.total.line}`, pb.total.over, [], done ? hs + as > pb.total.line : null));
    mk.push(cardEl("Public betting", done ? "Action Network · how it landed" : "Action Network", kids));
  }
  if (done) {
    const cell = (mkt, pick, verdict, cls = "v-pass") => h("div", { class: `cell ${cls}` }, [h("div", { class: "cell-line" }, [h("span", { class: "mk", text: mkt }), h("span", { class: "pick", text: pick })]), h("div", { class: "cell-line" }, [h("span", { class: "verdict", text: verdict })])]);
    const fav = m.odds ? (m.odds.home.prob >= m.odds.away.prob && m.odds.home.prob >= (m.odds.draw.prob || 0) ? "home" : m.odds.away.prob >= (m.odds.draw.prob || 0) ? "away" : "draw") : null;
    const total = hs + as, tl = m.publicBetting?.total?.line;
    const kids = [h("div", { class: "recs" }, [
      cell("FT", `${homeAb} ${hs}–${as} ${awayAb}`, winner === "draw" ? "Draw" : `${winner === "home" ? homeAb : awayAb} win${fav ? (fav === winner ? " · favourite landed" : " · favourite beaten") : ""}`, winner !== "draw" && fav === winner ? "v-bet" : "v-fade"),
      cell("O/U", `${total} goals${tl != null ? ` · ${total > tl ? "over" : "under"} ${tl}` : ""}`, m.prediction?.pOver25 != null ? `pre-match Over 2.5 ${Math.round(m.prediction.pOver25 * 100)}% · ${total > 2.5 ? "over" : "under"} hit` : `${total > 2.5 ? "over" : "under"} 2.5`, total > 2.5 ? "v-lean" : "v-pass"),
      cell("BTTS", hs > 0 && as > 0 ? "Yes" : "No", m.prediction?.pBTTS != null ? `pre-match ${Math.round(m.prediction.pBTTS * 100)}% yes` : "both teams to score", hs > 0 && as > 0 ? "v-lean" : "v-pass"),
    ])];
    mk.push(cardEl("Result", "settled from the box score", kids));
  } else if (m.recs && m.recs.length) {
    const note = m.dominance ? `${m.dominance.leader} ${m.dominance.pct}% dominance` : m.recsBasis || "";
    mk.push(cardEl("Recommended", note, [recCells(m, true)]));
  }
  if (mk.length) out.push(h("div", { class: `market c${mk.length}` }, mk));

  // --- lines tiles: keepers · corners · conditions (projections pre-match) ---
  const tiles = [];
  const tile = (big, em, lbl, emCls = "") => h("div", { class: "lt" }, [h("b", {}, [txt(big), em ? h("em", { class: emCls, text: em }) : null]), h("i", { text: lbl })]);
  for (const k of m.keepers || []) {
    let em = "", cls = "";
    if (k.line && !k.line.settled) { em = k.line.need <= 0 ? `O${k.line.value} ✓` : `O${k.line.value} ${Math.round(k.line.pOver * 100)}%`; cls = k.line.need <= 0 ? "" : "dim"; }
    else if (k.line && k.line.settled) { em = `O${k.line.value} ${k.line.over ? "✓" : "✗"}`; cls = k.line.over ? "" : "neg"; }
    tiles.push(tile(`${k.saves} sv`, em, `${k.name} · ${k.line && !k.line.settled ? `proj ${k.line.proj.toFixed(1)}${k.line.odds != null ? ` · ${fmtAm(k.line.odds)}` : ""}` : "saves line · final"}`, cls));
  }
  if (!m.keepers?.length && m.pregameProj?.saves) for (const side of ["home", "away"]) { const s = m.pregameProj.saves[side]; tiles.push(tile(`${s.proj.toFixed(1)}`, `O${s.line} ${Math.round(s.pOver * 100)}%`, `${side === "home" ? homeAb : awayAb} keeper saves · projected${s.odds != null ? ` · ${fmtAm(s.odds)}` : ""}`, "dim")); }
  if (m.corners) {
    const c = m.corners;
    if (c.settled) tiles.push(tile(String(c.total), `O${c.line} ${c.over ? "✓" : "✗"}`, `Corners · ${homeAb} ${c.home} · ${awayAb} ${c.away} · display only`, c.over ? "" : "neg"));
    else tiles.push(tile(`${c.home + c.away}`, c.need <= 0 ? `O${c.line} ✓` : `O${c.line} ${Math.round(c.pOver * 100)}%`, `Corners · ${homeAb} ${c.home} → ${c.projH.toFixed(1)} · ${awayAb} ${c.away} → ${c.projA.toFixed(1)} · proj ${c.totalProj.toFixed(1)}${c.odds != null ? ` · ${fmtAm(c.odds)}` : ""}`, c.need <= 0 ? "" : "dim"));
  } else if (m.pregameProj?.corners) { const pc = m.pregameProj.corners; tiles.push(tile(pc.total.toFixed(1), `O${pc.line} ${Math.round(pc.pOver * 100)}%`, `Corners projected · ${homeAb} ${pc.home.toFixed(1)} · ${awayAb} ${pc.away.toFixed(1)}${pc.odds != null ? ` · ${fmtAm(pc.odds)}` : ""}`, "dim")); }
  if (m.conditions) {
    const cd = m.conditions;
    const rest = `${homeAb} ${cd.home.restDays != null ? `${cd.home.restDays}d` : "—"} · ${awayAb} ${cd.away.restDays != null ? `${cd.away.restDays}d` : "—"}`;
    tiles.push(tile(cd.venue ? `${cd.venue.alt}m` : rest, cd.venue ? cd.venue.heatLabel : "rest", cd.venue ? `${cd.venue.name || "Venue"} · rest ${rest}` : "Conditions · days since last game", "dim"));
  }
  if (tiles.length) out.push(h("div", { class: `lines4 c${Math.min(4, tiles.length)}` }, tiles));
  return out;
}

// recommendation cells (the match view's top picks; the sheet's Recommended card)
function recCells(m, full) {
  const picks = full ? m.recs : pickTop(m.recs, 2);
  const recs = h("div", { class: "recs" });
  for (const r of picks) {
    const tag = r.conf.split(" ")[0];
    const cls = tag === "Strong" ? "v-bet" : tag === "Lean" ? "v-lean" : "v-pass";
    const [pick, det] = splitBet(r.bet);
    recs.appendChild(h("div", { class: `cell ${cls}` }, [
      h("div", { class: "cell-line" }, [h("span", { class: "mk", text: mkOf(pick) }), h("span", { class: "pick", text: pick })]),
      h("div", { class: "cell-line" }, [h("span", { class: "verdict", text: `${r.conf}${det ? ` · ${det}` : ""}` }), full && r.text ? h("span", { class: "sub wrap", text: r.text }) : null]),
    ]));
  }
  const v = m.valueEdges && m.valueEdges[0];
  if (v && v.edge >= 0.08) {
    const stake = v.kelly > 0.002 ? ` · ½-Kelly ${(v.kelly * 100).toFixed(1)}%` : "";
    recs.appendChild(h("div", { class: "cell v-fade" }, [
      h("div", { class: "cell-line" }, [h("span", { class: "mk", text: "GAP" }), h("span", { class: "pick", text: `${v.label} · model ${Math.round(v.model * 100)}% vs market ${Math.round(v.mkt * 100)}%` }), h("span", { class: "price", text: `+${Math.round(v.edge * 100)}%` })]),
      h("div", { class: "cell-line" }, [h("span", { class: "verdict", text: `Model gap${stake}` }), h("span", { class: "sub", text: "divergence, not a guarantee" })]),
    ]));
  }
  const fade = m.publicBetting && m.publicBetting.fade;
  if (fade) {
    const pubAb = sideLabel(fade.publicSide, m), shAb = sideLabel(fade.sharpSide, m), pub = m.publicBetting.outcomes[fade.publicSide];
    recs.appendChild(h("div", { class: "cell v-sharp" }, [
      h("div", { class: "cell-line" }, [h("span", { class: "mk", text: "SHARP" }), h("span", { class: "pick", text: `Fade the public on ${pubAb} · money leans ${shAb}` })]),
      h("div", { class: "cell-line" }, [h("span", { class: "verdict", text: `${pubAb} ${pub.tickets}% tickets / ${pub.money}% money` }), h("span", { class: "sub", text: "contrarian signal, not a lock" })]),
    ]));
  }
  return recs;
}

// market shorthand for a recommendation's pick text
function mkOf(pick) {
  const s = (pick || "").toLowerCase();
  if (s.includes("both teams")) return "BTTS";
  if (/^(over|under)/.test(s)) return "O/U";
  if (s.includes("draw no bet") || s.includes("dnb")) return "DNB";
  if (s.includes("draw")) return "1X2";
  if (s.includes("corner")) return "CRN";
  return "ML";
}

// expanded layout: the flat blocks become cards (each .label starts one), balanced over two
// columns; the stat strip / header extras stay above, full-width sections and the disclaimer below
function flushCards(blocks) {
  const header = [], sections = [], full = [], footer = [];
  let cur = null;
  for (const b of blocks) {
    const cls = b.classList;
    if (cls && cls.contains("disc")) { footer.push(b); continue; }
    if (cls && cls.contains("label") && !cls.contains("best-lbl")) {
      cur = { full: cls.contains("full"), nodes: [b] };
      (cls.contains("full") ? full : sections).push(cur);
    } else if (cur) cur.nodes.push(b);
    else header.push(b);
  }
  const cardHead = (lbl, sub) => {
    const [t, ...rest] = lbl.textContent.split(" · ");
    return h("div", { class: `card-h${sub ? " sub-h" : ""}` }, [h("span", { class: "card-t", text: t }), rest.length ? h("span", { class: "card-s", text: rest.join(" · ") }) : null]);
  };
  const mkCard = (s) => {
    const sec = h("section", { class: "card" });
    s.nodes.forEach((n, i) => {
      if (i === 0) sec.appendChild(cardHead(n, false));
      else if (n.classList && n.classList.contains("label") && n.classList.contains("best-lbl")) sec.appendChild(cardHead(n, true));
      else sec.appendChild(n);
    });
    return sec;
  };
  const cols = [h("div", { class: "col" }), h("div", { class: "col" })];
  const weight = [0, 0];
  for (const s of sections) { const i = weight[0] <= weight[1] ? 0 : 1; cols[i].appendChild(mkCard(s)); weight[i] += s.nodes.length; }
  body.appendChild(frag(header));
  body.appendChild(h("div", { class: "two" }, [cols[0], cols[1]]));
  full.forEach((s) => body.appendChild(mkCard(s)));
  footer.forEach((f) => body.appendChild(f));
}
function pickTop(recs, n) {
  const actionable = recs.filter((r) => r.conf === "Strong lean" || r.conf === "Lean");
  return (actionable.length ? actionable : recs).slice(0, n);
}
function eventIcon(type) {
  const t = (type || "").toLowerCase();
  if (t.includes("goal") || t.includes("penalty") || t.includes("own")) return "⚽";
  if (t.includes("yellow")) return "🟨";
  if (t.includes("red")) return "🟥";
  if (t.includes("substitution")) return "🔁";
  if (t.includes("kickoff")) return "▶";
  if (t.includes("halftime") || t.includes("end")) return "⏸";
  return "•";
}

// ── BUILDER: lower third for the game on the board · board · slip rail ──────
const slipKey = (l) => `${l.game}|${l.market}|${l.pick}`;
// grade the slip exactly like parlays.gradeParlay (independence approximation across legs)
function gradeSlip(legs, stake) {
  if (!legs.length) return null;
  const dec = legs.reduce((p, l) => p * l.dec, 1);
  const modelProb = legs.reduce((p, l) => p * l.modelProb, 1);
  const impl = 1 / dec, b = dec - 1;
  const kelly = b > 0 ? Math.min(0.05, Math.max(0, (b * modelProb - (1 - modelProb)) / b / 2)) : 0;
  return { dec, american: decToAm(dec), modelProb, impl, edge: modelProb - impl, payout: stake * dec, ev: stake * (modelProb * dec - 1), kelly, fairAm: modelProb > 0 ? decToAm(1 / modelProb) : null };
}
// the verdict a board cell shows: where the leg sits vs the card's band, with the guards
function legVerdict(l) {
  const pct = Math.round(l.modelProb * 100);
  const e = l.rawEdge ?? l.edge ?? 0, ec = l.edge ?? 0;
  const eTxt = `${e >= 0 ? "+" : ""}${Math.round(e * 100)}% vs book${l.edge != null && Math.abs(l.edge - e) > 0.005 ? ` · ${ec >= 0 ? "+" : ""}${(ec * 100).toFixed(1)}% claimed` : ""}`;
  if (l.fair) return { cls: "v-pass", v: `Model line · ${pct}%`, sub: "no book price" };
  if (l.guard) return { cls: "v-pass", v: `Guarded · ${pct}%`, sub: l.guard };
  if (l.fadePublic) return { cls: "v-sharp", v: `Sharps fading · ${pct}%`, sub: eTxt };
  if (l.coherent === false) return { cls: "v-pass", v: `Vs script · ${pct}%`, sub: eTxt };
  if (e >= 0.03 && e < 0.07) return { cls: "v-bet", v: `Bet · ${pct}%`, sub: `${eTxt} · in band` };
  if (e >= 0.07) return { cls: "v-lean", v: `Too good? · ${pct}%`, sub: `${eTxt} · over band` };
  if (e >= 0.015) return { cls: "v-lean", v: `Lean · ${pct}%`, sub: eTxt };
  if (e <= -0.03) return { cls: "v-fade", v: `Fade · ${pct}%`, sub: eTxt };
  return { cls: "v-pass", v: `Pass · ${pct}%`, sub: eTxt };
}
const MK = { Moneyline: "ML", DNB: "DNB", Spread: "AH", Total: "O/U", TeamTotal: "TT", BTTS: "BTTS", Corners: "CRN", Scorer: "ATS" };
function legCell(l) {
  if (!l) return h("div", { class: "cell" }, [h("div", { class: "cell-line" }, [h("span", { class: "pick dim", text: "—" })])]);
  const on = builderSel.has(slipKey(l));
  const vd = legVerdict(l);
  const cell = h("div", { class: `cell clickable ${vd.cls}${on ? " selected" : ""}`, title: l.why || "" }, [
    h("div", { class: "cell-line" }, [h("span", { class: "mk", text: MK[l.market] || l.market }), h("span", { class: "pick", text: l.pick }), h("span", { class: "price", text: l.fair ? `fair ${fmtAm(l.ml)}` : fmtAm(l.ml) })]),
    h("div", { class: "cell-line" }, [h("span", { class: "verdict", text: vd.v }), h("span", { class: "sub", text: vd.sub })]),
  ]);
  cell.addEventListener("click", () => {
    const k = slipKey(l);
    if (builderSel.has(k)) builderSel.delete(k); else builderSel.set(k, l);
    builderMsg = null; render();
  });
  return cell;
}
const infoCell = (mk, text, sub = "") => h("div", { class: "cell" }, [
  h("div", { class: "cell-line" }, [mk ? h("span", { class: "mk", text: mk }) : null, h("span", { class: "pick dim", text })]),
  sub ? h("div", { class: "cell-line" }, [h("span", { class: "verdict dim", text: sub })]) : null,
]);
function boardRow(axis, name, prior, cells, { acc = false, end = false } = {}) {
  return h("div", { class: `brow${end ? " axis-end" : ""}` }, [
    h("div", { class: "slot" }, [h("span", { class: `slot-tag${acc ? " acc" : ""}`, text: axis }), h("span", { class: "slot-name", text: name }), prior ? h("span", { class: "slot-prior", text: prior }) : null]),
    ...cells,
  ]);
}
const colHead = (a, b, c, d) => h("div", { class: "colhead" }, [h("span", { text: a }), h("span", { text: b }), h("span", { text: c }), h("span", { text: d })]);

function renderBuilder(data) {
  subEl.textContent = "Parlay builder · model price vs FanDuel · OddsPapi line-shop";
  const wrap = h("div", { class: "split" });
  body.classList.add("split-host");
  if (!data) { wrap.appendChild(h("div", { class: "board-col" }, [spinner("Pricing the slate…")])); return wrap; }
  if (data.error) { wrap.appendChild(h("div", { class: "board-col" }, [h("div", { class: "center", text: `Couldn’t load: ${data.error}` })])); return wrap; }
  const games = data.games || [];
  if (!games.length) { wrap.appendChild(h("div", { class: "board-col" }, [emptyState("Nothing left to price on this slate.", "The builder prices games that haven't kicked off yet — the next slate opens in the morning.")])); return wrap; }
  // drop stale selections (legs no longer on the refreshed menu) so the grade stays honest
  const liveKeys = new Set();
  for (const g of games) for (const l of g.legs) liveKeys.add(slipKey(l));
  for (const k of [...builderSel.keys()]) if (!liveKeys.has(k)) builderSel.delete(k);
  const selected = [...builderSel.values()];
  // the game on the board: the chosen one, else the tracked match if it's on the menu, else first
  let game = games.find((g) => g.id === builderGame) || games.find((g) => last?.match && g.id === last.match.id) || games[0];
  builderGame = game.id;
  const [hAb, aAb] = game.game.split(" v ").map((s) => s.trim());
  const mt = (last?.matches || []).find((x) => x.id === game.id);
  const [hc] = kitPair(mt?.homeColor, mt?.awayColor, null);

  // lower third: the game + the model's headline numbers for it
  const ml = game.legs.filter((l) => l.market === "Moneyline");
  const fav = ml.length ? ml.reduce((a, b) => (b.modelProb > a.modelProb ? b : a)) : null;
  const facts = [];
  if (mt?.pred) facts.push(fact("Model", `${hAb} ${mt.pred.ph}–${mt.pred.pa}`));
  if (fav) {
    facts.push(fact("Fair line", `${fav.pick} ${fmtAm(decToAm(1 / fav.modelProb))}`, "acc"));
    facts.push(fact("FanDuel", `${fav.pick} ${fmtAm(fav.ml)}`, "book"));
  }
  if (data.goalsBias != null) facts.push(fact("Goals bias", `×${Number(data.goalsBias).toFixed(2)}`));
  if (data.trust != null) facts.push(fact("Edge trust", Number(data.trust).toFixed(2)));
  setThird([
    h("span", { class: "matchup" }, [crestFor(hAb, "sm"), txt(hAb), h("span", { class: "vs", text: "v" }), txt(aAb), crestFor(aAb, "sm")]),
    h("span", { class: "kick", text: mt ? `${fmtDay(mt.date)} ${fmtTime(mt.date)}${last?.match?.matchday ? ` · MD ${last.match.matchday}` : ""}` : data.date }),
    h("div", { class: "facts" }, facts),
  ], hc);
  setTicker([
    { text: "Derived markets ran 15pts overconfident at the World Cup · edges shrunk by learned trust", cls: "warn" },
    { text: "Two-axis guard: one result leg + one goals leg per game, never two from one axis" },
    { text: "Corners benched from the card · scorers display only", cls: "warn" },
    { text: SRC_LINE, cls: "src" },
  ]);

  // ---- the board ----
  const col = h("div", { class: "board-col" });
  const strip = h("div", { class: "gamestrip" });
  for (const g of games) {
    const n = [...builderSel.values()].filter((l) => l.game === g.game).length;
    strip.appendChild(h("span", { class: `gchip${g.id === game.id ? " active" : ""}`, onclick: () => { builderGame = g.id; render(); } }, [txt(g.game), n ? h("span", { class: "n", text: `${n} on slip` }) : null]));
  }
  col.appendChild(strip);
  const board = h("div", { class: "board" });
  const by = (mk) => game.legs.filter((l) => l.market === mk);
  const startsWith = (l, ab) => l.pick.startsWith(ab + " ") || l.pick === ab;
  // RESULT axis
  const mlH = ml.find((l) => l.pick === hAb), mlD = ml.find((l) => l.pick === "Draw"), mlA = ml.find((l) => l.pick === aAb);
  const dnb = by("DNB"), sp = by("Spread");
  if (ml.length || dnb.length || sp.length) {
    board.appendChild(colHead("Market", "Home", "Draw / middle", "Away"));
    const rows = [];
    if (ml.length) rows.push(boardRow("RESULT", "Moneyline", "3-way", [legCell(mlH), legCell(mlD), legCell(mlA)], { acc: true }));
    if (dnb.length) rows.push(boardRow("RESULT", "Draw no bet", "honest", [legCell(dnb.find((l) => startsWith(l, hAb))), infoCell("push", "stake back on a draw"), legCell(dnb.find((l) => startsWith(l, aAb)))]));
    const spH = sp.filter((l) => startsWith(l, hAb)), spA = sp.filter((l) => startsWith(l, aAb));
    for (let i = 0; i < Math.max(spH.length, spA.length); i++) rows.push(boardRow("RESULT", "Asian handicap", data.trust != null ? `trust ×${Number(data.trust).toFixed(2)}` : "derived", [legCell(spH[i]), infoCell("line", spH[i] ? spH[i].pick.replace(hAb, "").trim() : spA[i].pick.replace(aAb, "").trim(), "FanDuel"), legCell(spA[i])]));
    rows[rows.length - 1].classList.add("axis-end");
    rows.forEach((r) => board.appendChild(r));
  }
  // GOALS axis
  const tot = by("Total"), btts = by("BTTS"), tt = by("TeamTotal"), crn = by("Corners");
  if (tot.length || btts.length || tt.length || crn.length) {
    board.appendChild(colHead("Goals axis", "Over / yes", "Line", "Under / no"));
    const rows = [];
    const lines = [...new Set(tot.map((l) => l.pick.split(" ")[1]))];
    for (const L of lines) rows.push(boardRow("GOALS", "Match total", mt?.pred ? `λ ${(mt.pred.ph + mt.pred.pa).toFixed(1)}` : null,
      [legCell(tot.find((l) => l.pick === `Over ${L}`)), infoCell("line", L, "FanDuel"), legCell(tot.find((l) => l.pick === `Under ${L}`))], { acc: true }));
    if (btts.length) rows.push(boardRow("GOALS", "Both teams score", data.trust != null ? `trust ×${Number(data.trust).toFixed(2)}` : null, [legCell(btts.find((l) => l.pick === "Yes")), infoCell("src", "OddsPapi · best price"), legCell(btts.find((l) => l.pick === "No"))]));
    for (const ab of [hAb, aAb]) {
      const mine = tt.filter((l) => startsWith(l, ab));
      if (!mine.length) continue;
      const L = (mine[0].pick.match(/(\d+(?:\.\d+)?)$/) || [])[1] || "";
      rows.push(boardRow("GOALS", `${ab} team total`, "own λ", [legCell(mine.find((l) => /Over/.test(l.pick))), infoCell("line", L, teamName(ab)), legCell(mine.find((l) => /Under/.test(l.pick)))]));
    }
    if (crn.length) rows.push(boardRow("GOALS", "Corners", "benched", [legCell(crn.find((l) => /Over/.test(l.pick))), infoCell("line", (crn[0].pick.split(" ")[1] || ""), "36% hit at the WC · not on the card"), legCell(crn.find((l) => /Under/.test(l.pick)))]));
    rows[rows.length - 1].classList.add("axis-end");
    rows.forEach((r) => board.appendChild(r));
  }
  // PLAYER: scorers, display only
  const sc = by("Scorer");
  if (sc.length) {
    board.appendChild(colHead("Scorers · display only", "Model anytime", "Source", "Note"));
    for (const l of sc) {
      const name = l.pick.replace(/ anytime$/, "");
      board.appendChild(boardRow("PLAYER", name, `${Math.round(l.modelProb * 100)}% to score`, [
        legCell(l), infoCell("src", l.fair ? "model fair price" : "FanDuel anytime", l.fair ? "no book line posted" : ""), infoCell(null, "never auto-bet · no free close"),
      ]));
    }
  }
  board.appendChild(h("div", { class: "disc", text: "⚠ Model estimates, not financial advice. Combined % assumes legs are independent — same-game legs are correlated, so treat those parlays with extra caution." }));
  col.appendChild(board);
  wrap.appendChild(col);

  // ---- the slip rail ----
  const rail = h("aside", { class: "rail" });
  const nGames = new Set(selected.map((l) => l.game)).size;
  const stakeIn = h("input", { class: "stake" });
  stakeIn.type = "number"; stakeIn.min = "1"; stakeIn.step = "1"; stakeIn.value = String(builderStake);
  stakeIn.addEventListener("change", () => { builderStake = Math.max(1, Number(stakeIn.value) || 10); render(); });
  rail.appendChild(h("div", { class: "rail-head" }, [
    h("div", {}, [h("div", { class: "rail-title", text: "Your slip" }), h("div", { class: "rail-sub", text: selected.length ? `${selected.length} leg${selected.length === 1 ? "" : "s"} · ${nGames === 1 ? "same game" : `${nGames} games`}` : "empty" })]),
    h("span", { class: "stake-wrap" }, [txt("$"), stakeIn]),
  ]));
  const g = gradeSlip(selected, builderStake);
  if (!g) {
    rail.appendChild(h("div", { class: "empty-slip" }, [txt("Tap cells on the board to add legs. The model grades the combined parlay here: "), h("b", { text: "fair odds, edge, EV and a half-Kelly stake." })]));
  } else {
    for (const l of selected) rail.appendChild(h("div", { class: "sleg" }, [
      h("div", { class: "sleg-main" }, [h("span", { class: "sleg-label", text: `${l.pick}${l.market === "Total" || l.market === "TeamTotal" ? " goals" : l.market === "BTTS" ? " · BTTS" : l.market === "Corners" ? " corners" : ""}` }), h("span", { class: "sleg-game", text: `${l.game} · ${marketName(l.market)}` }), h("span", { class: "sleg-ml", text: `${fmtAm(l.ml)} · model ${pctR(l.modelProb)}` })]),
      h("button", { class: "rm", text: "✕", title: "Remove", onclick: () => { builderSel.delete(slipKey(l)); builderMsg = null; render(); } }),
    ]));
    const pbox = (label, odds, prob, sub, hl = false, cls = "") => h("div", { class: `pbox${hl ? " hl" : ""}` }, [h("span", { class: "pbox-label", text: label }), h("span", { class: `pbox-odds ${cls}`, text: odds }), h("span", { class: "pbox-prob", text: prob }), h("span", { class: "pbox-sub", text: sub })]);
    const edgePts = Math.round(g.edge * 1000) / 10;
    rail.appendChild(h("div", { class: "price-compare" }, [
      pbox("Model", g.fairAm == null ? "—" : fmtAm(g.fairAm), pctR(g.modelProb), "fair · indep. multiply"),
      pbox("Book", fmtAm(g.american), pctR(g.impl), "FanDuel · vig in", true),
      pbox("Edge", `${edgePts >= 0 ? "+" : ""}${edgePts}%`, `$${g.payout.toFixed(2)} pays`, "model − book", false, edgePts >= 0 ? "pos" : "neg"),
    ]));
    const evCls = g.edge > 0.02 ? "pos" : g.edge < -0.02 ? "neg" : "flat";
    rail.appendChild(h("div", { class: `evline ${evCls}`, text: `${g.ev >= 0 ? "+" : "−"}$${Math.abs(g.ev).toFixed(2)} EV on $${builderStake}` }));
    const verdict = g.edge > 0.02 ? "Model likes this." : g.edge < -0.02 ? "Model fades this." : "Coin flip vs the price.";
    rail.appendChild(h("div", { class: "tax" }, [
      h("div", { class: "tval", text: verdict }),
      h("div", { class: "tbody", text: g.kelly > 0.002 ? `Suggested stake ≈ ${(g.kelly * 100).toFixed(1)}% of bankroll (half-Kelly, capped at 5%).` : "Kelly says skip: no edge to size." }),
    ]));
    const warns = [];
    if (selected.length > nGames) warns.push("Legs from one game move together. The multiply above treats them as independent — a same-game slip's true odds sit off that number in whichever direction the legs correlate.");
    const derived = selected.filter((l) => !["Moneyline", "DNB"].includes(l.market) && !l.fair);
    if (derived.length && data.trust != null) warns.push(`${derived.length} derived-market leg${derived.length === 1 ? "" : "s"}: model claims shrunk to ${Math.round(data.trust * 100)}% trust.`);
    if (selected.some((l) => l.fair)) warns.push("A fair-priced scorer has no book line: the slip can't be placed as shown.");
    if (selected.some((l) => l.fadePublic)) warns.push("A leg is on a side sharper money is fading.");
    warns.push("CLV unknown until kickoff — a good bet is one that beats the close.");
    rail.appendChild(h("div", { class: "warnings" }, [h("div", { class: "wh", text: "Read before tracking" }), ...warns.map((w) => h("div", { class: "warn-line", text: w }))]));
    if (builderMsg) rail.appendChild(h("div", { class: `bld-msg ${builderMsg.ok ? "up" : "neg"}`, text: builderMsg.text }));
  }
  const trackBtn = h("button", { class: "track", text: `Track · $${builderStake}`, onclick: () => trackSlip(selected, data.date) });
  trackBtn.disabled = !selected.length || selected.some((l) => l.fair);
  rail.appendChild(h("div", { class: "actions" }, [trackBtn, h("button", { class: "clear", text: "Clear", onclick: () => { builderSel.clear(); builderMsg = null; render(); } })]));
  rail.appendChild(h("div", { class: "rail-src", text: `${data.date} · prices FanDuel · lines OddsPapi · xG FotMob` }));
  wrap.appendChild(rail);
  return wrap;
}
async function trackSlip(legs, date) {
  if (!legs.length) { builderMsg = { ok: false, text: "Add at least one leg first." }; render(); return; }
  builderMsg = { ok: true, text: "Tracking…" }; render();
  const payload = { stake: builderStake, date, legs: legs.map((l) => ({ id: l.id, game: l.game, market: l.market, pick: l.pick, modelProb: l.modelProb, ml: l.ml, dec: l.dec, edge: l.edge, rawEdge: l.rawEdge, why: l.why })) };
  const res = await window.wc.trackParlay(payload).catch((e) => ({ error: String(e?.message || e) }));
  if (res && res.ok) { builderMsg = { ok: true, text: `Tracked ✓ ${fmtAm(res.americanOdds)} — settles in Record as games finish.` }; builderSel.clear(); record = null; }
  else builderMsg = { ok: false, text: `Couldn’t track: ${res?.error || "unknown error"}` };
  render();
}

// ── RECORD ────────────────────────────────────────────────────────────────────
function renderRecord(data) {
  subEl.textContent = "Bet record · CLV · calibration · shadow fade";
  const wrap = h("div", { class: "record" });
  if (!data) { wrap.appendChild(spinner("Settling the log…")); return wrap; }
  if (data.error) { wrap.appendChild(h("div", { class: "center", text: `Couldn’t load: ${data.error}` })); return wrap; }
  const s = data.stats || {};
  const pct = (p) => (p == null ? "—" : `${Math.round(p * 100)}%`);
  const money = (v) => (v == null ? "—" : `${v >= 0 ? "+" : "−"}$${Math.abs(v).toFixed(2)}`);
  const tile = (v, k, c = "") => h("div", { class: "stat" }, [h("div", { class: `sv ${c}`, text: v }), h("div", { class: "sk", text: k })]);
  wrap.appendChild(h("div", { class: "today-head" }, [
    h("div", {}, [h("div", { class: "eyebrow", text: "All-time · settled legs" }), h("div", { class: "vh" }, [txt("Record "), h("span", { class: "sub", text: s.legs ? `${s.legs} legs · ${s.parlayWins || 0}/${s.parlays || 0} bets won` : "nothing settled yet" })])]),
    h("div", {}, [h("div", { class: "picks-sub", text: "Brier = calibration, lower is better" }), h("div", { class: "picks-sub", text: "CLV = bet price vs the pre-kickoff close" })]),
  ]));
  const tiles = [
    tile(s.legs ? pct(s.legHitRate) : "—", "Leg hit rate"),
    tile(s.brier == null ? "—" : s.brier.toFixed(3), "Brier"),
    tile(`${s.parlayWins || 0}/${s.parlays || 0}`, "Bets won"),
    tile(money(s.profit), "Profit", (s.profit ?? 0) >= 0 ? "up" : "neg"),
    tile(pct(s.roi), "ROI", (s.roi ?? 0) >= 0 ? "up" : "neg"),
  ];
  if (s.clv && s.clv.n) tiles.push(tile(`${s.clv.avgPts >= 0 ? "+" : ""}${(s.clv.avgPts * 100).toFixed(1)}`, `CLV pts · beat ${pct(s.clv.beatRate)} (${s.clv.n})`, s.clv.avgPts >= 0 ? "up" : "neg"));
  else tiles.push(tile("n=0", "CLV · no closes yet", "muted"));
  wrap.appendChild(h("div", { class: "stat-grid" }, tiles));
  if (!s.legs) wrap.appendChild(h("div", { class: "hint", text: "Stats fill in as games finish and settle each morning." }));

  const cards = h("div", { class: "two" });
  const left = h("div", { class: "col" }), right = h("div", { class: "col" });
  const card = (title, sub, kids) => h("section", { class: "card" }, [h("div", { class: "card-h" }, [h("span", { class: "card-t", text: title }), sub ? h("span", { class: "card-s", text: sub }) : null]), ...kids]);
  const kv = (a, b, cls = "est") => h("div", { class: "gk" }, [h("span", { text: a }), h("span", { class: cls, text: b })]);
  // bankroll trajectory
  {
    const asc = [...(data.days || [])].sort((a, b) => a.date.localeCompare(b.date));
    let cum = 0; const pts = [];
    for (const d of asc) { let dp = 0, any = false; for (const p of d.parlays || []) if (p.settled) { any = true; dp += p.result === "win" ? p.payout - p.stake : p.result === "push" ? 0 : -p.stake; } if (any) { cum += dp; pts.push(cum); } }
    const graph = pts.length >= 2 ? sparkline(pts, { cls: cum >= 0 ? "pl-up" : "pl-neg", midline: 0 }) : null;
    if (graph) left.appendChild(card("Bankroll", "cumulative P/L by slate", [h("div", { class: "probwrap" }, [graph]), h("div", { class: "winlegend" }, [h("span", { text: asc[0].date }), h("span", { class: cum >= 0 ? "up" : "neg", text: money(cum) })])]));
  }
  const rc = data.recent;
  if (rc && rc.legs) {
    const range = rc.from && rc.to && rc.from !== rc.to ? `${rc.from} → ${rc.to}` : rc.to || "";
    left.appendChild(card(`Recent · ${rc.windowDays} day${rc.windowDays > 1 ? "s" : ""}`, range, [h("div", { class: "stat-grid c3" }, [
      tile(`${pct(rc.legHitRate)}`, `Hit rate (${rc.legs})`), tile(rc.brier == null ? "—" : rc.brier.toFixed(3), "Brier"), tile(money(rc.profit), "Profit", (rc.profit ?? 0) >= 0 ? "up" : "neg"),
    ])]));
  }
  const f = s.fade;
  if (f && f.legs) {
    const kids = [h("div", { class: "stat-grid c3" }, [tile(pct(f.hitRate), `Fade hit rate (${f.legs})`, f.hitRate > 0.5 ? "up" : ""), tile(money(f.profit), "Est. profit", (f.profit ?? 0) >= 0 ? "up" : "neg"), tile(pct(f.roi), "Est. ROI", (f.roi ?? 0) >= 0 ? "up" : "neg")])];
    for (const b of f.byMarket || []) kids.push(kv(b.market, `fade hits ${pct(b.hitRate)} (n=${b.n})`));
    kids.push(h("div", { class: "hint", text: "Fade wins when the model's pick loses. $ est. = flat $10 on two-way markets, price inverted across the vig; Moneyline is 3-way so it counts toward hit rate only." }));
    right.appendChild(card("Shadow fade", "betting the opposite of every leg", kids));
  }
  if (s.calibration && s.calibration.length) right.appendChild(card("Calibration", "model % vs actual", s.calibration.map((b) => kv(b.bucket, `pred ${pct(b.predicted)} → hit ${pct(b.actual)} (n=${b.n})`))));
  const pa = data.projAccuracy;
  if (pa && (pa.corners || pa.shots)) {
    const kids = [];
    const accRow = (name, a) => { if (a) kids.push(kv(`${name} (n=${a.n})`, `avg proj ${a.projAvg.toFixed(1)} → actual ${a.actualAvg.toFixed(1)} · off by ${a.mae.toFixed(1)}`)); };
    accRow("Corners total", pa.corners); accRow("Total shots", pa.shots);
    right.appendChild(card("Projection accuracy", "model vs actual", kids));
  }
  if (data.goalsBias && data.goalsBias.factor != null) right.appendChild(card("Goals bias", "learned from settled totals", [kv("Goal-expectation factor", `×${Number(data.goalsBias.factor).toFixed(2)}${data.goalsBias.n != null ? ` (n=${data.goalsBias.n})` : ""}`)]));
  if (left.childElementCount || right.childElementCount) { cards.appendChild(left); cards.appendChild(right); wrap.appendChild(cards); }

  // history, newest day first, as tickets
  wrap.appendChild(h("div", { class: "today-head" }, [h("div", { class: "vh" }, [txt("History "), h("span", { class: "sub", text: "every logged bet, newest first" })]), h("div", { class: "picks-sub", text: "▲ beat the close · ▼ worse than the close" })]));
  if (!data.days || !data.days.length) wrap.appendChild(h("div", { class: "center", text: "No bets logged yet." }));
  for (const day of data.days || []) {
    wrap.appendChild(h("div", { class: "rec-day", text: day.date }));
    const grid = h("div", { class: "tk-grid" });
    for (const p of day.parlays) grid.appendChild(historyTicket(p));
    wrap.appendChild(grid);
  }
  wrap.appendChild(h("div", { class: "disc", text: "⚠ Player-prop legs can't auto-settle from the score; those bets stay pending." }));
  return wrap;
}
function historyTicket(p) {
  const result = p.settled ? p.result : "pending";
  const pl = result === "win" ? p.payout - p.stake : result === "loss" ? -p.stake : 0;
  const clvLegs = p.legs.filter((l) => l.closeMl != null && l.ml != null);
  let clvTxt = "—", clvCls = "";
  if (clvLegs.length) {
    const beat = clvLegs.filter((l) => amProb(l.ml) < amProb(l.closeMl)).length;
    clvTxt = `${beat}/${clvLegs.length} ${beat * 2 >= clvLegs.length ? "▲" : "▼"}`; clvCls = beat * 2 >= clvLegs.length ? "pos" : "neg";
  }
  const num = (v, l, c = "") => h("div", { class: "tk-num" }, [h("div", { class: `tk-num-v ${c}`, text: v }), h("div", { class: "tk-num-l", text: l })]);
  return ticket({ ...p, ev: 0, kelly: 0 }, {
    kind: p.type === "cross" ? "longshot · cross-game" : `${p.legs.length === 1 ? "single" : `${p.legs.length}-leg parlay`}`,
    game: p.type === "cross" ? "All games" : p.game, stake: p.stake, result,
    extraNums: [
      num(fmtAm(p.americanOdds), "odds"),
      num(`$${p.stake}→$${p.payout.toFixed(2)}`, "stake → pays"),
      num(pctR(p.modelProb), "model"),
      num(result === "pending" ? "…" : `${pl >= 0 ? "+" : "−"}$${Math.abs(pl).toFixed(2)}`, "P/L", result === "win" ? "pos" : result === "loss" ? "neg" : ""),
      num(clvTxt, "beat close", clvCls),
    ],
  });
}

// ── STANDINGS: league table, or the bracket once the phase is done ───────────
const fmtGD = (gd) => { const s = String(gd ?? ""); return /^[+-]/.test(s) || !(Number(s) > 0) ? s : `+${s}`; };
function renderStandings(data) {
  const wrap = h("div", { class: "stand" });
  if (!data) { subEl.textContent = "League table"; wrap.appendChild(spinner("Loading the table…")); return wrap; }
  if (data.error) { wrap.appendChild(h("div", { class: "center", text: `Couldn’t load: ${data.error}` })); return wrap; }
  if (data.groupStageDone) return renderBracket(wrap, data);
  if (!data.groups || !data.groups.length) { wrap.appendChild(emptyState("No standings yet.")); return wrap; }
  const ucl = /^ucl/.test((data.comp && data.comp.key) || "");
  const zoneLabel = (e) => e.zone === "adv" ? (ucl ? "R16" : "Through") : e.zone === "po" ? "Play-off" : e.advanced ? "Through" : "Out";
  const total = data.groups.reduce((n, g) => n + g.entries.length, 0);
  const played = Math.max(0, ...data.groups.flatMap((g) => g.entries.map((e) => e.played || 0)));
  subEl.textContent = ucl ? `League phase · ${total} clubs · 8 matchdays · top 8 straight to the R16` : `Group stage · ${data.groups.length} groups`;
  wrap.appendChild(h("div", { class: "today-head" }, [
    h("div", {}, [h("div", { class: "eyebrow", text: ucl ? `League phase · after MD ${played}` : "Group stage" }), h("div", { class: "vh" }, [txt("Table "), h("span", { class: "sub", text: (data.comp && data.comp.standingsHint) || "green = advancing" })])]),
    h("div", {}, [h("div", { class: "picks-sub", text: ucl ? "Two-legged ties from Feb · bracket replaces this once the phase ends" : "bracket replaces this once the groups finish" }), h("div", { class: "picks-sub", text: "tap a club to open its next game" })]),
  ]));
  const mine = new Set(last?.match ? [last.match.home.abbr, last.match.away.abbr] : []);
  // last result + next fixture per club, from the slate the widget already carries
  const games = (abbr) => (last?.matches || []).filter((mt) => mt.homeAbbr === abbr || mt.awayAbbr === abbr);
  const lastOf = (abbr) => {
    const done = games(abbr).filter((mt) => mt.state === "post").sort((a, b) => new Date(b.date) - new Date(a.date))[0];
    if (!done) return null;
    const home = done.homeAbbr === abbr, gf = home ? done.homeScore : done.awayScore, ga = home ? done.awayScore : done.homeScore;
    return { cls: gf > ga ? "w" : gf < ga ? "l" : "d", text: `${gf}–${ga} ${home ? "v" : "@"} ${home ? done.awayAbbr : done.homeAbbr}`, id: done.id };
  };
  const nextOf = (abbr) => {
    const up = games(abbr).filter((mt) => mt.state !== "post").sort((a, b) => new Date(a.date) - new Date(b.date))[0];
    if (!up) return null;
    const home = up.homeAbbr === abbr;
    return { abbr: home ? up.awayAbbr : up.homeAbbr, logo: home ? up.awayLogo : up.homeLogo, home, when: up.live ? (up.statusText || "LIVE") : `${fmtDay(up.date).replace(/,.*$/, "")} ${fmtTime(up.date)}`, id: up.id, live: !!up.live };
  };
  const CUT = { adv: "Places 1–8 · straight to the round of 16", po: "Places 9–24 · two-legged play-off in February for the last eight R16 spots", out: "Places 25–36 · out of Europe" };
  const headRow = () => h("div", { class: "tr h" }, ["#", "", "Club · domestic league", "P", "W-D-L", "GD", "Pts", "Last", "Next", "Zone"].map((t, i) => h("span", { class: i === 4 ? "wdl" : i === 7 ? "last" : i === 8 ? "next" : i === 9 ? "zone" : i === 0 ? "rk" : "", text: t })));
  const row = (e) => {
    const lr = lastOf(e.abbr), nx = nextOf(e.abbr);
    const z = e.zone || (e.advanced ? "adv" : "out");
    const r = h("div", { class: `tr ${z}${mine.has(e.abbr) ? " mine" : ""}`, title: `${e.name} · open the next game`, onclick: () => { const g = nx || lr; if (g) choose(g.id); } }, [
      h("span", { class: "rk", text: e.rank != null ? String(e.rank) : "" }),
      h("span", {}, [crest(e.abbr, e.logo, "xs")]),
      h("span", { class: "team" }, [txt(e.name || e.abbr), e.league ? h("em", { class: "lg", text: e.league }) : null]),
      h("span", { text: String(e.played) }),
      h("span", { class: "wdl", text: `${e.w}-${e.d}-${e.l}` }),
      h("span", { text: fmtGD(e.gd) }),
      h("span", { class: "pts", text: String(e.pts) }),
      h("span", { class: "last" }, [lr ? h("span", { class: `res ${lr.cls}`, text: lr.text }) : h("span", { class: "res d", text: "—" })]),
      h("span", { class: "next" }, [nx ? h("span", { class: `nx${nx.live ? " live" : ""}` }, [crest(nx.abbr, nx.logo, "xs"), h("b", { text: `${nx.home ? "v" : "@"} ${nx.abbr}` }), txt(nx.when)]) : h("span", { class: "nx", text: "—" })]),
      h("span", { class: "zone", text: zoneLabel(e) }),
    ]);
    if (mine.has(e.abbr)) r.appendChild(h("span", { class: "tracked", text: "tracked" }));
    return r;
  };
  for (const g of data.groups) {
    if (data.groups.length > 1) wrap.appendChild(h("div", { class: "eyebrow grp-name", text: g.name }));
    const tbl = h("div", { class: "tbl" }, [headRow()]);
    let lastZone = null;
    for (const e of g.entries) {
      const z = e.zone || (e.advanced ? "adv" : "out");
      // a labelled cut line where the zone changes (only when the competition has zones)
      if (ucl && z !== lastZone) { tbl.appendChild(h("div", { class: `cut ${z}` }, [h("i"), txt(CUT[z] || "")])); lastZone = z; }
      tbl.appendChild(row(e));
    }
    wrap.appendChild(tbl);
  }
  return wrap;
}

// bracket columns: winners flow left → right. ESPN doesn't expose which tie feeds which, so
// linkage is inferred — braces only draw once a column's pairings FULLY resolve.
function orderRounds(knockout) {
  const rounds = knockout.filter((r) => !/third|3rd/.test(r.slug)).map((r) => ({ ...r, games: [...r.games] }));
  for (let i = rounds.length - 2; i >= 0; i--) {
    const cur = rounds[i].games, next = rounds[i + 1].games;
    if (!next.length || cur.length !== next.length * 2) continue;
    const slots = new Array(cur.length).fill(null);
    const left = new Set(cur);
    next.forEach((ng, k) => {
      for (const g of [...left]) {
        const w = g.homeWin ? g.homeAbbr : g.awayWin ? g.awayAbbr : null;
        if (!w) continue;
        if (w === ng.homeAbbr && !slots[2 * k]) { slots[2 * k] = g; left.delete(g); }
        else if (w === ng.awayAbbr && !slots[2 * k + 1]) { slots[2 * k + 1] = g; left.delete(g); }
      }
      ng.fed = !!(slots[2 * k] && slots[2 * k + 1]);
    });
    rounds[i].linked = next.map((ng, k) => !!(slots[2 * k] && slots[2 * k + 1]));
    const rest = [...left];
    for (let j = 0; j < slots.length; j++) if (!slots[j]) slots[j] = rest.shift();
    rounds[i].games = slots;
    rounds[i].paired = true;
  }
  return rounds;
}
function brkCard(g, mine) {
  const done = g.state === "post", live = g.state === "in";
  const sc = (n) => (g.state === "pre" && !g.played ? "" : String(n));
  const row = (abbr, logo, score, win) => h("div", { class: `brk-t${done ? (win ? " win" : " out") : ""}` }, [crest(abbr, logo, "xs"), h("span", { class: "bt-ab", text: abbr }), h("span", { class: "bt-sc", text: score })]);
  const meta = [];
  if (live) meta.push(h("span", { class: "bt-live", text: g.statusText || "LIVE" }));
  else if (done) meta.push(h("span", { text: `FT${g.homeShoot != null || g.awayShoot != null ? ` · ${g.homeShoot ?? 0}–${g.awayShoot ?? 0} p` : ""}` }));
  else if (g.played && g.nextLeg) meta.push(h("span", { text: `2nd leg ${fmtMD(g.nextLeg)}` }));
  else meta.push(h("span", { text: fmtMD(g.date) }));
  if (g.legScores && g.legScores.some(Boolean)) meta.push(h("span", { class: "bt-legs", text: `agg · ${g.legScores.filter(Boolean).join(" · ")}` }));
  if (g.state === "pre" && g.pred) {
    const advH = g.pred.wH + g.pred.wD * 0.5;
    meta.push(h("span", { class: "brk-pred", text: `${advH >= 0.5 ? g.homeAbbr : g.awayAbbr} ${Math.round(Math.max(advH, 1 - advH) * 100)}%` }));
  }
  return h("div", { class: `brk-card${live ? " islive" : ""}${mine ? " mine" : ""}${g.fed ? " fed" : ""}`, onclick: () => choose(g.id) }, [
    row(g.homeAbbr, g.homeLogo, sc(g.homeScore), g.homeWin), row(g.awayAbbr, g.awayLogo, sc(g.awayScore), g.awayWin), h("div", { class: "bt-meta" }, meta),
  ]);
}
function renderBracket(wrap, data) {
  subEl.textContent = "Knockout bracket · winners flow left → right";
  if (!data.knockout || !data.knockout.length) { wrap.appendChild(emptyState("Knockout fixtures not posted yet.")); return wrap; }
  const mine = new Set(last?.match ? [last.match.home.abbr, last.match.away.abbr] : []);
  const isMine = (g) => mine.has(g.homeAbbr) || mine.has(g.awayAbbr);
  const cols = orderRounds(data.knockout);
  const third = data.knockout.find((r) => /third|3rd/.test(r.slug));
  if (third && third.games.length) cols.push({ slug: third.slug, label: third.label, games: [...third.games] });
  if (!cols.length) { wrap.appendChild(emptyState("No knockout games yet.")); return wrap; }
  wrap.appendChild(h("div", { class: "today-head" }, [
    h("div", {}, [h("div", { class: "eyebrow", text: "Knockout" }), h("div", { class: "vh" }, [txt("Bracket "), h("span", { class: "sub", text: "tap a tie to open it" })])]),
  ]));
  if (mine.size) {
    const treeCols = cols.filter((c) => !/third|3rd/.test(c.slug || ""));
    let team = null, p0 = null, idx = -1;
    outer: for (let i = 0; i < treeCols.length; i++) for (const g of treeCols[i].games) {
      if (g.state === "post") continue;
      const hMine = mine.has(g.homeAbbr), aMine = mine.has(g.awayAbbr);
      if (!hMine && !aMine) continue;
      if (last?.match?.id === g.id && last.match.advance) { const adv = last.match.advance; team = adv.home >= adv.away ? g.homeAbbr : g.awayAbbr; p0 = Math.max(adv.home, adv.away); }
      else if (g.pred) { const advH = g.pred.wH + g.pred.wD * 0.5; team = hMine ? g.homeAbbr : g.awayAbbr; p0 = hMine ? advH : 1 - advH; }
      idx = i; break outer;
    }
    if (team && p0 != null) {
      let p = p0; const parts = [];
      for (let i = idx + 1; i < treeCols.length; i++) { parts.push(`${roundShort(treeCols[i].slug) || treeCols[i].label} ${Math.round(p * 100)}%`); p *= 0.5; }
      parts.push(`🏆 ${Math.round(p * 100)}%`);
      wrap.appendChild(h("div", { class: "brk-path", text: `${team} path: ${parts.join(" → ")} · coin flips beyond the priced tie` }));
    }
  }
  const finalCol = cols.filter((c) => !/third|3rd/.test(c.slug || "")).pop();
  const finalGame = finalCol && finalCol.games.length === 1 ? finalCol.games[0] : null;
  const champAbbr = finalGame && finalGame.state === "post" ? (finalGame.homeWin ? finalGame.homeAbbr : finalGame.awayWin ? finalGame.awayAbbr : null) : null;
  const isChamp = (g) => !!champAbbr && (g.homeAbbr === champAbbr || g.awayAbbr === champAbbr);
  const card = (g) => { const c = brkCard(g, isMine(g)); if (isChamp(g)) c.classList.add("champ"); return c; };
  const brk = h("div", { class: "bracket" });
  const tree = h("div", { class: "brk-tree" });
  brk.style.setProperty("--rows", String(Math.max(...cols.map((r) => r.games.length))));
  for (const r of cols) {
    const col = h("div", { class: "brk-col" });
    col.appendChild(h("div", { class: "label brk-round", text: r.label }));
    const games = h("div", { class: "brk-col-games" });
    if (r.paired) for (let j = 0; j < r.games.length; j += 2) games.appendChild(h("div", { class: `brk-pair${r.linked[j / 2] ? " linked" : ""}` }, [card(r.games[j]), card(r.games[j + 1])]));
    else for (const g of r.games) games.appendChild(h("div", { class: "brk-slot" }, [card(g)]));
    col.appendChild(games); tree.appendChild(col);
  }
  if (champAbbr) wrap.appendChild(h("div", { class: "brk-path", text: `🏆 ${champAbbr} — champions. Their run is traced in silver.` }));
  brk.appendChild(tree); wrap.appendChild(brk);
  return wrap;
}

// pick a match (null = auto-follow live) and jump to the match view
async function choose(id) {
  loadingMatch = true;
  if (viewMode !== "match") { nav.push(viewMode); viewMode = "match"; }
  body.scrollTop = 0;
  fadeBody(); render();
  await window.wc.setMatch(id);
}

render();
