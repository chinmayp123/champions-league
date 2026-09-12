# Futbol Lab

A football match tracker and betting harness for the **Premier League**, **LaLiga** and the
**2026-27 UEFA Champions League**, with MLS next: live scores, real shot-level xG, lineups
on a pitch, a model that prices every market, a paper bet card that grades itself, and a
scorecard that judges the model. It was Starball Lab while it covered only the Champions
League.

**On the web:** [futbol-lab.vercel.app](https://futbol-lab.vercel.app) ·
[chinmayp123.github.io/futbol-lab](https://chinmayp123.github.io/futbol-lab/) — the same
front end as the desktop widget (below), fed by Firestore. Switch competitions in the title
bar (`?c=epl`, `?c=laliga`, `?c=ucl`). Match data is public; the bet record, the day's card and slip
tracking need the owner's Google sign-in.

Zero runtime dependencies — Node 18+ and Electron. ESPN, FotMob, FanDuel and Action Network
are all keyless; two optional keys unlock cross-book line shopping.

> **Built for the 2026 World Cup, repointed in September 2026.** Every competition-specific
> id and format rule lives in `competition.mjs`. Switch back with `"competition": "wc"` in
> `odds.config.json` (or `COMPETITION=wc`). Each competition keeps its own bet log under
> `bets/`, so calibrations never bleed across tournaments.

**Docs:** [ARCHITECTURE.md](ARCHITECTURE.md) (how it's built) ·
[MODEL.md](MODEL.md) (the maths) · [DATA_SOURCES.md](DATA_SOURCES.md) (the feeds) ·
[DESIGN.md](DESIGN.md) (the design system) · [AGENTS.md](AGENTS.md) (working on it)

---

## Quickstart

```sh
npm install         # first time — pulls Electron
npm run widget      # launch the widget
```

Nothing else is required. Without any API key you still get live scores, xG, lineups,
FanDuel prices, public betting splits, predictions and the card; a key only adds cross-book
best prices.

Other entry points:

```sh
node cli.mjs        # terminal tracker (same data layer)
node morning.mjs    # build + record today's card (what the 10:00 task runs)
npm run dist        # Windows installer into dist/
```

---

## The website

The browser can't run the data layer (the feeds refuse cross-origin calls and the odds keys
would be public), so it runs elsewhere, all on free tiers:

- **GitHub Actions** (`.github/workflows/publish.yml`, every 5 minutes) runs
  `publisher/publish.mjs` once per competition: the slate, match views, table and record
  without odds keys, then a rationed keyed step for the 10:00 Pacific card, the builder and
  closing prices. It writes to **Firestore** (project `champions-league-a650f`, one subtree
  per competition, locked down by `firestore.rules`).
- **Vercel** (`api/live/<competition>.mjs`) builds a fresh match view on demand for a game
  that's live or about to be, since GitHub starts cron runs late.
- **`web/build.mjs`** assembles the site from `widget/renderer.js`, `style.css` and
  `index.html`; `web/wc.js` stands in for the Electron bridge. Pages builds it on push;
  Vercel builds it on `vercel deploy --prod`.

The owner signs in with Google, and the account is enrolled once with
`node publisher/add-owner.mjs <uid>` (the Record tab shows the uid). Full detail in
[ARCHITECTURE.md](ARCHITECTURE.md#the-website--github-pages--firebase-free-tier--vercel).

---

## The widget

Five tabs in a 50px broadcast title bar. The shell is the "Broadcast" design system —
Barlow Condensed for names, JetBrains Mono for numbers, square corners, a lower third and a
crawl — in night navy.

### Matchday
The landing view, and a calendar. A day strip marks which leagues play each day; pick a day
and every game from every competition is listed in kickoff order as a kit-coloured card
tagged with its league (◀ ▶ jump between days with games). Above it, a hero for the tracked
game painted in both clubs' colours with their crests as silhouettes; below, tonight's card
— across every league on the website — as ticket cards with a five-cell number strip (model
%, book %, edge, EV, half-Kelly) and the reasoning. On a **Champions League week**
(Monday–Thursday of a week with UCL games) the site opens on the Champions League, a banner
marks the week, its games lead every day, and the starball watermark comes back. When the card is empty a **Why** panel lists
every game and the reason it didn't qualify.

### Match
The tracked game in depth.

- **Lower third** — crests, score, status and the headline numbers (win probability,
  predicted score, live moneyline, xG per side, other live games).
- **Stat strip** — six tiles of the numbers that matter right now.
- **The pitch** — both XIs in formation from FotMob with headshots, shirt numbers, live
  ratings and event badges; every shot plotted where it was taken and sized by xG, goals
  ringed. Hover a player, a corner flag, a goalmouth, a penalty box, the centre spot or the
  bench for a popover of that thing's numbers; click a player to pin them and light up
  their shots. A Lineups / Shots / Both switch controls the layers.
- **Pre-match call** — the model's frozen prediction, shown once the game kicks off and
  ticked as each part is decided.
- **Match sheet** — a minute timeline of goals, cards and subs; a mirrored team comparison
  with form; a players table; a market row (odds with implied chances, public tickets vs
  money, the recommendation); and tiles for keeper saves, corners and conditions. At full
  time the market row settles: closing line with the winner ticked, how the public landed,
  and a Result card.
- Before kickoff the model's read leads and the pitch moves below it, since there are no
  shots to plot yet.

### Builder
A market board for any upcoming game — result axis, goals axis, scorers — with a verdict on
every cell (bet, lean, pass, fade, guarded, with the guard's reason). Click cells to build a
slip; the rail prices it with Model / Book / Edge boxes, EV, half-Kelly and correlation
warnings, and can track it into the bet record.

### Table
The 36-club league phase as one ordered list: a coloured rank gutter, a labelled cut row at
each zone change (top 8 straight to the round of 16, 9–24 to the play-off, 25–36 out),
crest, club, domestic league, played, W-D-L, goal difference, points, the last result and
the next fixture. Once the phase ends it becomes the knockout bracket with two-legged ties
folded to aggregate. A domestic league is the same list with its own zones — Premier League:
top four to the Champions League, fifth to the Europa League, bottom three relegated — and
no bracket.

### Record
Two scorecards. The **model** scorecard: every pre-match call frozen before kickoff and
graded at full time — result-right rate, exact scores, over 2.5 and BTTS calls, 1X2 Brier,
plus scorer projections with a calibration check by band. The **bet** record: leg hit rate,
Brier, profit, ROI, bankroll curve, calibration, a shadow-fade check, and closing-line value
per leg.

### Getting around
`◀` / `Esc` / `Alt+←` walk back through views. `/` focuses search — a club or a fixture
opens that match. Any game card, table row or bracket tie is clickable; `↻ Auto-follow`
returns to whichever game is live. `⤢` toggles a 300px compact mode that keeps the lower
third, prediction and top picks; the native caption buttons mean Windows 11 Snap Layouts
works, so several widgets tile 2×2. `📌` toggles always-on-top. Refresh is every 30 s,
backing off to 2 minutes at halftime.

---

## Configuration

`odds.config.json` sits in the data folder (the repo when run from source, the per-user app
data folder when installed — tray menu → **Open data folder**). It is gitignored; never
commit it.

```jsonc
{
  "competition": "ucl",        // or "wc"
  "oddsApiKey": "…",           // optional: The Odds API (multi-book + props)
  "oddspapiKey": "…",          // optional: OddsPapi (best price across books)
  "oddspapiBooks": "fanduel,bet365",
  "fanduelRegion": "nj"
}
```

Both keys are optional and both free tiers are small (500 and 250 requests a month) and
**shared with another project**, so the app caches aggressively and the morning card never
calls them per game.

---

## Installers

`npm run dist` builds `dist/Futbol-Lab-Setup-<version>.exe`. Pushing a version tag
(`git tag v1.2.0 && git push origin v1.2.0`) makes GitHub build the Windows setup and macOS
`.dmg` files for Intel and Apple silicon and attach them to a release.

Neither is code-signed: Windows shows a SmartScreen "More info → Run anyway" the first
time, macOS needs right-click → Open. The installed app keeps its own data folder, so
updates never touch the bet log.

---

## Honest about what this is

The pre-match model is largely a **re-expression of the market's own prices**, so its
"edges" are mostly its own rounding error. Three guards exist to catch that, the card
refuses to bet long shots or games it can't price, and it goes quiet on plenty of
matchdays. Scorer, corner and keeper-saves projections are display-only — small samples,
no closing line to check against.

The card is **paper** until closing-line value says otherwise, and the model scorecard is
being collected as the training set for a proper Dixon–Coles engine. A bookmaker calls the
winner about 55% of the time; if this app ever claims 90%, that's a bug.

Not betting advice. Sportsbook prices are negative expected value on average.

---

## Data

ESPN's public scoreboard and summary endpoints for the active competition provide scores,
box scores, standings and events. FotMob supplies shot-level xG, lineups, ratings and form
(read from the public pages' embedded data). Action Network supplies FanDuel prices and
public betting splits. FanDuel's public sportsbook API supplies corners, BTTS and player
prices. OddsPapi and The Odds API add cross-book prices when a key is present. All of them
are unofficial and best-effort: any failure degrades a view rather than breaking it. Full
detail in [DATA_SOURCES.md](DATA_SOURCES.md).
