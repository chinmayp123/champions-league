# worldcup-tracker

> **Now pointed at the 2026-27 UEFA Champions League.** The tool was built for the 2026 World Cup;
> since September 2026 it runs the Champions League instead. Every competition-specific id (ESPN,
> The Odds API, OddsPapi, FotMob, FanDuel) and the format rules (league phase, two-legged ties,
> knockout window, bet-log folder) live in `competition.mjs`. Switch back with
> `"competition": "wc"` in `odds.config.json` (or `COMPETITION=wc`). Each competition keeps its
> own bet log under `bets/`, so calibrations never bleed across tournaments.

Live FIFA World Cup 2026 match tracker for your terminal. Zero dependencies — just Node 18+ (uses ESPN's public API, no key required).

```
  Canada  1 - 0  Bosnia-Herzegovina    ● LIVE  37'
  BMO Field   updated 3:16:26 PM

  CAN ████████████████ ██████████████ BIH   possession

      54.5            Possession %        45.5
         0               Shots               3
         1               Corners             0
        ...

  Match events
   11'  🟨 CAN Alistair Johnston
   34'  ⚽ GOAL CAN Jonathan David
```

## Desktop widget

A frameless, always-on-top desktop widget (Electron) is included alongside the CLI. It
reuses the same data + model layer (`lib.mjs`), so scores, odds, predictions, recommended
bets, and keeper-saves projections stay in sync with the terminal version.

```sh
npm install      # first time — pulls Electron
npm run widget   # launch the floating widget
```

The shell is parlay-lab's "Broadcast" system (Barlow Condensed / JetBrains Mono, square
corners, lower-third + crawl) re-skinned to Champions League navy — the "Starball Lab" look.

- **Five tabs** in the 50px title bar: **Matchday** (hero for the tracked game, tonight's
  card as ticket cards, the slate as kit-coloured game cards) · **Match** (lower third with
  the headline numbers, a six-tile stat strip, the **pitch** — both XIs in formation with
  live FotMob ratings and event badges, every shot plotted and sized by xG, and hover zones
  on the corner flags, goalmouths, boxes, centre circle and benches that pull up corners
  projections, keeper save lines, shots-in-box, momentum and the subs; click to pin — then
  every section as a card: win-prob story, momentum, recommended bets, xG, stats, odds +
  line shopping, public betting, keepers, corners, scorers, projections, events) · **Builder** (market board with verdict cells +
  a slip rail with Model / Book / Edge boxes, EV, Kelly and correlation warnings) ·
  **Table** (36-club league phase with zones, or the bracket once the phase ends) ·
  **Record** (stat strip, bankroll, calibration, shadow fade, history tickets with CLV).
- **Navigation** — `◀` / `Esc` / `Alt+←` walk back through views; `/` focuses the search box
  (a club or a fixture opens that match). Tap any game card, table row or bracket tie to
  follow it; the `↻ Auto-follow` toggle goes back to whichever game is live.
- **Compact mode** (`⤢`, 300px wide) keeps the lower third, prediction and top picks for a
  floating widget; the native caption buttons give Windows 11 Snap Layouts so several
  widgets tile 2×2. `📌` toggles always-on-top; closing the window keeps the tray icon.
- Auto-refreshes every 30s (backs off to 2 min at halftime); falls back to the next
  upcoming match when nothing is live. Picks show pre-match (market-based) and switch to
  the live run-of-play read after kickoff.

## CLI usage

```sh
node worldcup.mjs              # auto-track the live game (or list today's matches)
node worldcup.mjs list         # upcoming schedule (today + next 2 days) with odds
node worldcup.mjs groups       # all 12 group standings tables
node worldcup.mjs canada       # track a match by team name, abbreviation, or event id
node worldcup.mjs usa --once   # single snapshot, no refresh loop
node worldcup.mjs usa -i 15    # refresh every 15 seconds (default 30, min 10)
```

While tracking, the screen refreshes in place with the live score, match clock, possession bar, full stat comparison (shots, corners, fouls, cards, passes, tackles, and more), and a timeline of goals, cards, and substitutions. Tracking stops automatically at full time.

## What it shows

- **Score and clock** — live minute, halftime, full time
- **Predicted final** — a model score prediction with a most-likely scoreline and win/draw/win probabilities. Pre-match it's market-based (expected goal total split by the favourite's implied edge); once live it's driven by the run of play (each side's xG rate blended toward a neutral prior, trusting the observed rate more as the match wears on). Labeled as a model estimate, with an early/low-confidence flag in the opening exchanges.
- **Possession bar** — visual split between the two teams
- **Stats table** — the leading team's number is bolded per stat
- **Goalkeepers** — each keeper's saves, goals conceded, and shots faced (includes subbed-in keepers), plus a **model-derived saves line**: projected total saves at full time and an over/under 2.5 probability with fair odds. No sportsbook in the feed offers a keeper-saves market, so this is clearly labeled as a model estimate, not a book price.
- **Recommended bets** — a compact live read shown on every refresh: the model's strongest lean(s) with a confidence tag (color-coded), derived from the run-of-play dominance index vs. the live market price. The fuller breakdown with reasoning appears at halftime (see below). Heuristic, clearly labeled — not a tip service.
- **Pre-match odds** — moneyline for each outcome with vig-stripped implied win probabilities, plus spread and over/under. Note: ESPN's free API only carries the opening line, not live in-play odds.
- **Group standings** — the live group table (rank, played, W-D-L, goal difference, points) with both teams in the current match highlighted
- **Match events** — goals ⚽, yellow 🟨 / red 🟥 cards, substitutions 🔁, with minute and player
- **Goal alert** — a terminal bell and flashing banner the moment the score changes while live-tracking
- **Halftime read** — at the break, compares the run of play (xG-proxy, shots, possession, corners) against the score and the live market price, and surfaces betting *considerations* with reasoning and a confidence tag. Heuristic, not a tip service — clearly labeled as such.

## Live odds (optional)

By default the odds section shows ESPN's pre-match opening line. To get **live in-play odds with FanDuel and cross-book line shopping**, add a free [The Odds API](https://the-odds-api.com/) key one of two ways:

```sh
# either an env var
export ODDS_API_KEY=your_key_here

# or a gitignored config file next to the script
echo '{ "oddsApiKey": "your_key_here" }' > odds.config.json
```

With a key set, live matches show FanDuel's moneyline (with vig-stripped implied probabilities) plus the best available price across all US books for each outcome — a `▲` marks where a book beats FanDuel. Odds are cached and refetched at most once every 2 minutes to stay within the free tier's 500-request quota.

Your key is never committed: `odds.config.json` and `.env` are in `.gitignore`.

## Data source

ESPN's public scoreboard and summary endpoints for `soccer/fifa.world` (scores, stats, standings, events) — unofficial, unauthenticated, rate-limit friendly at the default 30s refresh. Live odds come from The Odds API when a key is provided.
