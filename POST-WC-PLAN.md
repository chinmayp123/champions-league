# Post-World-Cup Retrospective & Plan

Written 2026-07-22, after the 2026 World Cup finished. This is the honest end-of-tournament
autopsy of the parlay/betting model and where it goes next.

---

## 1. The final record (102 legs settled)

- **Leg hit rate: 40%** · **Brier: 0.235**
- Tracked card: **+$27.88 profit, +6% ROI**

Green on the surface. But every diagnostic underneath says that profit is **variance, not skill.**

### The model has negative skill against the market
Hit rate *falls* as the model's claimed edge *rises* — the opposite of what a real edge looks like:

| Model's claimed edge over the market | Legs | Hit rate |
|---|---|---|
| **Negative** (model said "avoid") | 8 | **75%** |
| 0–3% | 20 | 50% |
| 3–5% | 12 | 25% |
| 5–7% | 13 | 54% |
| **7–15%** (biggest disagreement) | 24 | **25%** |

The legs where the model most loudly disagreed with the price lost the most. The shadow-fade tracker
confirms it independently: **betting the opposite of every leg hit 58%**, and fading two-way markets
returned **+$42.66 / +9%** — better than the model itself.

### Derived markets were systematically overconfident
Predicted vs. actual hit rate: BTTS 54%→44%, Total 58%→47%, Corners 60%→36%, Scorer 32%→25%.
The 60–70% "confident" bucket predicted 64% and hit **36%** (n=22). Only **Moneyline** was honest
(34%→43%, actually underconfident — carried entirely by long-odds value-draws).

### CLV was negative
Closing-line value (n=7): avg **−1.3 pts**, beat-close **14%**. CLV is the one leak-proof edge signal,
and it said we were consistently on the wrong side of the market's move.

---

## 2. Root-cause diagnosis

The pregame engine (`scorePrediction` in `lib.mjs`) is `λ = 0.55·market + 0.45·Round-1-xG-form`.
The market half is efficient by construction, so **100% of the model's "edge" came from that 45%
form tilt** — and one-to-three games of tournament xG is far too noisy to beat a market that already
priced the same information plus lineups, injuries, and sharp money. The tilt didn't add signal; it
added variance around a fair price, and the edge-band selection then **preferentially bet the biggest
tilts — i.e. the biggest errors.** Corners/Scorers were worse still (thin projections, no real market
to anchor to), which is why they got benched mid-tournament.

**Verdict: the harness is 8–9/10; the prediction engine is ~4/10.** Everything built *around* the
engine — the betlog/settlement/push handling, CLV capture, learned calibrations (goalsBias,
edgeTrust), the two-axis correlation guard, the shadow-fade honesty check, and the whole widget —
is genuinely good. The Poisson-blend `scorePrediction` is the only part that failed, and it's the
only part to throw away.

---

## 3. What we learned (portable to every future model)

1. **Market-as-prior, not market-plus-a-tilt.** The closing price is the baseline. Only deviate with a
   *shrunk, validated* signal, and cap the deviation by learned trust (`edgeTrust` floored at 0.2 here
   — assume low trust until proven otherwise).
2. **CLV is the objective, not hit rate.** Grade every pick on beat-the-close. It's readable
   game-by-game; hit rate needs hundreds of settled bets. If you're not beating the close, there's no edge.
3. **Only price markets with a real closing line.** No close → no validation → bench it permanently.
4. **Correlation guard.** Never stack correlated legs; they win and lose together and compound the vig.
5. **Sample size is a hard limiter.** 82 WC games with no prior seasons is too little to *fit or even
   validate* a strength model. Use leagues with real history.
6. **Keep the harness, rebuild the engine.** The scaffolding was never the problem.

---

## 4. Where it goes next

The model has no demonstrated edge, so the fix is **structural, not another knob** (`edgeTrust` already
collapsed to its floor because claimed edges were uncorrelated with outcomes). Two forward tracks:

### Track A — NFL fantasy + props (building now)
New repo **`gridiron`** (sibling folder). One Electron widget, two tools: Sleeper fantasy start/sit +
NFL player-prop betting (anytime TD, team ML, rush/pass/rec yards by depth slot). It **ports this
project's entire harness** and rebuilds only the engine, applying every lesson above. NFL props have
real closing lines (the CLV signal the WC never had) and NFL data has full-season history (the sample
size the WC never had). Building the fantasy tool first — surer win, used weekly regardless of edge.

### Track B — EPL Dixon-Coles (later, off-season until ~Aug)
Replace the market-plus-tilt engine with a **Dixon-Coles time-decayed attack/defence fit**, still
market-anchored, CLV-optimised, Kelly-by-trust. A full-history league (EPL/La Liga) gives the sample
size to actually fit and validate it.

---

## 5. This repo going forward

`worldcup-tracker` (now `champions-league`) was **archived as-is** — a complete, honest record of a betting harness that worked
and a prediction engine that didn't. The value is the harness and the lessons, both of which live on
in `gridiron`. No further model work happens here; the World Cup is over.

---

## 6. Addendum (2026-09-08): repointed at the Champions League

Un-archived in practice: the harness now runs the **2026-27 UEFA Champions League** (league phase
kicked off 2026-09-08). Everything competition-specific moved into `competition.mjs`; the UCL bet
log is a fresh `bets/ucl-2026-27/` so WC calibrations don't carry over. Two-legged ties fold into one
bracket entry (aggregate + leg scores), the standings table shows the 36-team league phase with
qualification zones, and the picker looks three weeks ahead because matchweeks are sparse.

The engine is **unchanged** for now (still `market + form tilt`, still edgeTrust-floored), so treat
the tracked card as paper until CLV says otherwise. Next: Track B's Dixon-Coles engine fed by
domestic-league xG, which club football finally makes fittable.
