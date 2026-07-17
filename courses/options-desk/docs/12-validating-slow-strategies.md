# 12 · Validating slow strategies — the gate problem

## What it is

The desk's other two families validate on statistics: stat-arb's gate demands a deflated Sharpe ≥ 0.95 across ≥ 20 out-of-sample trades; the MM desk reads thousands of fills per session. A 30-day option cycle produces **twelve observations a year**. Run the arithmetic below and the conclusion is unavoidable: *no statistically self-sufficient verdict on a monthly-cycle strategy is reachable inside any usable time frame.* Most of the industry responds by quietly lowering the bar. This chapter is the desk's response: change **what is measured** (cycle accounting instead of trade P&L), **where the distribution comes from** (your own tape, block-bootstrapped, instead of the strategy's short live record), and **what must be true before capital moves** (construction checks and calibration scores that converge fast even when P&L significance can't). It is the most important chapter in the course because every failure mode of slow strategies — including the honest operator's — is a validation failure before it is a market one.

## Math sketch

### The arithmetic of not knowing

The standard error of a measured Sharpe ratio over $N$ periods is approximately $\sqrt{(1 + SR^2/2)/N}$. A genuinely good options book might run at SR 1.0 annualized. On monthly cycles:

| Years live | N | SE of measured SR | 95% CI around a true SR of 1.0 |
|---|---|---|---|
| 1 | 12 | 0.30 | (0.4, 1.6) — indistinguishable from mediocre |
| 3 | 36 | 0.17 | (0.66, 1.34) — still arguable |
| 8 | 96 | 0.11 | finally resembling knowledge |

And that table is *optimistic*: it assumes i.i.d. cycles, while short-vol P&L is negatively skewed — the estimator converges even slower because the rare left tail carries the information. **Twenty OOS trades at monthly cadence is two years of walk-forward just to reach the stat-arb gate's minimum.** The gate isn't wrong; it's unreachable. Three practical corollaries: a green first year proves *nothing* (the #42 measurement says short vol wins 86.3% of windows — a year of wins is the base rate, not evidence of skill); the temptation to size up on that green year peaks exactly when the sample is most worthless (§1's "the operator's failure modes are not priced"); and any validation regime for this desk must lean on quantities that converge faster than P&L. There are four.

### 1. Cycle accounting: measure the mechanism, not the outcome

P&L per cycle mixes the edge with the noise. **Premium capture** — retained/collected per cycle — isolates the mechanism: it asks "of the premium the VRP said was there, how much survived management, hedging, and costs?" Its variance is a fraction of P&L's (the denominator normalizes out size and vol level), so its mean is estimable in months, not years. The desk's income books pre-register capture bars (wheel ≥ 55%, ladder rungs > 0 net in ≥ 60% of cycles) because capture is *diagnostic*: a book that captures 70% of premium in a losing month has an edge and bad luck; a book that captures 20% in a winning month is lucky and broken. P&L cannot tell those apart; capture can.

### 2. Distribution before trigger (the R7 rule)

Every threshold in this course — VRP gate points, calendar z, skew z, credit-to-width floors — is set from **≥ 30 days of the desk's own surface tape**, never a priori. The carry desk paid for this lesson (a fee-math trigger that never fired because the measured distribution lived elsewhere); the options desk inherits it as a birth rule. The subtle benefit for slow strategies: the *signal distribution* accrues at tape speed (hourly rows), not cycle speed — you can know your trigger is sane long before you can know your P&L is.

### 3. Block bootstrap: borrow power from the tape

The strategy's live record is 12 points/year, but the *inputs* (IV, RV, spreads) have thousands of hourly observations. Resample the tape in **weekly blocks** (blocks preserve vol clustering; i.i.d. resampling destroys it and flatters every short-vol strategy), replay the book's mechanical rules over each resampled path, and the output is a *distribution* of cycle outcomes — including tail cycles history happened not to serialize this particular year. This is the #42 method (117 rolling windows from 30 days of data) grown up. Its two honest limits: it can only recombine regimes the tape contains (a tape with no cascade cannot bootstrap one — the stress grid §11 covers the unseen), and it validates *rules*, not discretion (which is fine: the desk's books contain no discretion, by design, partly *for* this reason).

### 4. Construction checks: make the claim a spec, not a statistic

The fastest-converging validation is the one that needs zero samples: a **provable property enforced in code**. The collar cannot breach its floor (§5's `assertFloorHeld` — a breach is a bug, and bugs are found by specs, not by years); the vertical's max loss is fixed at fill (§8); every short is collateralized at entry (§1). The design principle: *push as much of each book's risk story as possible from the statistical column into the structural column*, because the structural column validates at compile-and-spec speed. This is the deep reason the desk prefers defined-risk structures at long horizons — not that undefined risk can't pay, but that **undefined risk can't be validated at this cadence.**

### 5. Calibration before capital (the ORV lesson, institutionalized)

The desk's probability book taught this the expensive way (#96: six trades, five small wins, one full-collateral loss — n=6 decides nothing, and the book's verdict variable was moved to *calibration*, Brier-scored over ≥ 100 settles with no positions). The options-desk version: every book runs **scored-paper** — signals, would-be fills at the tape's real half-spreads, cycle outcomes logged and scored — before token capital, and token capital before size. What scored-paper measures converges fast: is the gate firing when it should (compare gate state to the tape retroactively)? Are would-be fills achievable (spread paid vs spread recorded)? Is capture in the pre-registered range? A book can *fail* scored-paper in two months; it can only *deserve* capital through it.

### 6. The hurdle: an honest benchmark, always visible

Every slow strategy needs the comparison that keeps it honest, rendered on the same tear-sheet: the income books vs **unconditional selling** (the same structure with no gate — if the gate isn't adding capture, it's complexity theater); the desk curve vs **spot buy-and-hold** and vs the **carry desk's** yield on the same capital (the internal opportunity cost, §10's inequality generalized). The mission's own language applies: a truthful "the gated wheel did not beat the ungated wheel" is a *finding* — the demo's product is honest numbers, not flattering ones.

## When it works / when it breaks

**Works:** as a system — no single instrument above is sufficient, but a book that (a) passes its construction specs, (b) triggers off a measured distribution, (c) bootstraps to an acceptable tail, (d) scores well on paper for a quarter, and (e) clears its hurdle benchmark has earned token capital *by the strongest composite standard available at this cadence*, and the desk can say precisely which of the five legs any later failure violated.

**Breaks:** regime shift — every leg above learns from the tape, and a genuinely new regime (a structural repricing of crypto vol after, say, spot-ETF maturity) invalidates tape-derived thresholds and bootstrap distributions simultaneously. The defenses are the re-gate cadence (thresholds re-fit monthly; a gate that stops firing is investigated, not overridden), the stress grid (regime-independent by construction), and epistemically the pre-registration culture itself: **a desk that wrote down what would count as failure notices failure years before a desk that didn't.** The residual break is the human one — eleven green months of a negatively-skewed book whispering "the gate is too conservative" — and the only defense ever found for it is the one this chapter is: the metric was chosen *before* the streak, and the streak doesn't get a vote.

## Code shape

```typescript
/** One scored cycle — the row the whole validation regime reduces to. */
export interface ScoredCycle {
  bookId: string;
  cycleEndMs: number;
  mode: 'scored-paper' | 'token-capital' | 'sized';
  premiumCollectedUsd: number;
  premiumRetainedUsd: number;      // after management, hedges, and tape-real costs
  captureFrac: number;             // retained / collected — the fast-converging mechanism metric
  gateFiredCorrectly: boolean;     // retro-check of the gate vs the tape (calibration leg)
  constructionChecksPass: boolean; // floors held, max-losses respected — MUST be true; false = bug
  hurdleDeltaUsd: number;          // vs the pre-registered benchmark (ungated twin / spot / carry)
}

/** Promotion is mechanical: the pre-registered bar, the pre-registered sample, nothing else. */
export function promotionVerdict(cycles: ScoredCycle[], minCycles: number, captureBar: number):
    'PROMOTE' | 'CONTINUE' | 'CUT' {
  if (cycles.some(c => !c.constructionChecksPass)) return 'CUT';        // a bug is not a drawdown
  if (cycles.length < minCycles) return 'CONTINUE';
  const meanCapture = cycles.reduce((a, c) => a + c.captureFrac, 0) / cycles.length;
  const positiveFrac = cycles.filter(c => c.captureFrac > 0).length / cycles.length;
  return meanCapture >= captureBar && positiveFrac >= 0.6 ? 'PROMOTE' : 'CUT';
}
```

## Sources

- Bailey & López de Prado (2014), "The Deflated Sharpe Ratio" — the fast-strategy gate whose sample demands motivate this chapter.
- Politis & Romano (1994) — the stationary block bootstrap; López de Prado, *Advances in Financial Machine Learning* ch. 11–12 on why blocks, not i.i.d.
- Gneiting & Raftery (2007) on proper scoring rules — the calibration leg's foundation (Brier scoring, as used by the desk's probability book).
- Meridian: journal #96 (the calibration-before-capital doctrine's origin: −$78.65 and n=6), #42 (the window-resampling method), PROFIT_PIVOT_II R7/R10 (distribution-first triggers; "gates are cheap, track records are slow" — the culture this chapter operationalizes).
