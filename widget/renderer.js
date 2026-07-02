// renderer — draws the widget from the plain JSON the main process sends. No data fetching
// here; main owns that. Built with createElement + textContent (CSP blocks inline, and we
// avoid innerHTML with API strings).
const app = document.getElementById("app");
const body = document.getElementById("body");
const titleEl = document.getElementById("title");
const roundEl = document.getElementById("round");
const freshEl = document.getElementById("fresh");

let expanded = false;
let pinned = true;
let viewMode = "match"; // "match" | "pick" | "parlay" | "builder" | "record" | "standings"
let last = null;        // last data payload
let parlays = null;     // last fetched daily-parlays payload (lazy, on opening the view)
let record = null;      // last fetched bet record + history (lazy, on opening the view)
let standings = null;   // last fetched group standings + bracket (lazy, on opening the view)
let builder = null;     // last fetched parlay-builder menu (upcoming games + priced legs)
const builderSel = new Map(); // user's selected legs, keyed by game|market|pick → leg object
let builderStake = 10;  // stake the builder grades the slip at
let builderMsg = null;  // transient {ok, text} confirmation after tracking a built parlay
let showPast = false;   // picker: whether previous-day matches are expanded (collapsed by default)
let lastUpdateAt = 0;   // wall-clock of the last data push, for the freshness chip
let kickoffAt = 0;      // kickoff epoch of a tracked pre match, for the live countdown
let prevScoreKey = "";  // "id|h-a" of the last rendered score, to pulse the score on goals
// win-probability timeline: each data push appends the home side's live prob so the match view
// can draw the story of the game. Client-side only — resets when the tracked match changes.
const probHist = { id: null, pts: [] };
const PROB_HIST_MAX = 400;

// highlight whichever control matches the current view/expand state
function syncBar() {
  document.getElementById("btn-pick").classList.toggle("on", viewMode === "pick");
  document.getElementById("btn-parlays").classList.toggle("on", viewMode === "parlay");
  document.getElementById("btn-builder").classList.toggle("on", viewMode === "builder");
  document.getElementById("btn-record").classList.toggle("on", viewMode === "record");
  document.getElementById("btn-standings").classList.toggle("on", viewMode === "standings");
  document.getElementById("btn-expand").classList.toggle("on", expanded);
}

// brief fade on the body — only for deliberate view switches, not background refreshes
function fadeBody() { body.classList.remove("swap"); void body.offsetWidth; body.classList.add("swap"); }

// live kickoff countdown for pre matches — ticks off the same 1s interval, no re-render
function fmtCountdown(ms) {
  if (ms <= 0) return "any moment…";
  const s = Math.floor(ms / 1000), d = Math.floor(s / 86400), hr = Math.floor((s % 86400) / 3600), mi = Math.floor((s % 3600) / 60);
  return d > 0 ? `${d}d ${hr}h` : hr > 0 ? `${hr}h ${mi}m` : `${mi}m ${s % 60}s`;
}
function tickKickoff() {
  if (!kickoffAt) return;
  const el = document.getElementById("kick-time");
  if (el) el.textContent = fmtCountdown(kickoffAt - Date.now());
}

// "updated Ns ago" chip; goes amber once the data is over ~2.5 min old
function tickFresh() {
  tickKickoff();
  if (!lastUpdateAt) { freshEl.hidden = true; return; }
  const s = Math.max(0, Math.round((Date.now() - lastUpdateAt) / 1000));
  const txt = s < 5 ? "now" : s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`;
  freshEl.hidden = false;
  freshEl.textContent = txt;
  freshEl.title = `Updated ${txt === "now" ? "just now" : txt + " ago"} · click to refresh`;
  freshEl.classList.toggle("stale", s > 150);
}
freshEl.addEventListener("click", () => { freshEl.textContent = "…"; window.wc.refresh(); });
setInterval(tickFresh, 1000);

// tiny DOM helper
function h(tag, opts = {}, kids = []) {
  const el = document.createElement(tag);
  if (opts.class) el.className = opts.class;
  if (opts.text != null) el.textContent = opts.text;
  if (opts.title) el.title = opts.title;
  if (opts.onclick) el.addEventListener("click", opts.onclick);
  for (const k of [].concat(kids)) if (k) el.appendChild(k);
  return el;
}
const frag = (kids) => { const f = document.createDocumentFragment(); for (const k of kids) if (k) f.appendChild(k); return f; };

// The Odds API book keys → readable names (fallback: capitalize the key)
const BOOKS = {
  fanduel: "FanDuel", draftkings: "DraftKings", betmgm: "BetMGM", williamhill_us: "Caesars",
  caesars: "Caesars", betrivers: "BetRivers", betonlineag: "BetOnline", bovada: "Bovada",
  mybookieag: "MyBookie", betus: "BetUS", lowvig: "LowVig", pointsbetus: "PointsBet",
  superbook: "SuperBook", espnbet: "ESPN BET", fanatics: "Fanatics", hardrockbet: "Hard Rock",
  unibet_us: "Unibet", betparx: "betPARX", wynnbet: "WynnBET", twinspires: "TwinSpires",
};
const bookName = (k) => BOOKS[k] || (k ? k.charAt(0).toUpperCase() + k.slice(1) : "");
// "home" | "draw" | "away" → display label for the current match
const sideLabel = (side, m) => side === "draw" ? "Draw" : side === "home" ? m.home.abbr : m.away.abbr;

// FIFA 3-letter code → ISO 3166 code for crisp SVG flags from flagcdn.com (sharp at any size,
// unlike ESPN's low-res raster country logos). Unmapped teams fall back to the ESPN logo.
const FIFA_ISO = {
  USA: "us", CAN: "ca", MEX: "mx", BRA: "br", ARG: "ar", URU: "uy", COL: "co", ECU: "ec", PAR: "py", PER: "pe", CHI: "cl", VEN: "ve", BOL: "bo",
  ENG: "gb-eng", SCO: "gb-sct", WAL: "gb-wls", NIR: "gb-nir", IRL: "ie",
  FRA: "fr", GER: "de", ESP: "es", POR: "pt", NED: "nl", BEL: "be", ITA: "it", CRO: "hr", SUI: "ch", SWE: "se", DEN: "dk", POL: "pl", AUT: "at", SRB: "rs", CZE: "cz", TUR: "tr", UKR: "ua", NOR: "no", GRE: "gr", ROU: "ro", HUN: "hu", BIH: "ba", SVK: "sk", SVN: "si", ALB: "al",
  MAR: "ma", SEN: "sn", TUN: "tn", ALG: "dz", EGY: "eg", NGA: "ng", CMR: "cm", GHA: "gh", CIV: "ci", RSA: "za", MLI: "ml", CPV: "cv", COD: "cd", ANG: "ao",
  JPN: "jp", KOR: "kr", AUS: "au", IRN: "ir", KSA: "sa", QAT: "qa", IRQ: "iq", UAE: "ae", UZB: "uz", JOR: "jo", CHN: "cn", NZL: "nz",
  CRC: "cr", PAN: "pa", HON: "hn", JAM: "jm", HAI: "ht", CUW: "cw", TRI: "tt",
};
const flagUrl = (abbr, fallback) => {
  const code = FIFA_ISO[(abbr || "").toUpperCase()];
  return code ? `https://flagcdn.com/${code}.svg` : (fallback || null);
};
// a country flag <img>; crisp SVG when the code is known, else the ESPN logo. null if neither.
function flagImg(abbr, logo) {
  const src = flagUrl(abbr, logo);
  if (!src) return null;
  const img = h("img", { class: "flag" });
  img.src = src;
  img.alt = "";
  return img;
}
// rough perceptual closeness of two #rrggbb colours (so two similar kits don't clash)
function colorClose(a, b) {
  const rgb = (c) => { const n = parseInt((c || "").replace("#", ""), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; };
  const [r1, g1, b1] = rgb(a), [r2, g2, b2] = rgb(b);
  return Math.hypot(r1 - r2, g1 - g2, b1 - b2) < 75;
}
// kit colours are picked for shirts, not dark UIs — navy kits (BIH, USA away…) vanish on the
// glass bg. Blend dark colours toward white until they clear a readable luminance floor.
function ensureVisible(c) {
  let [r, g, b] = [(c) => c >> 16 & 255, (c) => c >> 8 & 255, (c) => c & 255].map((f) => f(parseInt((c || "7aa2ff").replace("#", ""), 16)));
  // 0.18 floor: rescues navy/black kits without washing out saturated reds and greens
  for (let i = 0; i < 3 && (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.18; i++) {
    r += (255 - r) * 0.4; g += (255 - g) * 0.4; b += (255 - b) * 0.4;
  }
  const hex = (v) => Math.round(v).toString(16).padStart(2, "0");
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

// --- controls ---
document.getElementById("btn-expand").addEventListener("click", async () => {
  expanded = await window.wc.toggleExpand();
  applyMode(); fadeBody(); render();
});
document.getElementById("btn-pin").addEventListener("click", async () => {
  pinned = await window.wc.togglePin();
  document.getElementById("btn-pin").classList.toggle("on", pinned);
});
document.getElementById("btn-pick").addEventListener("click", () => {
  viewMode = viewMode === "pick" ? "match" : "pick";
  fadeBody(); render();
});
document.getElementById("btn-parlays").addEventListener("click", async () => {
  if (viewMode === "parlay") { viewMode = "match"; fadeBody(); render(); return; }
  viewMode = "parlay";
  fadeBody(); render(); // shows a "building…" placeholder while we fetch
  const data = await window.wc.getParlays();
  parlays = data;
  if (viewMode === "parlay") render(); // only redraw if the user is still on this view
});
document.getElementById("btn-builder").addEventListener("click", async () => {
  if (viewMode === "builder") { viewMode = "match"; fadeBody(); render(); return; }
  viewMode = "builder";
  builderMsg = null; // don't carry a stale track confirmation into a fresh open
  // builder is most useful with room to breathe — auto-expand if compact
  if (!expanded) { expanded = await window.wc.toggleExpand(); applyMode(); }
  fadeBody(); render(); // shows a "loading legs…" placeholder while we fetch
  const data = await window.wc.getParlayMenu();
  builder = data;
  if (viewMode === "builder") render();
});
document.getElementById("btn-record").addEventListener("click", async () => {
  if (viewMode === "record") { viewMode = "match"; fadeBody(); render(); return; }
  viewMode = "record";
  fadeBody(); render(); // shows a "loading…" placeholder while we fetch
  const data = await window.wc.getRecord();
  record = data;
  if (viewMode === "record") render();
});
document.getElementById("btn-standings").addEventListener("click", async () => {
  if (viewMode === "standings") { viewMode = "match"; fadeBody(); render(); return; }
  viewMode = "standings";
  // the knockout bracket needs width — auto-expand like the builder does
  if (!expanded && app.classList.contains("ko")) { expanded = await window.wc.toggleExpand(); applyMode(); }
  fadeBody(); render(); // shows a "loading…" placeholder while we fetch
  const data = await window.wc.getStandings();
  standings = data;
  if (viewMode === "standings") render();
});
document.getElementById("btn-quit").addEventListener("click", () => window.wc.quit());

function applyMode() {
  app.classList.toggle("expanded", expanded);
  app.classList.toggle("compact", !expanded);
}

window.wc.onConfig((cfg) => {
  expanded = !!cfg.expanded;
  pinned = !!cfg.pinned;
  document.getElementById("btn-pin").classList.toggle("on", pinned);
  applyMode(); syncBar();
});

window.wc.onUpdate((data) => {
  last = data;
  lastUpdateAt = Date.now();
  // accumulate the live win-prob timeline (advance prob in knockouts, else 3-way home win %)
  const m = data?.match;
  if (m && m.state !== "pre" && (m.advance || m.prediction)) {
    if (probHist.id !== m.id) { probHist.id = m.id; probHist.pts = []; }
    const p = m.advance ? m.advance.home : m.prediction.wH;
    if (m.state === "in" && p != null) {
      probHist.pts.push(p);
      if (probHist.pts.length > PROB_HIST_MAX) probHist.pts.shift();
    }
  }
  tickFresh();
  render();
});

// tiny SVG line chart (CSP-safe: createElementNS, no markup strings). pts in [0,1] when norm,
// else raw values scaled to their own min/max. Returns null when there's nothing to draw.
const SVGNS = "http://www.w3.org/2000/svg";
function sparkline(pts, { height = 40, cls = "", midline = null } = {}) {
  if (!pts || pts.length < 2) return null;
  const w = 100, min = Math.min(midline ?? Infinity, ...pts), max = Math.max(midline ?? -Infinity, ...pts);
  const span = max - min || 1;
  const x = (i) => (i / (pts.length - 1)) * w;
  const y = (v) => height - ((v - min) / span) * (height - 2) - 1;
  const svg = document.createElementNS(SVGNS, "svg");
  svg.setAttribute("viewBox", `0 0 ${w} ${height}`);
  svg.setAttribute("preserveAspectRatio", "none");
  svg.classList.add("spark-svg");
  if (cls) svg.classList.add(cls);
  if (midline != null) {
    const zero = document.createElementNS(SVGNS, "line");
    zero.setAttribute("x1", "0"); zero.setAttribute("x2", String(w));
    zero.setAttribute("y1", String(y(midline))); zero.setAttribute("y2", String(y(midline)));
    zero.classList.add("spark-zero");
    svg.appendChild(zero);
  }
  const poly = document.createElementNS(SVGNS, "polyline");
  poly.setAttribute("points", pts.map((v, i) => `${x(i).toFixed(2)},${y(v).toFixed(2)}`).join(" "));
  poly.classList.add("spark-line");
  svg.appendChild(poly);
  return svg;
}

// centered spinner + label for loading/placeholder states
const spinner = (text) => h("div", { class: "center" }, [h("div", { class: "spinner" }), h("div", { class: "muted", text })]);

// --- rendering ---
const ROUND_SHORT = { "round-of-32": "R32", "round-of-16": "R16", quarterfinals: "QF", semifinals: "SF", "third-place": "3RD", final: "FINAL" };
function render() {
  syncBar();
  // knockout theme: gold accents + a round pill in the title bar while a knockout game is tracked
  const ko = !!(last && last.match && last.match.round && last.match.round.knockout);
  app.classList.toggle("ko", ko);
  roundEl.hidden = !ko;
  if (ko) roundEl.textContent = ROUND_SHORT[last.match.round.slug] || last.match.round.label;
  if (viewMode === "parlay") { body.replaceChildren(); body.appendChild(renderParlays(parlays)); return; }
  if (viewMode === "builder") { body.replaceChildren(); body.appendChild(renderBuilder(builder)); return; }
  if (viewMode === "record") { body.replaceChildren(); body.appendChild(renderRecord(record)); return; }
  if (viewMode === "standings") { body.replaceChildren(); body.appendChild(renderStandings(standings)); return; }
  if (!last) return;
  body.replaceChildren();

  if (viewMode === "pick") { body.appendChild(renderPicker(last.matches || [])); return; }

  if (last.error) {
    titleEl.textContent = "World Cup 2026";
    body.appendChild(h("div", { class: "center muted", text: `Couldn’t load: ${last.error}` }));
    return;
  }
  if (!last.match) {
    titleEl.textContent = "World Cup 2026";
    body.appendChild(h("div", { class: "center muted", text: "No live match right now." }));
    const hint = h("div", { class: "center muted", text: "Tap ≡ to pick a game." });
    hint.style.fontSize = "11px"; hint.style.paddingTop = "0";
    body.appendChild(hint);
    return;
  }
  renderMatch(last.match);
}

function liveClass(m) { return m.state === "pre" ? "pre" : m.state === "post" ? "ft" : ""; }

// strip of OTHER games live right now (excludes the one on screen) — for group-stage round 3
// when two matches kick off simultaneously. Each chip jumps the widget to that game. null if none.
function liveSwitcher(curId) {
  const others = (last?.matches || []).filter((mt) => mt.live && mt.id !== curId);
  if (!others.length) return null;
  const strip = h("div", { class: "alsolive" });
  strip.appendChild(h("span", { class: "al-lbl" }, [h("span", { class: "dot" }), document.createTextNode("Also live")]));
  for (const mt of others) {
    strip.appendChild(h("div", { class: "al-chip", title: "Switch to this game", onclick: () => choose(mt.id) }, [
      flagImg(mt.homeAbbr, mt.homeLogo),
      h("b", { text: `${mt.homeAbbr} ${mt.homeScore}–${mt.awayScore} ${mt.awayAbbr}` }),
      flagImg(mt.awayAbbr, mt.awayLogo),
      h("span", { class: "al-min", text: mt.statusText || "LIVE" }),
    ].filter(Boolean)));
  }
  return strip;
}

function renderMatch(m) {
  titleEl.textContent = `${m.home.abbr} v ${m.away.abbr}`;
  const blocks = [];

  // each team's real kit colour (ESPN), with a contrast guard so two similar kits don't
  // both render the same — fall back to the away alternate, then the default pink
  const homeColor = ensureVisible(m.home.color || "#7aa2ff");
  let awayColor = ensureVisible(m.away.color || "#ff8fb3");
  if (colorClose(homeColor, awayColor)) awayColor = (m.away.altColor && !colorClose(homeColor, ensureVisible(m.away.altColor))) ? ensureVisible(m.away.altColor) : "#ff8fb3";
  app.style.setProperty("--home", homeColor);
  app.style.setProperty("--away", awayColor);

  // status + score (with country flags) — all in one .hero block so flushCards still
  // treats everything before the first .label as the header
  const hero = [];
  const liveEl = h("div", { class: `live ${liveClass(m)}` });
  if (m.state === "in") liveEl.appendChild(h("span", { class: "dot" }));
  liveEl.appendChild(document.createTextNode(m.statusText));
  hero.push(liveEl);
  // one-shot goal pulse: same match as last render but the score moved while live
  const scoreKey = `${m.id}|${m.home.score}-${m.away.score}`;
  const bump = m.state === "in" && prevScoreKey.startsWith(`${m.id}|`) && prevScoreKey !== scoreKey;
  prevScoreKey = scoreKey;
  // full-time winner: higher score, shootout decides level games
  let winSide = null;
  if (m.state === "post") {
    if (m.home.score !== m.away.score) winSide = m.home.score > m.away.score ? "home" : "away";
    else if (m.home.shoot != null || m.away.shoot != null)
      winSide = (m.home.shoot ?? 0) > (m.away.shoot ?? 0) ? "home" : (m.away.shoot ?? 0) > (m.home.shoot ?? 0) ? "away" : null;
  }
  hero.push(h("div", { class: "score-row" }, [
    h("div", { class: `side home${winSide === "home" ? " won" : ""}` }, [
      flagImg(m.home.abbr, m.home.logo),
      h("span", { class: "team h", text: expanded ? m.home.name : m.home.abbr }),
    ].filter(Boolean)),
    h("span", { class: `score${bump ? " bump" : ""}`, text: m.state === "pre" ? "vs" : `${m.home.score} – ${m.away.score}` }),
    h("div", { class: `side away${winSide === "away" ? " won" : ""}` }, [
      h("span", { class: "team a", text: expanded ? m.away.name : m.away.abbr }),
      flagImg(m.away.abbr, m.away.logo),
    ].filter(Boolean)),
  ]));
  if (m.home.shoot != null || m.away.shoot != null)
    hero.push(h("div", { class: "pens", text: `Penalties · ${m.home.abbr} ${m.home.shoot ?? 0}–${m.away.shoot ?? 0} ${m.away.abbr}` }));
  // kick-by-kick shootout dots (best-effort — only when ESPN's events parse; totals above always show)
  if (m.shootoutKicks && m.shootoutKicks.length) {
    const kickRow = (abbr) => {
      const kicks = m.shootoutKicks.filter((k) => k.teamAbbr === abbr);
      if (!kicks.length) return null;
      return h("div", { class: "pso-row" }, [
        h("span", { class: "pso-ab", text: abbr }),
        ...kicks.map((k) => h("span", { class: `pso-dot ${k.scored ? "ok" : "no"}`, text: k.scored ? "●" : "✗", title: k.player })),
      ]);
    };
    hero.push(h("div", { class: "pso" }, [kickRow(m.home.abbr), kickRow(m.away.abbr)].filter(Boolean)));
  }
  // the final has one FT that deserves a moment — champions banner when the trophy is decided
  if (m.state === "post" && m.round && m.round.slug === "final" && winSide) {
    const champ = winSide === "home" ? m.home : m.away;
    hero.push(h("div", { class: "champs", text: `🏆 ${(champ.name || champ.abbr).toUpperCase()} — WORLD CHAMPIONS` }));
  }
  if (expanded && m.venue) hero.push(h("div", { class: "venue", text: m.venue }));
  // pre matches get a live countdown; tickKickoff updates the span every second without re-rendering
  kickoffAt = 0;
  if (m.state === "pre" && m.date) {
    kickoffAt = new Date(m.date).getTime();
    const kt = h("span", { text: fmtCountdown(kickoffAt - Date.now()) });
    kt.id = "kick-time";
    hero.push(h("div", { class: "countdown" }, [document.createTextNode("Kicks off in "), kt]));
  }
  blocks.push(h("div", { class: "hero" }, hero));

  // concurrent live games (e.g. group-stage final round kicks off two at once) — one tap to flip
  const sw = liveSwitcher(m.id);
  if (sw) blocks.push(sw);

  // prediction
  if (m.prediction) {
    const p = m.prediction;
    blocks.push(h("div", { class: "label", text: `Predicted final${expanded ? " · " + p.basis : ""}${p.early ? " · low conf" : ""}` }));
    const pred = h("div", { class: "pred" }, [
      h("span", { class: "h", text: m.home.abbr }),
      document.createTextNode(` ${p.ph} – ${p.pa} `),
      h("span", { class: "a", text: m.away.abbr }),
    ]);
    if (expanded) pred.appendChild(h("span", { class: "exp", text: `exp ${p.expH.toFixed(1)}–${p.expA.toFixed(1)}` }));
    blocks.push(pred);
    const wH = Math.round(p.wH * 100), wD = Math.round(p.wD * 100), wA = Math.round(p.wA * 100);
    if (m.advance) {
      // knockout: someone has to go through — the two-way advance prob is the headline,
      // the 90-minute 1X2 split stays as a muted secondary line
      const aH = Math.max(m.advance.home, 0.001), aA = Math.max(m.advance.away, 0.001);
      // best-lbl keeps this inside the Predicted-final card — flushCards starts a new card
      // at every plain .label, which would strand the advance bar in the other column
      blocks.push(h("div", { class: "label best-lbl", text: "To advance · draw goes to ET/pens" }));
      blocks.push(h("div", { class: "advbar" }, [
        Object.assign(h("span", { class: "h" }), { style: `flex:${aH}` }),
        Object.assign(h("span", { class: "a" }), { style: `flex:${aA}` }),
      ]));
      blocks.push(h("div", { class: "advlegend" }, [
        h("span", { text: `${m.home.abbr} ${Math.round(m.advance.home * 100)}%` }),
        h("span", { text: `${m.away.abbr} ${Math.round(m.advance.away * 100)}%` }),
      ]));
      blocks.push(h("div", { class: "adv90", text: `In 90′: ${m.home.abbr} ${wH}% · Draw ${wD}% · ${m.away.abbr} ${wA}%` }));
    } else {
      const wb = h("div", { class: "winbar" }, [
        Object.assign(h("span", { class: "h" }), { style: `flex:${Math.max(p.wH, 0.001)}` }),
        Object.assign(h("span", { class: "d" }), { style: `flex:${Math.max(p.wD, 0.001)}` }),
        Object.assign(h("span", { class: "a" }), { style: `flex:${Math.max(p.wA, 0.001)}` }),
      ]);
      blocks.push(wb);
      blocks.push(h("div", { class: "winlegend" }, [
        h("span", { text: `${m.home.abbr} ${wH}%` }),
        h("span", { text: `Draw ${wD}%` }),
        h("span", { text: `${m.away.abbr} ${wA}%` }),
      ]));
    }
    if (expanded && p.pOver25 != null) {
      blocks.push(h("div", { class: "winlegend" }, [
        h("span", { text: `Over 2.5: ${Math.round(p.pOver25 * 100)}%` }),
        h("span", { text: `BTTS: ${Math.round(p.pBTTS * 100)}%` }),
      ]));
    }
    // the story of the game: home side's live prob over time (accumulated from data pushes)
    if (probHist.id === m.id && probHist.pts.length >= 3 && m.state !== "pre") {
      const graph = sparkline(probHist.pts, { height: 36, cls: "prob", midline: 0.5 });
      if (graph) {
        blocks.push(h("div", { class: "label best-lbl", text: `${m.home.abbr} ${m.advance ? "to advance" : "win %"} · over the match` }));
        blocks.push(h("div", { class: "probwrap" }, [graph]));
      }
    }
  }

  // recommended bets
  if (m.recs && m.recs.length) {
    const note = m.dominance ? ` · ${m.dominance.leader} ${m.dominance.pct}%` : m.recsBasis ? ` · ${m.recsBasis}` : "";
    blocks.push(h("div", { class: "label", text: "Recommended bets" + note }));
    const picks = expanded ? m.recs : pickTop(m.recs, 2);
    for (const r of picks) {
      const tagClass = r.conf.split(" ")[0]; // Strong | Lean | Low | No
      blocks.push(h("div", { class: "rec" }, [
        h("span", { class: `tag ${tagClass}`, text: r.conf }),
        h("span", { class: "txt", text: expanded ? r.text : r.bet }),
      ]));
    }
    // model-vs-market divergence (live) — surfaced as a gap, not a promise of value
    const v = m.valueEdges && m.valueEdges[0];
    if (v && v.edge >= 0.08) {
      const stake = v.kelly > 0.002 ? ` · stake ${(v.kelly * 100).toFixed(1)}% bankroll (½-Kelly)` : "";
      blocks.push(h("div", { class: "rec" }, [
        h("span", { class: "tag Lean", text: "Model gap" }),
        h("span", { class: "txt", text: `${v.label}: model ${Math.round(v.model * 100)}% vs market ${Math.round(v.mkt * 100)}% (+${Math.round(v.edge * 100)}%)${stake}${expanded ? " — divergence, not a guarantee" : ""}` }),
      ]));
    }
    // public-vs-sharp fade (Action Network): public piling on one side, money lighter there
    const fade = m.publicBetting && m.publicBetting.fade;
    if (fade) {
      const pubAb = sideLabel(fade.publicSide, m), shAb = sideLabel(fade.sharpSide, m);
      const pub = m.publicBetting.outcomes[fade.publicSide];
      blocks.push(h("div", { class: "rec" }, [
        h("span", { class: "tag Sharp", text: "Fade public" }),
        h("span", { class: "txt", text: `${pubAb} ${pub.tickets}% tickets / ${pub.money}% money — sharper money leans ${shAb}${expanded ? " (contrarian signal, not a lock)" : ""}` }),
      ]));
    }
  }

  // ---- full-only sections ----
  if (expanded) {
    if (m.momentum && m.momentum.length >= 5) {
      blocks.push(h("div", { class: "label", text: "Momentum · FotMob (pressure)" }));
      const max = Math.max(1, ...m.momentum.map((d) => Math.abs(d.v)));
      const spark = h("div", { class: "spark" });
      for (const d of m.momentum) {
        const bar = h("span", { class: "sb " + (d.v >= 0 ? "h" : "a") });
        bar.style.height = `${Math.max(3, Math.round((Math.abs(d.v) / max) * 100))}%`;
        spark.appendChild(bar);
      }
      blocks.push(spark);
      blocks.push(h("div", { class: "winlegend" }, [h("span", { text: `◀ ${m.home.abbr}` }), h("span", { text: `${m.away.abbr} ▶` })]));
    }
    if (m.pregameProj) {
      const pg = m.pregameProj, c = pg.corners;
      blocks.push(h("div", { class: "label", text: `Pregame projections · ${pg.basis} (model est.)` }));
      if (pg.shots) {
        blocks.push(h("div", { class: "gk" }, [
          h("span", { text: `${m.home.abbr} shots ${pg.shots.home.shots.toFixed(1)} (${pg.shots.home.sot.toFixed(1)} on target)` }),
          h("span", { class: "est", text: `${pg.shots.away.shots.toFixed(1)} (${pg.shots.away.sot.toFixed(1)} on target) ${m.away.abbr}` }),
        ]));
      }
      blocks.push(h("div", { class: "gk" }, [
        h("span", { text: `Corners total ${c.total.toFixed(1)}` }),
        h("span", { class: "est", text: `O${c.line} ${Math.round(c.pOver * 100)}%${c.odds != null ? ` (${c.odds > 0 ? "+" : ""}${c.odds})` : ""}` }),
      ]));
      blocks.push(h("div", { class: "gk" }, [
        h("span", { text: `${m.home.abbr} ${c.home.toFixed(1)} · ${m.away.abbr} ${c.away.toFixed(1)}` }),
        h("span", { class: "est", text: "corners per side" }),
      ]));
      const sv = (abbr, s) => blocks.push(h("div", { class: "gk" }, [
        h("span", { text: `${abbr} keeper saves` }),
        h("span", { class: "est", text: `proj ${s.proj.toFixed(1)} · O${s.line} ${Math.round(s.pOver * 100)}%${s.odds != null ? ` (${s.odds > 0 ? "+" : ""}${s.odds})` : ""}` }),
      ]));
      sv(m.home.abbr, pg.saves.home);
      sv(m.away.abbr, pg.saves.away);
    }
    if (m.playerProj && ((m.playerProj.home || []).length || (m.playerProj.away || []).length)) {
      const all = [
        ...(m.playerProj.home || []).map((p) => ({ ...p, abbr: m.home.abbr })),
        ...(m.playerProj.away || []).map((p) => ({ ...p, abbr: m.away.abbr })),
      ];
      // predicted scorers — top anytime-score probabilities across both sides, with FanDuel's
      // real anytime price next to each (matched by name); ▲ when the model likes it vs the price
      const fdScorers = m.fdScorers || [];
      const nrm = (s) => (s || "").toLowerCase().replace(/[^a-z]/g, "");
      const lastTok = (s) => nrm((s || "").split(/\s+/).filter(Boolean).pop());
      const fdFor = (name) => fdScorers.find((f) => {
        const a = nrm(name), b = nrm(f.player); if (!a || !b) return false;
        return a === b || a.includes(lastTok(f.player)) || b.includes(lastTok(name));
      });
      const scorers = all.filter((p) => p.scoreProb > 0).sort((a, b) => b.scoreProb - a.scoreProb).slice(0, 6);
      if (scorers.length) {
        blocks.push(h("div", { class: "label", text: "Predicted scorers · anytime" + (fdScorers.length ? " · FanDuel price" : " (model est.)") }));
        blocks.push(h("div", { class: "hint", text: "Model % from recent xG (adjusted for the opponent's defence) vs FanDuel's price (implied %). ▲ = model rates higher than the price. Display-only." }));
        for (const p of scorers) {
          const fdp = fdFor(p.name);
          const value = fdp && fdp.implied != null && p.scoreProb > fdp.implied;
          const priceTxt = fdp ? ` · FD ${fmtAm(fdp.ml)}${fdp.implied != null ? ` (${Math.round(fdp.implied * 100)}%)` : ""}` : "";
          blocks.push(h("div", { class: "gk" }, [
            h("span", { text: `${p.abbr} ${p.name}` }),
            h("span", { class: value ? "est up" : "est", text: `${Math.round(p.scoreProb * 100)}%${priceTxt}${value ? " ▲" : ""}` }),
          ]));
        }
      }
      // projected shots on target — per side, sorted by SOT
      blocks.push(h("div", { class: "label", text: "Projected shots on target · per player (model est.)" }));
      const rows = (arr, abbr) => [...(arr || [])].sort((a, b) => b.projSOT - a.projSOT).slice(0, 4).forEach((p) => blocks.push(h("div", { class: "gk" }, [
        h("span", { text: `${abbr} ${p.name}` }),
        h("span", { class: "est", text: `proj ${p.projSOT.toFixed(1)} SOT (${p.games}g)` }),
      ])));
      rows(m.playerProj.home, m.home.abbr);
      rows(m.playerProj.away, m.away.abbr);
    }
    if (m.conditions) {
      const cd = m.conditions;
      blocks.push(h("div", { class: "label", text: "Conditions · venue & rest (WC2026)" }));
      if (cd.venue) {
        const altTxt = cd.venue.alt >= 1000 ? `${cd.venue.alt}m altitude` : `${cd.venue.alt}m`;
        blocks.push(h("div", { class: "gk" }, [
          h("span", { text: cd.venue.name || "Venue" }),
          h("span", { class: "est", text: `${altTxt} · ${cd.venue.heatLabel}` }),
        ]));
      }
      if (cd.home.restDays != null || cd.away.restDays != null) {
        blocks.push(h("div", { class: "gk" }, [
          h("span", { text: `${m.home.abbr} rest` }),
          h("span", { class: "est", text: cd.home.restDays != null ? `${cd.home.restDays} days` : "—" }),
        ]));
        blocks.push(h("div", { class: "gk" }, [
          h("span", { text: `${m.away.abbr} rest` }),
          h("span", { class: "est", text: cd.away.restDays != null ? `${cd.away.restDays} days` : "—" }),
        ]));
      }
    }
    if (m.possession) {
      blocks.push(h("div", { class: "label", text: "Possession" }));
      blocks.push(h("div", { class: "possrow" }, [
        h("span", { text: `${m.possession.homeAbbr} ${m.possession.home}%` }),
        h("span", { text: `${m.possession.away}% ${m.possession.awayAbbr}` }),
      ]));
      blocks.push(h("div", { class: "possbar" }, [
        Object.assign(h("span", { class: "h" }), { style: `flex:${m.possession.home}` }),
        Object.assign(h("span", { class: "a" }), { style: `flex:${m.possession.away}` }),
      ]));
    }
    if (m.stats && m.stats.length) {
      const tbl = h("table");
      for (const s of m.stats) {
        tbl.appendChild(h("tr", {}, [
          h("td", { class: "hv" + (s.homeLeads ? " lead" : ""), text: s.home }),
          h("td", { class: "lbl", text: s.label }),
          h("td", { class: "av" + (s.awayLeads ? " lead" : ""), text: s.away }),
        ]));
      }
      blocks.push(tbl);
    }
    if (m.xg) {
      const xg = m.xg;
      blocks.push(h("div", { class: "label", text: "Expected goals (xG) · FotMob" }));
      blocks.push(h("div", { class: "hint", text: "xG = chance quality (a 0.30 shot ≈ 30% to score). Higher = better chances." }));
      blocks.push(h("div", { class: "gk" }, [
        h("span", { text: `${m.home.abbr} ${xg.home.xg.toFixed(2)} xG` }),
        h("span", { class: "est", text: `${xg.away.xg.toFixed(2)} xG ${m.away.abbr}` }),
      ]));
      blocks.push(h("div", { class: "gk" }, [
        h("span", { text: `Shots ${xg.home.shots} (${xg.home.sot} on target)` }),
        h("span", { class: "est", text: `${xg.away.shots} (${xg.away.sot} on target)` }),
      ]));
      if (xg.xgot) blocks.push(h("div", { class: "gk" }, [
        h("span", { text: `xG on target (xGOT) ${xg.xgot.home.toFixed(2)}`, title: "expected goals from shots on target — measures placement/finishing" }),
        h("span", { class: "est", text: `${xg.xgot.away.toFixed(2)}` }),
      ]));
      if (xg.bigChances) blocks.push(h("div", { class: "gk" }, [
        h("span", { text: `Big chances ${xg.bigChances.home}${xg.bigChancesMissed ? ` (${xg.bigChancesMissed.home} missed)` : ""}`, title: "clear-cut scoring opportunities" }),
        h("span", { class: "est", text: `${xg.bigChances.away}${xg.bigChancesMissed ? ` (${xg.bigChancesMissed.away} missed)` : ""}` }),
      ]));
      for (const p of xg.players) {
        if (p.xg < 0.05) continue;
        blocks.push(h("div", { class: "gk" }, [
          h("span", { text: `${p.side === "home" ? m.home.abbr : m.away.abbr} ${p.name}${p.goals ? " ⚽" + p.goals : ""}` }),
          h("span", { class: "est", text: `${p.xg.toFixed(2)} xG · ${p.sot} on target` }),
        ]));
      }
    }
    if (m.topPlayers || m.form) {
      blocks.push(h("div", { class: "label", text: "Top performers · rating & form" }));
      const tpRows = (arr, abbr) => (arr || []).forEach((p) => blocks.push(h("div", { class: "gk" }, [
        h("span", { text: `${abbr} ${p.name}` }),
        h("span", { class: "est", text: p.rating.toFixed(1) }),
      ])));
      if (m.topPlayers) { tpRows(m.topPlayers.home, m.home.abbr); tpRows(m.topPlayers.away, m.away.abbr); }
      if (m.form) {
        const formRow = (abbr, arr) => blocks.push(h("div", { class: "gk" }, [
          h("span", { text: `${abbr} form` }),
          h("span", { class: "formrow" }, (arr || []).map((r) => h("span", { class: `formdot ${r}`, text: r }))),
        ]));
        formRow(m.home.abbr, m.form.home);
        formRow(m.away.abbr, m.form.away);
      }
    }
    if (m.odds) {
      const src = m.odds.source === "live" ? "FanDuel · LIVE" : m.odds.source === "pre" ? "FanDuel · pre" : m.odds.source === "fanduel-an" ? "FanDuel" : `${m.odds.provider || "book"} · pre`;
      blocks.push(h("div", { class: "label", text: `Odds · ${src}` }));
      const o = m.odds, money = h("div", { class: "odds" });
      money.appendChild(h("div", { class: "row" }, [
        h("span", { text: `${m.home.abbr} ${o.home.ml}${o.home.prob != null ? ` ${o.home.prob}%` : ""}` }),
        h("span", { text: `Draw ${o.draw.ml}${o.draw.prob != null ? ` ${o.draw.prob}%` : ""}` }),
        h("span", { text: `${m.away.abbr} ${o.away.ml}${o.away.prob != null ? ` ${o.away.prob}%` : ""}` }),
      ]));
      if (o.home.best) {
        // best available price across books, with the book name and a ▲ when it beats FanDuel
        const cell = (s, ab) => h("span", {
          text: `${ab} ${s.best} ${bookName(s.bestBook)}${s.beatsFd ? " ▲" : ""}`,
          class: s.beatsFd ? "up" : "",
        });
        money.appendChild(h("div", { class: "label best-lbl", text: "best price across books" }));
        money.appendChild(h("div", { class: "row best" }, [cell(o.home, m.home.abbr), cell(o.draw, "Draw"), cell(o.away, m.away.abbr)]));
      }
      blocks.push(money);
    }
    if (m.publicBetting && m.publicBetting.outcomes) {
      const pb = m.publicBetting;
      blocks.push(h("div", { class: "label", text: "Public betting · Action Network (tickets / money)" }));
      for (const side of ["home", "draw", "away"]) {
        const c = pb.outcomes[side];
        if (!c || c.tickets == null || (c.tickets === 0 && c.money === 0)) continue;
        const tags = [];
        if (side === pb.publicSide) tags.push("public");
        if (pb.fade && side === pb.fade.sharpSide) tags.push("sharp lean");
        blocks.push(h("div", { class: "gk" }, [
          h("span", { text: `${sideLabel(side, m)}${c.odds != null ? ` ${c.odds > 0 ? "+" : ""}${c.odds}` : ""}${tags.length ? `  (${tags.join(", ")})` : ""}` }),
          h("span", { class: "est", text: `${c.tickets}% tickets · ${c.money}% money` }),
        ]));
      }
      const hasData = (o) => o && o.tickets != null && !(o.tickets === 0 && o.money === 0);
      if (pb.spread && hasData(pb.spread.home)) {
        const sp = pb.spread.home;
        blocks.push(h("div", { class: "gk" }, [
          h("span", { text: `Spread ${m.home.abbr} ${sp.line > 0 ? "+" : ""}${sp.line}` }),
          h("span", { class: "est", text: `${sp.tickets}% tickets · ${sp.money}% money` }),
        ]));
      }
      if (pb.total && hasData(pb.total.over)) {
        const tv = pb.total.over;
        blocks.push(h("div", { class: "gk" }, [
          h("span", { text: `Total Over ${pb.total.line}` }),
          h("span", { class: "est", text: `${tv.tickets}% tickets · ${tv.money}% money` }),
        ]));
      }
    }
    if (m.keepers && m.keepers.length) {
      blocks.push(h("div", { class: "label", text: "Goalkeepers · saves (model est.)" }));
      for (const k of m.keepers) {
        let est = "";
        if (k.line && !k.line.settled) {
          est = k.line.need <= 0 ? `proj ${k.line.proj.toFixed(1)} · O${k.line.value} ✓`
            : `proj ${k.line.proj.toFixed(1)} · O${k.line.value} ${Math.round(k.line.pOver * 100)}%${k.line.odds != null ? ` (${k.line.odds > 0 ? "+" : ""}${k.line.odds})` : ""}`;
        } else if (k.line && k.line.settled) {
          est = `final ${k.saves} · O${k.line.value} ${k.line.over ? "✓" : "✗"}`;
        }
        blocks.push(h("div", { class: "gk" }, [
          h("span", { text: `${k.abbr} ${k.name}` }),
          h("span", { class: "est", text: `${k.saves} sv · ${est}` }),
        ]));
      }
    }
    if (m.corners) {
      const cor = m.corners;
      blocks.push(h("div", { class: "label", text: "Corners · per side + total O/U (model est.)" }));
      if (cor.settled) {
        blocks.push(h("div", { class: "gk" }, [
          h("span", { text: `${m.home.abbr} ${cor.home} · ${m.away.abbr} ${cor.away}` }),
          h("span", { class: "est", text: `final ${cor.total} · O${cor.line} ${cor.over ? "✓" : "✗"}` }),
        ]));
      } else {
        blocks.push(h("div", { class: "gk" }, [
          h("span", { text: `${m.home.abbr} ${cor.home} → proj ${cor.projH.toFixed(1)}` }),
          h("span", { text: `${cor.projA.toFixed(1)} ← ${cor.away} ${m.away.abbr}`, class: "est" }),
        ]));
        const ou = cor.need <= 0
          ? `O${cor.line} ✓ hit`
          : `O${cor.line} ${Math.round(cor.pOver * 100)}%${cor.odds != null ? ` (${cor.odds > 0 ? "+" : ""}${cor.odds})` : ""}`;
        blocks.push(h("div", { class: "gk" }, [
          h("span", { text: `total proj ${cor.totalProj.toFixed(1)}` }),
          h("span", { class: "est", text: ou }),
        ]));
      }
    }

    if (m.playerProps && (m.playerProps.scorers.length || m.playerProps.sot.length)) {
      const pp = m.playerProps;
      // FanDuel price first; flag another book with ▲ only when it actually beats FanDuel
      const priceEl = (pv) => {
        if (pv.primary) {
          const span = h("span", { class: "est", text: `FD ${pv.primary}` });
          if (pv.beats && pv.best) span.appendChild(h("span", { class: "up", text: `  ▲ ${pv.best} ${bookName(pv.bestBook)}` }));
          return span;
        }
        return h("span", { class: "est", text: pv.best ? `${pv.best} ${bookName(pv.bestBook)} (no FD)` : "" });
      };
      if (pp.scorers.length) {
        blocks.push(h("div", { class: "label", text: "Anytime scorer · FanDuel" }));
        for (const s of pp.scorers.slice(0, 5)) {
          const pctTxt = s.prob != null ? `${Math.round(s.prob * 100)}% devig` : `${Math.round((s.price.implied || 0) * 100)}%`;
          blocks.push(h("div", { class: "gk" }, [
            h("span", { text: `${s.player} · ${pctTxt}` }),
            priceEl(s.price),
          ]));
        }
      }
      if (pp.sot.length) {
        blocks.push(h("div", { class: "label", text: "Shots on target · FanDuel · de-vigged" }));
        for (const s of pp.sot.slice(0, 5)) {
          blocks.push(h("div", { class: "gk" }, [
            h("span", { text: `${s.player} O${s.line} · ${Math.round(s.fairOver * 100)}%` }),
            priceEl(s.price),
          ]));
        }
      }
    }

    if (m.group) {
      blocks.push(h("div", { class: "label full", text: m.group.header }));
      const tbl = h("table", { class: "grp" });
      for (const e of m.group.entries) {
        tbl.appendChild(h("tr", { class: e.highlight ? "hl" : "" }, [
          h("td", { text: `${e.rank}. ${e.name}` }),
          h("td", { class: "num", text: e.record }),
          h("td", { class: "num", text: `${e.gd}` }),
          h("td", { class: "num", text: `${e.pts} pts` }),
        ]));
      }
      blocks.push(tbl);
    }
    if (m.events && m.events.length) {
      blocks.push(h("div", { class: "label", text: "Match events" }));
      for (const e of m.events) {
        const og = /own goal/i.test(e.type || "");
        blocks.push(h("div", { class: "ev" }, [
          h("span", { class: "min", text: e.min }),
          h("span", { text: `${eventIcon(e.type)} ${e.teamAbbr ? e.teamAbbr + " " : ""}${e.players || e.type}${og ? " (OG)" : ""}` }),
        ]));
      }
    }
    blocks.push(h("div", { class: "disc", text: "⚠ Model estimates, not financial advice. Odds are −EV on average; stake small." }));
  }

  if (expanded) flushCards(blocks);
  else body.appendChild(frag(blocks));
}

// expanded layout: group the flat blocks into labeled cards, flow them across two columns,
// and keep the header (pre-first-label), full-width sections, and disclaimer outside the grid.
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
    else header.push(b); // before the first label = score header
  }
  const mkCard = (s) => { const sec = h("section", { class: "card" }); s.nodes.forEach((n) => sec.appendChild(n)); return sec; };
  // place each card in the currently-shorter column (by row count) so the columns stay
  // balanced and short cards like Match Events fill the gap under a tall neighbour
  const cols = [h("div", { class: "col" }), h("div", { class: "col" })];
  const weight = [0, 0];
  for (const s of sections) {
    const i = weight[0] <= weight[1] ? 0 : 1;
    cols[i].appendChild(mkCard(s));
    weight[i] += s.nodes.length;
  }
  body.appendChild(frag(header));
  body.appendChild(h("div", { class: "grid2" }, [cols[0], cols[1]]));
  full.forEach((s) => body.appendChild(mkCard(s)));
  footer.forEach((f) => body.appendChild(f));
}

function pickTop(recs, n) {
  const actionable = recs.filter((r) => r.conf === "Strong lean" || r.conf === "Lean");
  return (actionable.length ? actionable : recs).slice(0, n);
}

function eventIcon(type) {
  const t = (type || "").toLowerCase();
  if (t.includes("own")) return "⚽";
  if (t.includes("goal") || t.includes("penalty")) return "⚽";
  if (t.includes("yellow")) return "🟨";
  if (t.includes("red")) return "🟥";
  if (t.includes("substitution")) return "🔁";
  if (t.includes("kickoff")) return "▶";
  if (t.includes("halftime") || t.includes("end")) return "⏸";
  return "•";
}

// one picker row for a match
function pickRow(mt) {
  const score = mt.state === "pre" ? "vs" : `${mt.homeScore}–${mt.awayScore}`;
  const right = mt.live ? mt.statusText : mt.state === "post" ? "FT" : new Date(mt.date).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const predTxt = mt.pred ? `${mt.pred.ph}–${mt.pred.pa}` : "";
  const predTitle = mt.pred ? `predicted: ${mt.homeAbbr} ${Math.round(mt.pred.wH * 100)}% / Draw ${Math.round(mt.pred.wD * 100)}% / ${mt.awayAbbr} ${Math.round(mt.pred.wA * 100)}%` : "";
  // teams stay a uniform colour — the flags carry the team identity (colouring text too is noise)
  const teamEl = (abbr) => h("span", { class: "pk-team", text: abbr });
  const left = h("span", { class: "l" }, [
    flagImg(mt.homeAbbr, mt.homeLogo), teamEl(mt.homeAbbr),
    h("span", { class: "pk-score", text: score }),
    teamEl(mt.awayAbbr), flagImg(mt.awayAbbr, mt.awayLogo),
  ].filter(Boolean));
  return h("div", { class: `row ${mt.live ? "islive" : ""}`, onclick: () => choose(mt.id) }, [
    left,
    h("span", { class: "pred-mini", text: predTxt, title: predTitle }),
    h("span", { class: `r ${mt.live ? "live" : ""}`, text: right }),
  ]);
}

// append day-grouped rows for a list of matches into a container
function appendDays(container, list) {
  let curDay = "";
  for (const mt of list) {
    const day = new Date(mt.date).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
    if (day !== curDay) { curDay = day; container.appendChild(h("div", { class: "day", text: day })); }
    container.appendChild(pickRow(mt));
  }
}

function renderPicker(matches) {
  titleEl.textContent = "Pick a match";
  const wrap = h("div", { class: "pick" });
  if (!matches.length) { wrap.appendChild(h("div", { class: "center muted", text: "No matches found." })); return wrap; }

  wrap.appendChild(h("div", { class: "muted pick-hint", text: "dim score = model's predicted final" }));

  // auto-track option
  wrap.appendChild(h("div", { class: "row", onclick: () => choose(null) }, [
    h("span", { class: "l", text: "↻ Auto (live game)" }),
    h("span", { class: "pred-mini", text: "" }),
    h("span", { class: "r", text: "default" }),
  ]));

  // previous-day matches collapse behind a toggle (closed by default) so today + upcoming lead
  const startToday = new Date(); startToday.setHours(0, 0, 0, 0);
  const past = matches.filter((mt) => new Date(mt.date) < startToday);
  const rest = matches.filter((mt) => new Date(mt.date) >= startToday);

  if (past.length) {
    wrap.appendChild(h("div", { class: "pick-toggle", onclick: () => { showPast = !showPast; fadeBody(); render(); } },
      [h("span", { text: `${showPast ? "▾" : "▸"} Previous results (${past.length})` })]));
    if (showPast) appendDays(wrap, past);
  }
  appendDays(wrap, rest);
  return wrap;
}

// --- daily parlays view ---
const fmtAm = (ml) => (ml == null ? "-" : ml > 0 ? `+${ml}` : `${ml}`);
const pctR = (p) => `${Math.round(p * 100)}%`;

// "NED v SWE" → [flag, NED, v, SWE, flag]; falls back to plain text if it can't be split
function gameTitle(game) {
  const parts = (game || "").split(" v ");
  if (parts.length !== 2) return [h("span", { class: "p-title-txt", text: game || "" })];
  const [hAb, aAb] = parts.map((s) => s.trim());
  return [
    flagImg(hAb), h("span", { class: "pk-team", text: hAb }),
    h("span", { class: "p-v", text: "v" }),
    h("span", { class: "pk-team", text: aAb }), flagImg(aAb),
  ].filter(Boolean);
}

function parlayCard(p, titleNodes, all) {
  const card = h("div", { class: "parlay" + (all ? " all" : "") });
  card.appendChild(h("div", { class: "p-head" }, [
    h("span", { class: "p-title" }, titleNodes),
    h("span", { class: "p-odds", text: fmtAm(p.americanOdds) }),
  ]));
  card.appendChild(h("div", { class: "p-payout", text: `$${p.stake} → $${p.payout.toFixed(2)}` }));
  for (const l of p.legs) {
    card.appendChild(h("div", { class: "p-leg" }, [
      h("span", { class: "p-leg-txt", text: `${l.game} · ${l.market}: ${l.pick}` }),
      h("span", { class: "p-leg-meta", text: `${fmtAm(l.ml)} · model ${pctR(l.modelProb)} · edge ${l.edge >= 0 ? "+" : ""}${Math.round(l.edge * 100)}%` }),
    ]));
    if (l.why) card.appendChild(h("div", { class: "p-why", text: l.why }));
  }
  const evGood = p.ev >= 0;
  const k = p.kelly > 0.002 ? `Kelly ${(p.kelly * 100).toFixed(1)}%` : "Kelly: skip";
  card.appendChild(h("div", { class: "p-foot" }, [
    h("span", { text: `model ${pctR(p.modelProb)}` }),
    h("span", { class: evGood ? "up" : "neg", text: `EV ${evGood ? "+" : ""}$${p.ev.toFixed(2)}` }),
    h("span", { text: k }),
  ]));
  return card;
}

// --- parlay builder: pick any legs across upcoming games, see the model's grade live ---
const slipKey = (l) => `${l.game}|${l.market}|${l.pick}`;
const decToAm = (d) => (d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1)));

// grade the current slip exactly like parlays.gradeParlay (independence approximation across legs)
function gradeSlip(legs, stake) {
  if (!legs.length) return null;
  const dec = legs.reduce((p, l) => p * l.dec, 1);
  const modelProb = legs.reduce((p, l) => p * l.modelProb, 1);
  const impl = 1 / dec;                          // book's combined implied prob (vig included)
  const b = dec - 1;
  const kelly = b > 0 ? Math.min(0.05, Math.max(0, (b * modelProb - (1 - modelProb)) / b / 2)) : 0;
  return {
    dec, american: decToAm(dec), modelProb, impl, edge: modelProb - impl,
    payout: stake * dec, ev: stake * (modelProb * dec - 1), kelly,
    fairAm: modelProb > 0 ? decToAm(1 / modelProb) : null,
  };
}

function bstat(label, val, cls) {
  return h("div", { class: "bld-stat" }, [
    h("div", { class: "bld-val " + (cls || ""), text: val }),
    h("div", { class: "bld-lbl", text: label }),
  ]);
}

function renderBuilder(data) {
  titleEl.textContent = "Parlay builder";
  const wrap = h("div", { class: "builder" });
  if (!data) { wrap.appendChild(spinner("Loading legs…")); return wrap; }
  if (data.error) { wrap.appendChild(h("div", { class: "center muted", text: `Couldn’t load: ${data.error}` })); return wrap; }
  const games = data.games || [];
  if (!games.length) { wrap.appendChild(h("div", { class: "center muted", text: "No upcoming games to build from yet." })); return wrap; }

  // drop any stale selections (legs no longer on the refreshed menu) so the grade stays honest
  const live = new Set();
  for (const game of games) for (const l of game.legs) live.add(slipKey(l));
  for (const k of [...builderSel.keys()]) if (!live.has(k)) builderSel.delete(k);
  const selected = [...builderSel.values()];

  // --- the slip summary (sticky at the top) ---
  const g = gradeSlip(selected, builderStake);
  const slip = h("div", { class: "bld-slip" });
  const stakeIn = h("input", { class: "bld-stake" });
  stakeIn.type = "number"; stakeIn.min = "1"; stakeIn.step = "1"; stakeIn.value = String(builderStake);
  stakeIn.addEventListener("change", () => { builderStake = Math.max(1, Number(stakeIn.value) || 10); render(); });
  slip.appendChild(h("div", { class: "bld-slip-head" }, [
    h("span", { class: "label", text: `Your slip · ${selected.length} leg${selected.length === 1 ? "" : "s"}` }),
    h("span", { class: "bld-stake-wrap" }, [h("span", { class: "muted", text: "$" }), stakeIn]),
  ]));
  if (!g) {
    slip.appendChild(h("div", { class: "muted bld-empty", text: "Tap legs below to add them — the model grades the combined parlay up here." }));
  } else {
    const edgePts = Math.round(g.edge * 1000) / 10; // tenths of a percentage point
    const verdict = g.edge > 0.02 ? { cls: "up", txt: `Model likes this (+${edgePts}% edge)` }
      : g.edge < -0.02 ? { cls: "neg", txt: `Model fades this (${edgePts}% edge)` }
      : { cls: "muted", txt: "Model rates this ≈ a coin flip vs the price" };
    slip.appendChild(h("div", { class: "bld-grid" }, [
      bstat("Parlay odds", fmtAm(g.american)),
      bstat("Payout", `$${g.payout.toFixed(2)}`),
      bstat("Model", pctR(g.modelProb)),
      bstat("Price implies", pctR(g.impl)),
      bstat("Fair odds", g.fairAm == null ? "—" : fmtAm(g.fairAm)),
      bstat("EV", `${g.ev >= 0 ? "+" : ""}$${g.ev.toFixed(2)}`, g.ev >= 0 ? "up" : "neg"),
    ]));
    slip.appendChild(h("div", { class: `bld-verdict ${verdict.cls}`, text: verdict.txt }));
    slip.appendChild(h("div", { class: "bld-foot" }, [
      h("span", { class: "muted", text: g.kelly > 0.002 ? `Suggested ≈ Kelly ${(g.kelly * 100).toFixed(1)}% of bankroll` : "Kelly: skip (no edge)" }),
      h("span", { class: "bld-foot-btns" }, [
        h("button", { class: "bld-track", text: "Track this parlay", onclick: () => trackSlip(selected, data.date) }),
        h("button", { class: "bld-clear", text: "Clear", onclick: () => { builderSel.clear(); builderMsg = null; render(); } }),
      ]),
    ]));
    if (builderMsg) slip.appendChild(h("div", { class: "bld-msg " + (builderMsg.ok ? "up" : "neg"), text: builderMsg.text }));
  }
  wrap.appendChild(slip);

  // --- the leg menu, grouped by game ---
  wrap.appendChild(h("div", { class: "muted p-sub", text: `${data.date} · model price vs FanDuel` }));
  for (const game of games) {
    wrap.appendChild(h("div", { class: "label bld-game" }, gameTitle(game.game)));
    for (const l of game.legs) {
      const on = builderSel.has(slipKey(l));
      const e = Math.round(l.edge * 100);
      const row = h("div", { class: "bld-leg" + (on ? " on" : "") }, [
        h("span", { class: "bld-tick", text: on ? "✓" : "" }),
        h("span", { class: "bld-leg-txt", text: `${l.market}: ${l.pick}` }),
        h("span", { class: "bld-leg-meta" }, [
          h("span", { text: fmtAm(l.ml) }),
          h("span", { class: "muted", text: `model ${pctR(l.modelProb)}` }),
          l.fair ? h("span", { class: "muted", text: "model line" })
                 : h("span", { class: l.edge >= 0 ? "up" : "neg", text: `${e >= 0 ? "+" : ""}${e}%` }),
        ]),
      ]);
      row.addEventListener("click", () => {
        const k = slipKey(l);
        if (builderSel.has(k)) builderSel.delete(k); else builderSel.set(k, l);
        builderMsg = null; // a slip change invalidates the last track confirmation
        render();
      });
      wrap.appendChild(row);
    }
  }
  wrap.appendChild(h("div", { class: "disc", text: "⚠ Model estimates, not financial advice. Combined % assumes legs are independent — same-game legs are correlated, so treat those parlays with extra caution." }));
  return wrap;
}

// log the current slip to the bet record so it settles as games finish (shows in the Record view)
async function trackSlip(legs, date) {
  if (!legs.length) { builderMsg = { ok: false, text: "Add at least one leg first." }; render(); return; }
  builderMsg = { ok: true, text: "Tracking…" }; render();
  const payload = {
    stake: builderStake, date,
    legs: legs.map((l) => ({ id: l.id, game: l.game, market: l.market, pick: l.pick, modelProb: l.modelProb, ml: l.ml, dec: l.dec, edge: l.edge, rawEdge: l.rawEdge, why: l.why })),
  };
  const res = await window.wc.trackParlay(payload).catch((e) => ({ error: String(e?.message || e) }));
  if (res && res.ok) {
    builderMsg = { ok: true, text: `Tracked ✓ ${fmtAm(res.americanOdds)} — settles in the Record view as games finish.` };
    builderSel.clear();
    record = null; // force the Record view to refetch so the new parlay appears there
  } else {
    builderMsg = { ok: false, text: `Couldn’t track: ${res?.error || "unknown error"}` };
  }
  render();
}

function renderParlays(data) {
  titleEl.textContent = "Daily singles";
  const wrap = h("div", { class: "parlays" });
  if (!data) { wrap.appendChild(spinner("Building bets…")); return wrap; }
  if (data.error) { wrap.appendChild(h("div", { class: "center muted", text: `Couldn’t build: ${data.error}` })); return wrap; }
  const singles = data.singles || [];
  if (!singles.length && !data.longshot) {
    wrap.appendChild(h("div", { class: "center muted", text: "No qualifying bets on this slate yet." }));
    return wrap;
  }

  wrap.appendChild(h("div", { class: "muted p-sub", text: `${data.date} · $${data.stake} each` }));

  // PRIMARY (tracked): one straight single per game — the best in-band leg
  if (singles.length) {
    wrap.appendChild(h("div", { class: "label", text: "Singles · one bet per game" }));
    for (const g of singles) wrap.appendChild(parlayCard(g.bet, gameTitle(g.game), false));
  }

  // FOR FUN (not tracked): one cross-game longshot, one leg per game — max payout, low hit rate
  if (data.longshot) {
    wrap.appendChild(h("div", { class: "label", text: "For fun · longshot, one leg per game (not tracked)" }));
    wrap.appendChild(parlayCard(data.longshot, [h("span", { class: "p-title-txt", text: "Longshot" })], true));
  }

  wrap.appendChild(h("div", { class: "disc", text: "⚠ Model estimates, not financial advice. Only the singles are tracked; the longshot is just for fun. Stake small." }));
  return wrap;
}

// --- record + history view ---
function historyCard(p) {
  const result = p.settled ? p.result : "pending"; // "win" | "loss" | "pending"
  const badge = h("span", { class: `rec-badge ${result}`, text: result === "win" ? "WON" : result === "loss" ? "LOST" : "PENDING" });
  const title = p.type === "cross" ? "All games" : p.game;
  const card = h("div", { class: "parlay hist" }, [
    h("div", { class: "p-head" }, [
      h("span", { class: "p-title" }, [h("span", { class: "p-title-txt", text: title }), badge]),
      h("span", { class: "p-odds", text: fmtAm(p.americanOdds) }),
    ]),
  ]);
  const am2prob = (ml) => (ml == null ? null : ml > 0 ? 100 / (ml + 100) : -ml / (-ml + 100));
  for (const l of p.legs) {
    const r = l.result; // "hit" | "miss" | null
    const mark = r === "hit" ? "✓" : r === "miss" ? "✗" : "·";
    const meta = [h("span", { text: l.finalScore || fmtAm(l.ml) })];
    // per-leg CLV: bet price vs the captured close — "good bet, bad luck" vs "bad bet, got lucky"
    if (l.closeMl != null && l.ml != null) {
      const beat = am2prob(l.ml) < am2prob(l.closeMl); // longer odds than close = beat it
      meta.push(h("span", { class: beat ? "up" : "neg", text: ` ${fmtAm(l.ml)}→cl ${fmtAm(l.closeMl)} ${beat ? "▲" : "▼"}` }));
    }
    card.appendChild(h("div", { class: "p-leg" }, [
      h("span", { class: `leg-mark ${r || "pend"}`, text: mark }),
      h("span", { class: "p-leg-txt", text: `${l.game} · ${l.market}: ${l.pick}` }),
      h("span", { class: "p-leg-meta" }, meta),
    ]));
    // the original reasoning the leg was picked on (older logged legs may not have it)
    if (l.why) card.appendChild(h("div", { class: "p-why", text: l.why }));
  }
  card.appendChild(h("div", { class: "p-foot" }, [
    h("span", { text: `$${p.stake} → $${p.payout.toFixed(2)}` }),
    h("span", {
      class: result === "win" ? "up" : result === "loss" ? "neg" : "",
      text: result === "win" ? `+$${(p.payout - p.stake).toFixed(2)}` : result === "loss" ? `−$${p.stake.toFixed(2)}` : "pending",
    }),
  ]));
  return card;
}

function renderRecord(data) {
  titleEl.textContent = "Record";
  const wrap = h("div", { class: "record" });
  if (!data) { wrap.appendChild(spinner("Loading record…")); return wrap; }
  if (data.error) { wrap.appendChild(h("div", { class: "center muted", text: `Couldn’t load: ${data.error}` })); return wrap; }
  const s = data.stats || {};
  const pct = (p) => (p == null ? "—" : `${Math.round(p * 100)}%`);
  const money = (v) => (v == null ? "—" : `${v >= 0 ? "+" : "−"}$${Math.abs(v).toFixed(2)}`);

  // headline stats grid
  const stat = (label, val, cls) => h("div", { class: "rec-stat" }, [
    h("div", { class: "rec-val " + (cls || ""), text: val }),
    h("div", { class: "rec-lbl", text: label }),
  ]);
  const cells = [
    stat("Leg hit rate", s.legs ? `${pct(s.legHitRate)}` : "—"),
    stat("Legs settled", String(s.legs || 0)),
    stat("Brier", s.brier == null ? "—" : s.brier.toFixed(3)),
    stat("Parlays won", `${s.parlayWins || 0}/${s.parlays || 0}`),
    stat("Profit", money(s.profit), (s.profit ?? 0) >= 0 ? "up" : "neg"),
    stat("ROI", pct(s.roi), (s.roi ?? 0) >= 0 ? "up" : "neg"),
  ];
  // closing line value — known at kickoff, so it reads edge faster than results can
  if (s.clv && s.clv.n) {
    cells.push(stat("CLV", `${s.clv.avgPts >= 0 ? "+" : ""}${(s.clv.avgPts * 100).toFixed(1)} pts`, s.clv.avgPts >= 0 ? "up" : "neg"));
    cells.push(stat("Beat close", `${pct(s.clv.beatRate)} (${s.clv.n})`, s.clv.beatRate >= 0.5 ? "up" : ""));
  }
  wrap.appendChild(h("div", { class: "label", text: "All-time" }));
  wrap.appendChild(h("div", { class: "rec-grid" }, cells));
  if (s.clv && s.clv.n) wrap.appendChild(h("div", { class: "hint", text: "CLV = bet price vs pre-kickoff price. Beating the close consistently means real edge, win or lose." }));
  if (!s.legs) wrap.appendChild(h("div", { class: "hint", text: "Stats fill in as games finish and settle each morning. Brier = calibration (lower is better)." }));

  // bankroll trajectory: cumulative settled P/L by slate, oldest → newest
  {
    const asc = [...(data.days || [])].sort((a, b) => a.date.localeCompare(b.date));
    let cum = 0;
    const pts = [];
    for (const d of asc) {
      let dp = 0, any = false;
      for (const p of d.parlays || []) if (p.settled) { any = true; dp += p.result === "win" ? p.payout - p.stake : -p.stake; }
      if (any) { cum += dp; pts.push(cum); }
    }
    const graph = pts.length >= 2 ? sparkline(pts, { height: 40, cls: cum >= 0 ? "pl-up" : "pl-neg", midline: 0 }) : null;
    if (graph) {
      wrap.appendChild(h("div", { class: "label", text: "Bankroll · cumulative P/L by slate" }));
      wrap.appendChild(h("div", { class: "probwrap" }, [graph]));
      wrap.appendChild(h("div", { class: "winlegend" }, [
        h("span", { text: asc[0].date }),
        h("span", { class: cum >= 0 ? "up" : "neg", text: `${cum >= 0 ? "+" : "−"}$${Math.abs(cum).toFixed(2)}` }),
      ]));
    }
  }

  // rolling recent window — the trend, undistorted by old lucky/unlucky days
  const rc = data.recent;
  if (rc && rc.legs) {
    const range = rc.from && rc.to && rc.from !== rc.to ? ` (${rc.from} → ${rc.to})` : rc.to ? ` (${rc.to})` : "";
    wrap.appendChild(h("div", { class: "label", text: `Recent · last ${rc.windowDays} day${rc.windowDays > 1 ? "s" : ""}${range}` }));
    wrap.appendChild(h("div", { class: "rec-grid" }, [
      stat("Hit rate", `${pct(rc.legHitRate)} (${rc.legs})`),
      stat("Brier", rc.brier == null ? "—" : rc.brier.toFixed(3)),
      stat("Profit", money(rc.profit), (rc.profit ?? 0) >= 0 ? "up" : "neg"),
    ]));
  }

  // shadow fade — what flat-staking the OPPOSITE of every leg would have done. Honest gut-check
  // on whether the model has negative skill (fade > 50%) or is just noisy.
  const f = s.fade;
  if (f && f.legs) {
    wrap.appendChild(h("div", { class: "label", text: "🔄 Shadow fade · betting the opposite" }));
    wrap.appendChild(h("div", { class: "rec-grid" }, [
      stat("Fade hit rate", `${pct(f.hitRate)} (${f.legs})`, f.hitRate > 0.5 ? "up" : ""),
      stat("Est. profit", money(f.profit), (f.profit ?? 0) >= 0 ? "up" : "neg"),
      stat("Est. ROI", pct(f.roi), (f.roi ?? 0) >= 0 ? "up" : "neg"),
    ]));
    for (const b of f.byMarket || []) wrap.appendChild(h("div", { class: "gk" }, [
      h("span", { text: b.market }),
      h("span", { class: "est", text: `fade hits ${pct(b.hitRate)} (n=${b.n})` }),
    ]));
    wrap.appendChild(h("div", { class: "hint", text: "Fade wins when the model's pick loses. $ est. = flat $10 on two-way markets (Totals/BTTS/Corners), price inverted across the vig; Moneyline is 3-way so it counts toward hit rate only." }));
  }

  // calibration
  if (s.calibration && s.calibration.length) {
    wrap.appendChild(h("div", { class: "label", text: "Calibration · model % vs actual" }));
    for (const b of s.calibration) wrap.appendChild(h("div", { class: "gk" }, [
      h("span", { text: b.bucket }),
      h("span", { class: "est", text: `pred ${pct(b.predicted)} → hit ${pct(b.actual)} (n=${b.n})` }),
    ]));
  }

  // shots/corner projection accuracy (model est. vs actual final stats)
  const pa = data.projAccuracy;
  if (pa && (pa.corners || pa.shots)) {
    wrap.appendChild(h("div", { class: "label", text: "Projection accuracy · model vs actual" }));
    const accRow = (name, a) => { if (a) wrap.appendChild(h("div", { class: "gk" }, [
      h("span", { text: `${name} (n=${a.n})` }),
      h("span", { class: "est", text: `avg proj ${a.projAvg.toFixed(1)} → actual ${a.actualAvg.toFixed(1)} · off by ${a.mae.toFixed(1)}` }),
    ])); };
    accRow("Corners total", pa.corners);
    accRow("Total shots", pa.shots);
  }

  // history of recommended parlays, newest day first
  wrap.appendChild(h("div", { class: "label", text: "History · recommended parlays" }));
  if (!data.days || !data.days.length) { wrap.appendChild(h("div", { class: "muted", text: "No parlays logged yet." })); }
  for (const day of data.days || []) {
    wrap.appendChild(h("div", { class: "rec-day", text: day.date }));
    for (const p of day.parlays) wrap.appendChild(historyCard(p));
  }
  wrap.appendChild(h("div", { class: "disc", text: "⚠ Player-prop legs can't auto-settle from the score; those parlays stay pending." }));
  return wrap;
}

// --- standings / bracket view ---
function renderStandings(data) {
  titleEl.textContent = "Standings";
  const wrap = h("div", { class: "stand" });
  if (!data) { wrap.appendChild(h("div", { class: "center muted", text: "Loading standings…" })); return wrap; }
  if (data.error) { wrap.appendChild(h("div", { class: "center muted", text: `Couldn’t load: ${data.error}` })); return wrap; }

  // group stage shows the tables; once every group is complete it flips to the knockout bracket
  if (data.groupStageDone) return renderBracket(wrap, data);

  if (!data.groups || !data.groups.length) { wrap.appendChild(h("div", { class: "center muted", text: "No standings yet." })); return wrap; }
  wrap.appendChild(h("div", { class: "muted pick-hint", text: "green = advancing · top 2 per group" }));
  for (const g of data.groups) {
    wrap.appendChild(h("div", { class: "label", text: g.name }));
    const tbl = h("table", { class: "standtbl" });
    tbl.appendChild(h("tr", { class: "hd" }, [
      h("td", { text: "" }), h("td", { class: "num", text: "P" }), h("td", { class: "num", text: "W-D-L" }),
      h("td", { class: "num", text: "GD" }), h("td", { class: "num", text: "Pts" }),
    ]));
    for (const e of g.entries) tbl.appendChild(h("tr", { class: e.advanced ? "adv" : "" }, [
      h("td", { class: "tm" }, [flagImg(e.abbr, e.logo), h("span", { class: "pk-team", text: e.abbr })].filter(Boolean)),
      h("td", { class: "num", text: String(e.played) }),
      h("td", { class: "num", text: `${e.w}-${e.d}-${e.l}` }),
      h("td", { class: "num", text: String(e.gd) }),
      h("td", { class: "num pts", text: String(e.pts) }),
    ]));
    wrap.appendChild(tbl);
  }
  return wrap;
}

// bracket columns: winners flow left → right like a printed bracket. ESPN doesn't expose which
// tie feeds which, so linkage is inferred — a game feeds the next-round tie its winner appears
// in. Connector braces only draw once a column's pairings FULLY resolve (a wrong brace implies
// a wrong path, worse than none); unresolved rounds keep date order, columns only.
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
      // this tie's brace + incoming stub draw only once BOTH its feeders are identified
      ng.fed = !!(slots[2 * k] && slots[2 * k + 1]);
    });
    // per-pair link flags captured before back-filling, so unresolved pairs never get a brace
    rounds[i].linked = next.map((ng, k) => !!(slots[2 * k] && slots[2 * k + 1]));
    // back-fill unmatched games (still in date order) so the column stays complete mid-round
    const rest = [...left];
    for (let j = 0; j < slots.length; j++) if (!slots[j]) slots[j] = rest.shift();
    rounds[i].games = slots;
    rounds[i].paired = true;
  }
  return rounds;
}

// one compact two-line tie card for the bracket grid
function brkCard(g, mine) {
  const done = g.state === "post", live = g.state === "in";
  const sc = (n) => (g.state === "pre" ? "" : String(n));
  const row = (abbr, logo, score, win) => h("div", { class: `brk-t${done ? (win ? " win" : " out") : ""}` }, [
    flagImg(abbr, logo),
    h("span", { class: "bt-ab", text: abbr }),
    h("span", { class: "bt-sc", text: score }),
  ].filter(Boolean));
  const meta = [];
  if (live) meta.push(h("span", { class: "bt-live", text: g.statusText || "LIVE" }));
  else if (done) meta.push(h("span", { text: `FT${g.homeShoot != null || g.awayShoot != null ? ` · ${g.homeShoot ?? 0}–${g.awayShoot ?? 0} p` : ""}` }));
  else meta.push(h("span", { text: new Date(g.date).toLocaleDateString([], { month: "short", day: "numeric" }) }));
  if (g.state === "pre" && g.pred) {
    // same shorthand the model uses: half the draws break the favourite's way
    const advH = g.pred.wH + g.pred.wD * 0.5;
    meta.push(h("span", { class: "brk-pred", text: `${advH >= 0.5 ? g.homeAbbr : g.awayAbbr} ${Math.round(Math.max(advH, 1 - advH) * 100)}%` }));
  }
  return h("div", { class: `brk-card${live ? " islive" : ""}${mine ? " mine" : ""}${g.fed ? " fed" : ""}`, onclick: () => choose(g.id) }, [
    row(g.homeAbbr, g.homeLogo, sc(g.homeScore), g.homeWin),
    row(g.awayAbbr, g.awayLogo, sc(g.awayScore), g.awayWin),
    h("div", { class: "bt-meta" }, meta),
  ]);
}

function renderBracket(wrap, data) {
  titleEl.textContent = "Bracket";
  if (!data.knockout || !data.knockout.length) {
    wrap.appendChild(h("div", { class: "center muted", text: "Group stage done — knockout fixtures not posted yet." }));
    return wrap;
  }
  // "my path": ties involving the currently tracked match's teams get the gold treatment
  const mine = new Set(last?.match ? [last.match.home.abbr, last.match.away.abbr] : []);
  const isMine = (g) => mine.has(g.homeAbbr) || mine.has(g.awayAbbr);
  const cols = orderRounds(data.knockout);
  // third place isn't part of the winners' tree — it hangs off the end as its own column
  const third = data.knockout.find((r) => /third|3rd/.test(r.slug));
  if (third && third.games.length) cols.push({ slug: third.slug, label: third.label, games: [...third.games] });
  if (!cols.length) { wrap.appendChild(h("div", { class: "center muted", text: "No knockout games yet." })); return wrap; }

  wrap.appendChild(h("div", { class: "muted pick-hint", text: "winners flow left → right · tap a tie to open it" }));
  // path to the trophy for the tracked team: its current tie's priced advance prob, then a coin
  // flip per later round — honest about how little is knowable beyond the next opponent
  if (mine.size) {
    const treeCols = cols.filter((c) => !/third|3rd/.test(c.slug || ""));
    let team = null, p0 = null, idx = -1;
    outer: for (let i = 0; i < treeCols.length; i++) {
      for (const g of treeCols[i].games) {
        if (g.state === "post") continue;
        const hMine = mine.has(g.homeAbbr), aMine = mine.has(g.awayAbbr);
        if (!hMine && !aMine) continue;
        if (last?.match?.id === g.id && last.match.advance) {
          // the tracked match itself — follow whichever side the model favours to advance
          const adv = last.match.advance;
          team = adv.home >= adv.away ? g.homeAbbr : g.awayAbbr;
          p0 = Math.max(adv.home, adv.away);
        } else if (g.pred) {
          const advH = g.pred.wH + g.pred.wD * 0.5;
          team = hMine ? g.homeAbbr : g.awayAbbr;
          p0 = hMine ? advH : 1 - advH;
        }
        idx = i;
        break outer;
      }
    }
    if (team && p0 != null) {
      let p = p0;
      const parts = [];
      for (let i = idx + 1; i < treeCols.length; i++) {
        parts.push(`${ROUND_SHORT[treeCols[i].slug] || treeCols[i].label} ${Math.round(p * 100)}%`);
        p *= 0.5;
      }
      parts.push(`🏆 ${Math.round(p * 100)}%`);
      wrap.appendChild(h("div", { class: "muted brk-path", text: `${team} path: ${parts.join(" → ")} · coin flips beyond the priced tie` }));
    }
  }
  // once the final is decided, trace the champion's whole run in gold — their abbr marks every
  // tie they played, from the first round to the trophy
  const finalCol = cols.filter((c) => !/third|3rd/.test(c.slug || "")).pop();
  const finalGame = finalCol && finalCol.games.length === 1 ? finalCol.games[0] : null;
  const champAbbr = finalGame && finalGame.state === "post"
    ? (finalGame.homeWin ? finalGame.homeAbbr : finalGame.awayWin ? finalGame.awayAbbr : null) : null;
  const isChamp = (g) => !!champAbbr && (g.homeAbbr === champAbbr || g.awayAbbr === champAbbr);
  const card = (g) => {
    const c = brkCard(g, isMine(g));
    if (isChamp(g)) c.classList.add("champ");
    return c;
  };

  const brk = h("div", { class: "bracket" });
  // inner tree so the bracket centers when narrower than the window but still scrolls when wider
  const tree = h("div", { class: "brk-tree" });
  // every column shares one height (tallest round) so tie centers line up across rounds
  brk.style.setProperty("--rows", String(Math.max(...cols.map((r) => r.games.length))));
  for (const r of cols) {
    const col = h("div", { class: "brk-col" });
    col.appendChild(h("div", { class: "label brk-round", text: r.label }));
    const games = h("div", { class: "brk-col-games" });
    if (r.paired) {
      for (let j = 0; j < r.games.length; j += 2)
        games.appendChild(h("div", { class: `brk-pair${r.linked[j / 2] ? " linked" : ""}` }, [card(r.games[j]), card(r.games[j + 1])]));
    } else {
      for (const g of r.games) games.appendChild(h("div", { class: "brk-slot" }, [card(g)]));
    }
    col.appendChild(games);
    tree.appendChild(col);
  }
  if (champAbbr) wrap.appendChild(h("div", { class: "brk-path", text: `🏆 ${champAbbr} — champions. Their run is traced in gold.` }));
  brk.appendChild(tree);
  wrap.appendChild(brk);
  return wrap;
}

async function choose(id) {
  await window.wc.setMatch(id);
  viewMode = "match";
  body.replaceChildren(h("div", { class: "center muted", text: "Loading…" }));
}
