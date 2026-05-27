# 6. Backtesting honestly

!!! abstract "Where this chapter fits"
    **Feeds in from:** all of [§2](02-cointegration.md)–[§5](05-risk.md). Every strategy from §2 and §3, every execution model from [§4](04-execution.md), and every risk gate from §5 must be evaluated under the discipline here before it's worth deploying. The multiple-testing problem in [§2.8](02-cointegration.md#28-universe-construction-from-infinite-candidate-pairs-to-a-tractable-book) is what [§6.5](#65-deflated-sharpe-ratio-the-multiple-testing-aware-sharpe)'s DSR formally corrects.
    **Feeds into:** [§7 production](07-production.md) — the shadow-mode loop in [§7.1](07-production.md#71-the-shadow-phase-running-live-without-spending-money) is the live-data extension of §6's discipline, and the [§6.4](#64-calibrating-the-fee-slippage-model-the-audit-loop) calibration loop is what makes [§7.2](07-production.md#72-the-minimum-capital-phase-making-sure-the-friction-is-right)'s min-capital phase converge.
    **Code shape:** [Appendix A.3 — IStrategy](appendix-a-code-shapes.md#a3-istrategy-the-canonical-strategy-interface) (the same interface is used by backtest and live runners — the byte-similarity argument in [§6.2](#62-event-driven-beats-vectorised)); [A.9 — DB-gated integration spec](appendix-a-code-shapes.md#a9-the-db-gated-integration-spec).

## 6.1 Why honest backtesting is hard

The dominant failure mode in quant research is not "the strategy doesn't work." It is "the strategy worked in the backtest and didn't in production, and we don't know which step lied." Honest backtesting is the discipline of making the backtest *predict* live behaviour to within a small tolerance. When the backtest predicts and live confirms, the strategy is real; when it doesn't, the backtest is wrong and re-tuning the strategy will not save it.

A backtest can lie to you in dozens of subtle ways, but three classes of error account for the great majority of backtest-vs-live divergence in practice. Each one has a textbook name and a concrete fix; together they're the load-bearing content of this chapter:

1. **Look-ahead bias.** The backtest computes signals using data that wouldn't have been available at the decision time. The easiest way to introduce it accidentally is to compute a *rolling* statistic using a pandas / numpy operation that secretly centres the window (e.g. `pd.Series.rolling(window=N).mean()` is right-aligned but `pd.Series.rolling(window=N, center=True).mean()` is not — the second one uses future data). Less obvious: training a Z-score normaliser on the entire backtest window before walking through it (the normaliser knows the mean and stdev of data that hasn't happened yet at any given step).
2. **Survivorship bias.** Your universe is the set of assets that existed *and survived* to the day you ran the backtest. Delisted tokens, failed protocols, exit-scammed assets — all absent. Pairs that look cointegrated in your filtered universe might have been the *only* pairs that survived, while their cohort delisted. The historical record literally cannot show you the strategies that died on assets that no longer exist; you have to actively reconstruct the universe as it was *at each historical date*, including assets that subsequently delisted.
3. **Multiple-testing bias.** You tried 1,000 strategy variants, reported the top 3, and didn't disclose the 997 that didn't make it. Even if each individual strategy was tested honestly, the *selection* of which to deploy is itself a hypothesis test, and the deflated Sharpe ratio (§6.5) is the only honest single-number summary that survives multiple-testing correction.

A correct backtest is not the *only* requirement for a profitable strategy, but an incorrect backtest is sufficient to *eliminate* one. Anything that ships to live capital should clear §6.2–§6.5 first.

The good news is that none of these biases is mysterious or hard to fix. The fixes — event-driven execution, purged k-fold cross-validation, calibrated slippage models, deflated Sharpe reporting, sensitivity sweeps, point-in-time universes — are all standard. The bad news is that these fixes are rarely *all* applied at once, and skipping any one of them is enough to invalidate the result. The discipline of this chapter is the discipline of doing every one of them every time.

## 6.2 Event-driven beats vectorised

Vectorised backtests are tempting because they're fast — apply your signal logic across an entire price array in one numpy operation and compute returns. They lie in three ways: (1) they collapse intra-bar fills into a single price, hiding execution risk; (2) they routinely peek at the current bar's close to decide whether to enter, which is look-ahead; (3) they assume the same code path runs in live, which it doesn't — live needs event ordering and partial-fill handling that vectorised code skips.

**Event-driven backtesting** runs the strategy bar-by-bar through the same `IStrategy.onBar(bar, ctx) → Order[]` contract that the live loop uses. The only differences between backtest and live are:

| Component | Backtest source | Live source |
|---|---|---|
| `IBarFeed` | Historical Parquet / DB / CSV | CCXT WebSocket / direct exchange WS |
| `ITradingVenue` | `MockTradingVenue` with deterministic fills | `RealBinanceVenue` (or other) |
| Clock | Replay clock (`new Date(bar.ts)`) | System clock |

If the same `pairs-trading.strategy.ts` is wired into both runners and the backtest's P&L doesn't predict live P&L on the same time window, **the loop is the wrong shape** — not the strategy. The two loops should be logic-identical (same `onBar` calls in the same order against the same `IStrategy` instance) except for the `IBarFeed`, `ITradingVenue`, and clock implementations selected by the factory ([Appendix A.8](appendix-a-code-shapes.md#a8-the-factory-selector)).

```typescript
// backtest/backtest-runner.ts (sketch)
export class BacktestRunner {
  constructor(
    private readonly feed: IBarFeed,
    private readonly strategy: IStrategy,
    private readonly venue: ITradingVenue,
    private readonly risk: RiskLayer,
  ) {}

  async run(): Promise<BacktestReport> {
    const portfolio = new PortfolioState();
    for await (const bar of this.feed.bars()) {
      const desired = this.strategy.onBar(bar, { history: ..., portfolio });
      const vetted = await this.risk.vet(desired, { currentNav: portfolio.nav, ... });
      for (const order of vetted) {
        const result = await this.venue.place(order);
        portfolio.applyFill(result, bar.ts);
      }
    }
    return portfolio.report();
  }
}
```

Same `strategy.onBar` and `risk.vet` calls run in `LiveRunner` (next chapter). The only swap is `feed` and `venue`.

**The byte-similarity argument.** The reason for insisting on identical code in backtest and live isn't an aesthetic preference for clean architecture. It's that any divergence between backtest and live code is a bug-shaped hole through which look-ahead bias can leak in. If your backtest computes the signal one way and your live code computes it another way, the two paths can disagree silently for months before any reconciliation catches it. The fix is to use the same `IStrategy.onBar` instance in both paths, swap only the *feed* and the *venue*, and treat any divergence between backtest and live P&L on the same time window as evidence that the loop is wrong, not evidence that the strategy is decaying.

## 6.3 Purged k-fold cross-validation — worked example

Naïve k-fold CV is wrong on time-series data because the train and test folds are not statistically independent. A trade that opens on day 100 and closes on day 110 spans the k=10 fold boundary at day 105 — if day 100–104 is in the training fold and 105–110 is in the test fold, the model has effectively seen its own label. **MLDP18** (López de Prado, 2018, ch. 7) introduces **purged k-fold CV** to fix this:

1. Define each sample's *label* as the realised forward return over the horizon $h$ bars (e.g. a 5-day forward return).
2. For each test fold, **purge** training samples whose label window overlaps with the test fold. A sample with `t = 100, label_window = [100, 105]` is purged from training if test fold spans day 102.
3. **Embargo** an additional $e$ bars after the test fold from the training set, to prevent leakage from autocorrelated residuals. Typical embargo: 1% of the total sample count.

Pseudocode (close to MLDP18's `PurgedKFold`):

```python
def purged_kfold_indices(n_samples, n_folds, label_horizon, embargo):
    fold_size = n_samples // n_folds
    for k in range(n_folds):
        test_start = k * fold_size
        test_end = test_start + fold_size

        # Test indices
        test = list(range(test_start, test_end))

        # Train = everything except test, plus the purge window
        # Purge: samples whose label window overlaps test fold
        purge_start = max(0, test_start - label_horizon)
        purge_end = test_end + embargo

        train = [i for i in range(n_samples)
                 if i < purge_start or i >= purge_end]

        yield train, test
```

**Worked example.** 1000 daily bars, k=5 folds (200 bars each), label horizon 5 days, embargo 10 days (1% of 1000):

| Fold | Test indices | Purged-out train indices | Train indices |
|---|---|---|---|
| 0 | 0–199 | 0–209 (purge before fold 0 — degenerate) | 210–999 |
| 1 | 200–399 | 195–409 | 0–194, 410–999 |
| 2 | 400–599 | 395–609 | 0–394, 610–999 |
| 3 | 600–799 | 595–809 | 0–594, 810–999 |
| 4 | 800–999 | 795–999 | 0–794 |

The purge window (`label_horizon` before the test) catches the sample-with-overlapping-label case; the embargo (after the test) catches autocorrelated-residual leakage. Both matter and dropping either re-introduces bias.

**The wrong way that looks right.** A common shortcut is "walk-forward" — train on $[0, t]$, test on $[t, t+h]$, advance, repeat. This is *almost* right but has two problems: (1) the earliest data is over-weighted in training (it appears in every fold), and (2) there's no embargo, so the test set's first bar's residual is correlated with the last training bar's residual. Purged k-fold corrects both.

**Why this discipline matters so much for stat arb specifically.** The signals in §2 and §3 are *autocorrelated* by construction — a z-score on a mean-reverting spread persists for many bars; an OU fit on a window depends on overlapping data with the previous window. Naive k-fold CV produces test-set performance that is wildly optimistic on these autocorrelated signals. Purged k-fold is the correction; treat it as the *default* cross-validation method for any stat-arb strategy.

## 6.4 Calibrating the fee / slippage model — the audit loop

[§4.5](04-execution.md#45-the-cost-model-is-what-makes-the-backtest-honest) specified three fidelity levels. Honest backtesting requires you to *calibrate* the level you're using against live data, not pick numbers from a textbook:

1. **Ship the strategy in shadow mode** ([§7.1](07-production.md#71-the-shadow-phase-running-live-without-spending-money)) for two weeks. Log every order the strategy *would* have placed, alongside the bar's mid, top-of-book bid/ask, and the realised fill price (had the order actually been placed).
2. **Compute the realised slippage distribution.** For each shadow order: `realised_slippage_bps = (fill_price - mid) / mid * 10_000`. Take the 50th, 90th, 99th percentiles.
3. **Compare to your backtest's Level-2 model.** If your backtest assumes `baseBps = 5, impactBps = 0.5 * size / ADV * 10_000`, and the realised 90th-percentile slippage is 12 bps while your model predicts 6 bps, your model is half the correct cost. Re-fit.
4. **Re-backtest with the calibrated model.** If the strategy still survives at the new costs, you have signal. If it doesn't, you found a strategy that worked only in your too-optimistic cost model.

The single biggest lift in backtest-vs-live alignment comes from this loop, not from fancier mathematics. Strategies that survive a calibrated Level-2 backtest, on a survivor-corrected universe, with purged k-fold CV passing, are the only ones worth taking past [§7.1](07-production.md#71-the-shadow-phase-running-live-without-spending-money).

A subtle thing about calibration: the slippage *distribution* matters more than the slippage *mean*. A strategy that survives 90th-percentile slippage but dies at 99th-percentile slippage is a strategy that will look fine for months and then have one terrible day. The conservative posture is to calibrate against the 90th or 99th percentile, not the median, especially for strategies whose individual trades are small (and where one bad fill destroys many good ones).

## 6.5 Deflated Sharpe ratio — the multiple-testing-aware Sharpe

Per **Bailey & López de Prado (2014)**, the standard Sharpe ratio is biased upward when computed across many trials and only the best is reported. The **deflated Sharpe ratio (DSR)** is the closed-form correction:

$$ \text{DSR} = \Phi\!\left( \frac{(\widehat{SR} - SR_0) \sqrt{T - 1}}{\sqrt{1 - \widehat{\gamma}_3 \widehat{SR} + (\widehat{\gamma}_4 - 1) / 4 \cdot \widehat{SR}^2}} \right) $$

where:

- $\widehat{SR}$ is the observed Sharpe of the *selected* strategy,
- $SR_0$ is the **expected maximum Sharpe** under the null hypothesis that all $N$ trials have zero true edge,
- $T$ is the number of observations,
- $\widehat{\gamma}_3, \widehat{\gamma}_4$ are the skewness and kurtosis of the strategy's returns,
- $\Phi$ is the standard-normal CDF.

The closed-form for $SR_0$:

$$ SR_0 \approx \sqrt{\text{Var}(\{SR_n\})} \cdot \left( (1 - \gamma)\,\Phi^{-1}\!\left(1 - \frac{1}{N}\right) + \gamma\,\Phi^{-1}\!\left(1 - \frac{1}{N \cdot e}\right) \right) $$

where $\gamma \approx 0.5772$ (Euler-Mascheroni constant), $\text{Var}(\{SR_n\})$ is the *variance of the Sharpe ratios across the trials you ran*, and $N$ is the trial count.

**Interpretation.** DSR is the probability that the observed Sharpe is above $SR_0$ given the trial count, the skewness/kurtosis correction, and the realised observation count. If DSR > 0.95, the observed Sharpe is statistically distinguishable from "the best of $N$ noise strategies" at the 5% level. If DSR < 0.5, the observed Sharpe could plausibly have arisen from luck across the $N$ trials you ran.

**Reporting discipline.** Every strategy that ships should have a DSR computed alongside its raw Sharpe. A strategy with Sharpe 1.8 and DSR 0.93 is a real strategy; the same Sharpe with DSR 0.42 means you ran 200 variants and got lucky. The course's standard reporting block:

```text
Strategy: BTC/ETH cointegration, 5m bars, 12-month backtest
Sharpe (raw):           1.83
Skewness:               -0.41
Kurtosis (excess):       2.7
Trials in study:        47    (parameter grid: k_enter ∈ {1.5, 2.0, 2.5} × window ∈ {30, 60, 90, 120, 180} × ...)
SR_0 (expected best):    0.94
Deflated Sharpe:         0.87  ← 87% probability this Sharpe is non-spurious
Max drawdown (raw):     -7.2%
Max drawdown (95% CI): [-9.1, -5.4]%
```

A Sharpe number with no DSR, no skew/kurt, and no trial count is a marketing number, not a research result.

## 6.6 Survivorship-bias war stories

Three concrete failure cases worth knowing about because they recur in different forms:

1. **The "dead-stocks" equity backtest.** A pairs-trading study on US equities filters its universe to "stocks currently in the S&P 500." The S&P 500 in 2026 is *not* the S&P 500 of 2008 — Lehman, Bear, WaMu, and dozens of others are gone. A pairs strategy that looks great on the 2008–2026 backtest may have been long Lehman and short JPM going into September 2008; the survivor-only universe drops Lehman from the dataset entirely, hiding the catastrophic loss. **Fix:** use a point-in-time universe (CRSP, or a vendor's "as-was" index membership feed).
2. **The "delisted-token" crypto backtest.** A 2023–2026 crypto pairs backtest is run against the current top-200 by liquidity. Tokens that delisted in 2024 (FTX-related, terraform contagion, exchange-removal-list events) are absent from the historical record by default — most CCXT / TradingView feeds will not return data for delisted symbols. Same problem as the equity case but harsher because crypto delistings are more frequent. **Fix:** maintain your own historical-listing-state table; include data for delisted assets in the backtest universe.
3. **The "winning-strategy-only" research file.** A team runs 50 strategies over 6 months and ships the top 3. The other 47 are quietly archived. A year later, someone re-runs the backtest, and the deflated Sharpe calculation assumes $N = 3$ trials, not 50 — because the 47 archive entries were lost. **Fix:** every research run gets a permanent, immutable log of the *full* parameter grid that was searched, even the variants that didn't ship. The DSR calculation depends on it.

## 6.7 Sensitivity-to-defaults — the second pass after the strategy "works"

Every stat-arb strategy in §2 and §3 has hyperparameters that the literature gives as defaults but doesn't justify rigorously: ADF p-value threshold (0.05), z-score entry threshold (2.0), half-life floor (1 bar), refit cadence (weekly), Bertram cost parameter, OU window length, Kelly fraction (0.25). A strategy whose performance depends critically on a specific default value is not a strategy — it's a curve fit to one point.

**Sensitivity sweep.** For each hyperparameter, hold all others fixed and vary the focal one across a defensible range. Plot raw Sharpe vs the parameter value. A *robust* strategy shows a broad maximum — Sharpe is roughly flat across, say, $k_\text{enter} \in [1.5, 2.5]$. A *fragile* strategy shows a sharp peak — Sharpe collapses outside $k_\text{enter} \in [1.95, 2.05]$. Fragile strategies are curve fits; reject them regardless of how high the peak Sharpe is.

**Multi-parameter sensitivity.** Once each parameter has passed its 1D sweep, run a 2D heatmap on the two most consequential pairs (typically $k_\text{enter} \times $ window length, and Kelly fraction × drawdown gate). A robust strategy has a broad plateau across both dimensions. Anything narrower than $\pm 25\%$ of the central value on both axes simultaneously is suspect.

The sensitivity sweep is *cheap* — running each parameter grid is a single afternoon of compute on a modest machine — and it eliminates more bad strategies than any other single check. It belongs in the standard backtest pipeline, run automatically before any human looks at the headline Sharpe.

!!! note "Practitioner note (from RohOnChain archive — both threads)"
    The Markov Hedge Fund Method's walk-forward backtest ([archive](_archive/roan-markov-hedge-fund-method-2026-05-26.md), claim #4 and #10) treats *re-estimation-at-every-step with no lookahead* as the only honest single-number summary, which is exactly the discipline §6.3's purged k-fold formalises. The 50-weak-signals thread ([archive](_archive/roan-fundamental-law-active-mgmt-2026-05-26.md), claim #3) makes the orthogonalisation argument that's the load-bearing step in §6.5's DSR — orthogonalising signals collapses what looks like $N = 50$ independent bets into the (much smaller) *effective* $N$ that the deflated Sharpe assumes. Both threads agree: the raw Sharpe of a multi-signal strategy is the easiest number to fool yourself with, and the orthogonalised / deflated form is the one you should report.

## 6.8 Citations

- **MLDP18**: López de Prado, M. (2018). *Advances in Financial Machine Learning.* Wiley. Chapters 7 (purged k-fold CV) and 8 (feature importance / orthogonalisation).
- **BLP14**: Bailey, D. H., & López de Prado, M. (2014). *The deflated Sharpe ratio: correcting for selection bias, backtest overfitting, and non-normality.* The Journal of Portfolio Management, 40(5), 94–107.
- **Bailey, Borwein, López de Prado & Zhu (2014)**: *Pseudo-mathematics and financial charlatanism: the effects of backtest overfitting on out-of-sample performance.* Notices of the AMS, 61(5), 458–471. — The canonical paper on overfitting in finance.
- **GK99**: Grinold, R., & Kahn, R. (1999). *Active Portfolio Management* (2nd ed.). McGraw-Hill. Chapter 6 — Fundamental Law of Active Management; effective-$N$ argument that underpins §6.5's DSR.
- **CST02**: Clarke, R., de Silva, H., & Thorley, S. (2002). *Portfolio constraints and the fundamental law of active management.* Financial Analysts Journal, 58(5), 48–66. — Transfer coefficient correction.
- **Tier C — RohOnChain archive**: [`_archive/roan-markov-hedge-fund-method-2026-05-26.md`](_archive/roan-markov-hedge-fund-method-2026-05-26.md); [`_archive/roan-fundamental-law-active-mgmt-2026-05-26.md`](_archive/roan-fundamental-law-active-mgmt-2026-05-26.md). Practitioner threads on walk-forward discipline and signal orthogonalisation.

Open-source: `mlfinlab.cross_validation.PurgedKFold` (URL pending verification — see [Appendix B](appendix-b-sources.md)); `statsmodels.stats.multitest.multipletests` for FDR / Bonferroni; the DSR closed-form is in `mlfinlab.backtest_statistics`.
