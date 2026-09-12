// teams — ONE strict club-name matcher for every feed (ESPN ↔ FotMob / Action Network / FanDuel /
// OddsPapi / The Odds API). Every feed spells clubs a little differently, and the old per-module
// matchers accepted any substring — including a 3-letter abbreviation inside a longer name —
// which paired Bayern Munich (ESPN "MUN") with Dort-MUN-d and Manchester United ("MAN") with
// MANchester City, so the wrong players, form and prices flowed in. Rules here:
//   · fold diacritics (München → munchen, Bodø → bodo), drop generic tokens (fc, sc, club …)
//   · canonicalise the few names the feeds disagree on (Inter / Internazionale, Man Utd, PSG …)
//   · match when every distinctive token of the shorter name appears in the longer one
//   · an abbreviation matches only by EXACT equality against a feed's own abbreviation field
const FULL_ALIAS = {
  "psg": "paris saint germain", "paris sg": "paris saint germain",
  "man city": "manchester city", "man utd": "manchester united", "man united": "manchester united",
  "sporting lisbon": "sporting cp", "sporting clube de portugal": "sporting cp",
  "bruges": "club brugge", "slavia praha": "slavia prague", "bayern": "bayern munchen",
  "nottm forest": "nottingham forest", "nott m forest": "nottingham forest", "spurs": "tottenham hotspur", "wolves": "wolverhampton wanderers",
};
const TOKEN_ALIAS = { internazionale: "inter", munich: "munchen", muenchen: "munchen", praha: "prague", atletico: "atletico", atlético: "atletico" };
const GENERIC = new Set(["fc", "cf", "sc", "ac", "afc", "club", "de", "the", "and", "of", "sk", "fk", "sv", "bk", "if", "ss", "us", "ud", "cd", "rc", "rcd", "bsc", "tsv", "sl", "cp", "rb", "as", "ssc", "ogc", "rsc", "kaa", "krc", "losc", "stade", "olympique", "fotball", "fotballklubb", "fussball", "calcio", "sociedad", "1907", "1899", "1900", "1904", "1909", "1913", "1914"]);

export const fold = (s) => (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
  .replace(/ø/g, "o").replace(/æ/g, "ae").replace(/ß/g, "ss").replace(/ł/g, "l").replace(/đ/g, "d").replace(/ı/g, "i")
  .replace(/[^a-z0-9]+/g, " ").trim();
export function tokens(s) {
  const f = fold(s);
  return (FULL_ALIAS[f] || f).split(" ").map((t) => TOKEN_ALIAS[t] || t).filter((t) => t.length >= 3 && !GENERIC.has(t));
}
// do two club names refer to the same club?
export function teamMatch(a, b) {
  const A = tokens(a), B = tokens(b);
  if (!A.length || !B.length) return false;
  const sub = (X, Y) => X.every((t) => Y.includes(t));
  return sub(A, B) || sub(B, A);
}
// does a feed's team (any of its name spellings, plus its own abbreviation field) match an ESPN
// ref { name, abbr }? Abbreviations only ever match exactly.
export function refMatch(names, ref, feedAbbr = null) {
  if (!ref) return false;
  if ([].concat(names).filter(Boolean).some((n) => teamMatch(n, ref.name))) return true;
  return !!(feedAbbr && ref.abbr && String(feedAbbr).toUpperCase() === String(ref.abbr).toUpperCase());
}
// "Home v Away" / "Home vs Away" / "Home @ Away" / "Home - Away" → [home, away] or null
export function splitFixtureName(s) {
  const m = String(s || "").split(/\s+(?:v|vs|vs\.|@|-|–|—)\s+/i);
  return m.length === 2 ? m : null;
}
