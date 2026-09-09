// competition — the ONE place that says which tournament the tracker is pointed at.
//
// Every data client (ESPN, The Odds API, OddsPapi, FotMob, FanDuel) keys off a per-competition
// identifier, and the widget's phase/knockout handling depends on the format. Both live here so
// repointing the whole tool is a config change, not a code hunt. The active competition is
// chosen by `"competition"` in odds.config.json (or the COMPETITION env var); default is the
// Champions League. The World Cup entry is kept as the reference the tool was built on.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
// where the user's own files live — odds.config.json (keys) and the bet log. In the repo that's
// the repo itself; the packaged desktop app points this at Electron's per-user data folder, so
// nothing personal ships inside the installer and the bet log survives updates.
export const DATA_DIR = process.env.STARBALL_DATA_DIR || HERE;
export function readConfig() {
  try { return JSON.parse(readFileSync(join(DATA_DIR, "odds.config.json"), "utf8")); } catch { return {}; }
}

export const COMPETITIONS = {
  ucl: {
    key: "ucl-2026-27",
    name: "Champions League",
    title: "Champions League 26/27",
    espn: "uefa.champions",                      // site.api.espn.com/.../soccer/<espn>
    oddsApiSport: "soccer_uefa_champs_league",   // The Odds API sport key
    oddspapiTournamentId: 7,                     // OddsPapi tournamentId ("uefa-champions-league")
    fotmob: { leagueId: 42, slug: "champions-league" },
    fanduel: { competitionId: 228, customPageId: null }, // FanDuel soccer SPORT page, filtered by competition
    // ESPN season.slug values that are NOT knockout rounds
    phaseSlugs: ["league-phase"],
    phaseGames: 8,                               // games per team in the league phase
    // league-phase zones by rank: 1–8 straight to the R16, 9–24 play-off, 25–36 out
    zones: [{ upTo: 8, cls: "adv", label: "R16" }, { upTo: 24, cls: "po", label: "play-off" }],
    standingsHint: "green = straight to R16 · amber = play-off round · top 8 / 9–24",
    // knockout rounds in bracket order (ESPN season.slug) + labels
    koOrder: ["knockout-round-playoffs", "round-of-16", "quarterfinals", "semifinals", "final"],
    koLabel: { "knockout-round-playoffs": "Play-off round", "round-of-16": "Round of 16", quarterfinals: "Quarter-finals", semifinals: "Semi-finals", final: "Final" },
    koShort: { "knockout-round-playoffs": "PO", "round-of-16": "R16", quarterfinals: "QF", semifinals: "SF", final: "FINAL" },
    // whole knockout window (the bracket scans all of it — a rolling window would drop early rounds)
    knockoutWindow: ["20270201", "20270615"],
    twoLegged: true,                             // ties are home-and-away except the final
    // how far the match picker / widget looks: matchweeks are Tue–Thu every 2–3 weeks, so a
    // ±2-day window would show nothing between them
    lookBackDays: 4, lookAheadDays: 21,
    betlogDir: join(DATA_DIR, "bets", "ucl-2026-27"),
  },
  wc: {
    key: "wc-2026",
    name: "World Cup",
    title: "World Cup 2026",
    espn: "fifa.world",
    oddsApiSport: "soccer_fifa_world_cup",
    oddspapiTournamentId: 16,
    fotmob: { leagueId: 77, slug: "world-cup" },
    fanduel: { competitionId: null, customPageId: "fifa-world-cup" },
    phaseSlugs: ["group-stage"],
    phaseGames: 3,
    zones: [{ upTo: 2, cls: "adv", label: "advance" }],
    standingsHint: "green = advancing · top 2 per group",
    koOrder: ["round-of-32", "round-of-16", "quarterfinals", "semifinals", "third-place", "3rd-place-match", "final"],
    koLabel: { "round-of-32": "Round of 32", "round-of-16": "Round of 16", quarterfinals: "Quarter-finals", semifinals: "Semi-finals", "third-place": "Third place", "3rd-place-match": "Third place", final: "Final" },
    koShort: { "round-of-32": "R32", "round-of-16": "R16", quarterfinals: "QF", semifinals: "SF", "third-place": "3RD", "3rd-place-match": "3RD", final: "FINAL" },
    knockoutWindow: ["20260627", "20260720"],
    twoLegged: false,
    lookBackDays: 2, lookAheadDays: 2,
    betlogDir: join(DATA_DIR, "bets"),
  },
};

function pick() {
  let key = process.env.COMPETITION;
  if (!key) {
    key = readConfig().competition;
  }
  return COMPETITIONS[(key || "ucl").toLowerCase()] || COMPETITIONS.ucl;
}

export const COMP = pick();
export const isPhaseSlug = (slug) => !slug || COMP.phaseSlugs.includes(slug);
// plain-data subset the widget shows (title bar, round pills, standings hint)
export const compMeta = () => ({ key: COMP.key, name: COMP.name, title: COMP.title, koShort: COMP.koShort, standingsHint: COMP.standingsHint, twoLegged: COMP.twoLegged });

// domestic league of each club in this season's field — no feed the widget reads carries it, so
// it's a season map matched on ESPN's display name (widest patterns last so "Inter" can't grab
// anything else). Unknown club → null, and the UI just leaves the line out.
const CLUB_LEAGUES = [
  [/real madrid|barcelona|atl[eé]tico|villarreal|betis/i, "LaLiga"],
  [/arsenal|liverpool|manchester|aston villa/i, "Premier League"],
  [/bayern|dortmund|leipzig|stuttgart/i, "Bundesliga"],
  [/internazionale|inter milan|napoli|roma|como/i, "Serie A"],
  [/paris|lens|lille|marseille/i, "Ligue 1"],
  [/porto|sporting|benfica/i, "Primeira Liga"],
  [/psv|feyenoord|ajax/i, "Eredivisie"],
  [/brugge|anderlecht/i, "Pro League"],
  [/fenerbah|galatasaray/i, "Süper Lig"],
  [/aek|olympiacos|panathinaikos/i, "Super League"],
  [/bod[øo]|viking/i, "Eliteserien"],
  [/slavia|sparta/i, "Czech Liga"],
  [/slovan/i, "Niké liga"],
  [/shakhtar|dynamo kyiv/i, "Ukrainian PL"],
  [/lask|salzburg|sturm/i, "Austrian Bundesliga"],
  [/sabah|qaraba/i, "Azerbaijan PL"],
  [/celtic|rangers/i, "Scottish Prem"],
];
export const clubLeague = (name) => (CLUB_LEAGUES.find(([re]) => re.test(name || "")) || [])[1] || null;
