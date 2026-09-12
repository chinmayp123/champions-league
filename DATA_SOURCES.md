# Data sources

Every feed the app reads, what it provides, what it costs, and how it fails. All of them are
wrapped so a failure returns `null` and the caller degrades — see the best-effort rule in
[AGENTS.md](AGENTS.md).

Competition-specific ids for each feed live in `competition.mjs`, one entry per competition
(Premier League, LaLiga, Champions League; the World Cup kept), so adding one is a config change
plus a publisher pass and a live function on the website.

---

## In use

### ESPN — the backbone (`lib.mjs`, no key)
`site.api.espn.com/apis/site/v2/sports/soccer/<league>` plus the standings endpoint.
Provides live score and clock, box-score stats (shots, shots on target, possession,
**corners per side**, fouls, cards, passes, tackles), keeper stats, key events (goals,
cards, subs, shootout kicks), the standings table, and an inline pre-match odds line. No
player xG and no shot-level data.

`fixturePool()` covers the whole visible window in **one ranged call**
(`dates=YYYYMMDD-YYYYMMDD&limit=300`), so the slate, the picker and search all share a
single fetch. Refresh is every 30 s while a game is live.

### FotMob — xG, lineups, form (`fotmob.mjs`, no key)
FotMob's `/api/*` endpoints are gated behind a rotating signed `x-mas` header, but its
public pages embed the same server-rendered payload in `<script id="__NEXT_DATA__">`, which
isn't gated. That's what the module reads.

| Page | Gives |
|---|---|
| league matches | fixture list with matchday numbers and match-page links |
| match page | **shot map** (every shot with pitch coordinates, xG, xGOT, type, situation, keeper), team xG/xGOT/big chances, momentum series, **lineups with formations, pitch slots, live ratings and events**, attacking zones, team form |
| team page | the club's whole season across **every competition** (league, cup, Europe) with the same match-page links |

The team page is what makes matchday one work: `recentMatches()` takes a club's last three
competitive games from wherever it last played (friendlies skipped), so form, corner and
saves projections and scorer numbers exist before a competition has any history of its own.

Unofficial and brittle if the pages restructure. Player headshots come from
`images.fotmob.com/image_resources/playerimages/<id>.png` with an initials fallback.

### Action Network — FanDuel prices and public money (`actionnetwork.mjs`, no key)
Public JSON. Provides FanDuel's moneyline, spread and total (book id 69 plus state
variants), and the **public betting splits**: share of tickets versus share of money per
outcome. The money-versus-tickets divergence is the only sharp-money signal in the free
stack. This is also the primary odds source when no Odds API key is set. Its undated
scoreboard lists only the games around "now" (4 of a Saturday's 37 in the small hours), so
today's and tomorrow's dated boards (`&date=YYYYMMDD`, US Eastern days) are read as well.

### FanDuel public sportsbook API — corners, BTTS, player prices (`fanduel.mjs`, no key)
The same JSON FanDuel's own site fetches, with a public app key. Provides **total match
corners** over/under, **both teams to score**, and **anytime scorer / shots on target**
prices. Prices sit at `runners[].winRunnerOdds.americanDisplayOdds.americanOdds`, lines at
`runners[].handicap`.

League events come off the soccer SPORT page
(`content-managed-page?page=SPORT&eventTypeId=1`) filtered by FanDuel's `competitionId` —
228 Champions League, 10932509 Premier League, 117 LaLiga (141 MLS); there are no custom
competition pages. Player markets post late: early on a matchday an event can carry only
two markets, which reads as "no props", not as a matching failure. Optional config: `fanduelRegion` (your state
subdomain, default `nj`) and `fanduelWorldCupPageId` (only for competitions that do have a
custom page).

Single-book, so its player prices are **display-only** — there's no cross-book consensus to
de-vig against, therefore no honest edge.

### OddsPapi — best price across books (`oddspapi.mjs`, optional key)
250 requests a month on the free tier, all books in one response. Provides corners, BTTS,
draw-no-bet, team totals and Asian handicaps across books, which is what lets the Builder
show a real "best price" and the card price markets FanDuel alone doesn't cover. Books to
try are configurable (`oddspapiBooks`, default `fanduel,bet365`); responses are cached 30
minutes to 12 hours because pre-match lines barely move. Tournament ids: 7 Champions
League, 17 Premier League, 8 LaLiga (242 MLS). Every call is counted: the website's
publisher caps each competition at its monthly `oddspapiBudget` (Champions League 60,
Premier League 90, LaLiga 50 — 200 of the 250, the rest left for the other project),
because each run is a fresh process whose caches start empty.

**Watch for stale lines.** A ±0.5 handicap from a line shop that beats FanDuel's moneyline
on the same outcome is a stale price, not value — the card guards against exactly that.

### The Odds API — multi-book and props (`lib.mjs`, optional key)
500 requests a month, **shared with another project**. When present it becomes the primary
odds source: multi-book moneylines with a best-price comparison, plus anytime-scorer and
shots-on-target props for the tracked game. Spend is deliberately small: the events list
costs 2 credits and the tracked game's props 2, cached 30 minutes pre-match, 5 minutes in
play, and never refetched once a game is final. An exhausted key is remembered for the rest
of the process. The morning card never calls it.

---

## Honest gaps

- **No goalkeeper-saves market exists** in any feed reachable for free, so saves stay model
  estimates. The line is centred on the projection, which makes the probability meaningful,
  but there is nothing to beat.
- **Player props are single-book** unless The Odds API key is live, so scorer and
  shots-on-target numbers are display-only.
- **Corners have a real market** (FanDuel, OddsPapi) but the model's own corner projections
  proved badly calibrated (36% hit against 60% claimed over n=11), so corners are benched
  from the card and shown for reading only.
- **No expected lineups** before the confirmed XIs post, roughly an hour before kickoff.

---

## Team-name matching

Every feed spells clubs differently: `Bayern Munich` / `Bayern München`, `Internazionale` /
`Inter`, `Bodo/Glimt` / `Bodø/Glimt`, `Sporting CP` / `Sporting Lisbon`,
`Paris Saint-Germain` / `PSG`. `teams.mjs` is the single matcher — diacritics folded,
aliases canonicalised, generic tokens dropped, every distinctive token of the shorter name
required in the longer one, and **abbreviations matched only by exact equality**. All 36
Champions League clubs resolve against every feed, all 20 Premier League clubs against
FotMob and FanDuel (FanDuel's `Nottm Forest` needed an alias), and all 20 LaLiga clubs
against FotMob, FanDuel, The Odds API and Action Network. LaLiga needed two fixes that were
wrong-club bugs, not misses: `sociedad` used to be a generic token, which left "Real
Sociedad" as just "real" and matched it to Real Madrid, Real Betis and Racing Santander; and
ESPN's bare "Deportivo" (La Coruña) matched "Deportivo Alavés" until it was aliased to
`deportivo la coruna`.

This is not a nicety. The earlier per-module substring matchers put Dortmund's players on
Bayern's page and City's on United's, because ESPN's `MUN` and `MAN` codes appear inside
those longer names.

---

## Evaluated and not used

| Source | Would give | Cost | Verdict |
|---|---|---|---|
| **API-Football** (api-sports.io) | expected + confirmed lineups, player stats, fixture stats, a predictions endpoint, pre and live odds | free 100/day, $19/mo for 7,500/day | Best free upgrade if expected lineups matter. No xG. |
| **Sportmonks** | real xG, expected lineups, pressure index | free tier limited, paid for full | Best data quality, but FotMob already gives xG for free. |
| **SofaScore** (unofficial) | xG, shot maps, ratings, lineups | scraping | Rich but brittle and ToS-risky. FotMob already fills this role. |
| **SportsGameOdds** | player props across ~9 books on the free tier | free, gated | The realistic route to *de-viggable* prop consensus, which would let scorer legs earn a real edge. |
| **OddsJam / OpticOdds** | props across 100+ books | $99–499/mo | Overkill for a personal tool. |
| **BetsAPI** (bet365) | corners and cards markets | ~£20–30/mo | Only if corners become a serious market again. |

The model is isolated in `lib.mjs`, so adding a richer source means feeding better numbers
into the same prediction and de-vig pipeline, not a rewrite.

---

## Reading

- Dixon–Coles team strength (the planned engine):
  <https://dashee87.github.io/football/python/predicting-football-results-with-statistical-modelling-dixon-coles-and-time-weighting/>
- Expected saves as an inverse of xG:
  <https://www.soccermetrics.net/goalkeeping-analytics/expected-saves-an-inverse-of-expected-goals>
- Corners as a compound Poisson process: <https://arxiv.org/abs/2112.13001>
- De-vigging and pricing player props:
  <https://betpredictionsite.com/blog/prop-betting-iq-price-player-props/>
- Odds API comparison 2026: <https://oddspapi.io/blog/best-odds-apis-2026-comparison/>
