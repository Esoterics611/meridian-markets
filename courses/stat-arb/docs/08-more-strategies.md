# 8. More strategies — baskets & funding carry

!!! abstract "Where this sits"
    [§1.3](01-introduction.md#13-the-four-families-well-cover) promised **four
    families**. §2 and §3 shipped the foundational two (cointegration pairs,
    OU mean-reversion). This chapter is the other two — **cross-sectional /
    basket mean-reversion** and **funding-carry / basis** — written as the
    variations they are. Both reuse the §4 execution layer, §5 risk layer, and
    §6 backtest harness without modification; only the *signal* changes.

## 8.1 Pairs is a special case

A pair is a two-asset basket with weights `(1, -β)`. Everything in §2 generalises:
the spread becomes a weighted sum of log-prices, the z-score normalises that
sum, and entry/exit thresholds work identically. Once you see a pair as the
$N=2$ case, the families below are not new machinery — they are the same
mean-reversion skeleton with a different way of *choosing the basket* and a
different *source of the edge*.

The discipline does not change. Everything you learned about the multiple-testing
trap ([§2.8](02-cointegration.md#28-universe-construction--from-infinite-candidate-pairs-to-a-tractable-book)),
honest backtesting ([§6](06-backtesting.md)), and the shadow phase
([§7](07-production.md)) applies unchanged. A more elaborate signal does not buy
you any forgiveness on validation — if anything it costs you more, because more
free parameters means a larger deflation of your Sharpe ([§6.5](06-backtesting.md)).

## 8.2 Cross-sectional / basket mean-reversion

**The idea.** Instead of one cointegrated pair, take a *cluster* of assets that
share a common factor (all L1s, all DeFi governance tokens) and trade the
dispersion: short the ones that ran up relative to the cluster mean, long the
ones that lagged, and collect the convergence. The "spread" is each asset's
residual against the cluster's common movement.

**Forming the basket.** This is exactly what the engine's discovery layer does
(`discovery/clustering.ts`):

1. Build the $N\times N$ correlation matrix of log-returns.
2. Convert to a distance $d = 1 - |\rho|$ (anti-correlated assets are the *same*
   factor with a flipped leg — see the binding note in the discovery module).
3. Single-linkage agglomerative clustering with a flat cut groups co-moving assets.
4. Within a cluster, the residual of each asset against the cluster's first
   principal component (or simply the equal-weight mean) is the mean-reverting
   series you z-score.

**The signal, as a `PureSignal` ([Appendix A.2](appendix-a-code-shapes.md#a2-pure-signal-functions)):**

```ts
// signal/cross-sectional.ts (shape)
export function crossSectionalResiduals(
  logPrices: Map<string, number[]>,   // symbol -> aligned log-price series
  lookback: number,
): Map<string, number> {              // symbol -> current z of its residual
  // 1. demean each series over `lookback`
  // 2. compute the cluster mean path (equal-weight or PC1)
  // 3. residual_i = logPrice_i - beta_i * clusterMean
  // 4. z_i = (residual_i.last - mean(residual_i)) / std(residual_i)
}
```

**Entry/exit.** Identical to [§2.5](02-cointegration.md#25-z-score-entryexit): enter the
legs whose $|z|$ exceeds the threshold, size by the inverse of residual variance,
exit on convergence to $|z| < z_{\text{exit}}$. The book is dollar-neutral by
construction (longs fund shorts).

**A worked dispersion example.** Take a 4-asset L1 cluster and suppose over the
lookback the cluster mean log-return is **+5.0%**. The individual log-returns and
their residuals (asset − cluster mean, assuming $\beta_i \approx 1$) come out:

| Asset | Log-return | Residual vs cluster | Residual z | Action |
|---|---:|---:|---:|---|
| SOL  | +9.0% | +4.0% | **+2.3** | **short** (ran up, expect convergence down) |
| AVAX | +5.2% | +0.2% | +0.1 | flat (in line) |
| NEAR | +4.6% | −0.4% | −0.2 | flat |
| ATOM | +1.2% | −3.8% | **−2.1** | **long** (lagged, expect convergence up) |

You short SOL and long ATOM in dollar-neutral size; the trade is *agnostic to the
cluster's direction* — if all four rally another 10%, you make money on SOL
falling back toward the mean and ATOM rising toward it, regardless of the
common move. That common-factor cancellation is the whole point: you are trading
the **residual**, not the level. The position closes leg-by-leg as each $|z|$
decays below $z_{\text{exit}}$.

**Why it's worth the complexity.** A basket diversifies the idiosyncratic blow-up
risk of a single pair — one leg getting acquired or exit-scamming hurts less when
it's 1 of 8 names. The cost is more parameters (cluster cut threshold, residual
lookback, per-leg sizing) and therefore a larger multiple-testing correction.

!!! warning "Cluster instability is the failure mode"
    Clusters re-form as correlations drift. A basket that was dollar-neutral last
    month can become net-long a factor this month. Re-cluster on a rolling window
    and treat a membership change as a position-reset event, not a silent
    re-weight. The [§5](05-risk.md) exposure caps are what catch a basket that has
    quietly drifted net-directional.

## 8.3 Testing baskets today

The engine already clusters real Binance universes (§9.4). You can *see* the
baskets the discovery layer forms:

```bash
curl -s 'localhost:3100/api/market-data/universe?presetId=l1-smart-contract&hours=72' \
  | jq '.discoveredClusters'
```

What is **not** yet wired is a `CrossSectionalStrategy` that trades all legs of a
cluster simultaneously — today the live loop trades one pair at a time. Trading
the representative pair of each cluster ([§2.8](02-cointegration.md#28-universe-construction--from-infinite-candidate-pairs-to-a-tractable-book)'s
de-duplication) is the supported approximation; the full multi-leg basket strategy
is the next build (see §8.5).

## 8.4 Funding carry: the perp basis trade

**The idea.** A perpetual future's funding rate is the periodic payment between
longs and shorts that tethers the perp to spot. When funding is **positive**,
longs pay shorts: you can be **short the perp / long the spot**, delta-neutral,
and *collect* funding while carrying no directional risk. When funding flips
negative, reverse. The edge is not mean reversion of a price spread — it is a
*carry* harvested from a structural payment.

**The signal.** Not a z-score of price — a function of the funding rate term:

```ts
// signal/funding-carry.ts (shape — skeleton, see gap note below)
export function fundingCarrySignal(
  fundingRateBps: number,          // current perp funding, basis points / interval
  thresholdBps: number,            // ignore noise below this
): 'SHORT_PERP_LONG_SPOT' | 'LONG_PERP_SHORT_SPOT' | 'FLAT' {
  if (fundingRateBps >  thresholdBps) return 'SHORT_PERP_LONG_SPOT'; // collect funding
  if (fundingRateBps < -thresholdBps) return 'LONG_PERP_SHORT_SPOT';
  return 'FLAT';
}
```

**Why it composes.** The *position* is two legs (perp + spot), so it routes through
the same execution layer (§4) and the same dollar-neutral risk checks (§5). The
*exit* is a regime flip: when funding crosses zero (or the half-life of the funding
regime elapses), unwind. The backtest harness (§6) runs it unchanged — the only
new input is a funding-rate series alongside the price series.

**A worked carry example.** Binance pays funding every 8 hours (3× per day).
Suppose BTC-perp funding is **+0.01%** per interval — a typical mildly-bullish
tape. You hold **$100,000** short-perp / long-spot, delta-neutral:

- Per interval: $100{,}000 \times 0.0001 = \$10$ collected.
- Per day: $3 \times \$10 = \$30$. Annualised (ignoring compounding):
  $0.01\% \times 3 \times 365 = \textbf{10.95\%}$ on the notional — pure carry,
  no directional exposure, as long as the hedge holds.

Now the **steamroller**: the perp and spot legs are on the same asset but can
diverge intraday (the basis). If the basis gaps **0.3%** against you while you
hold, that is a $100{,}000 \times 0.003 = \$300$ mark-to-market hit — **ten days
of carry gone in one print.** This is why §8.4's sizing rule is "size by the
worst-case basis gap, not the funding rate": a 10.95% annualised carry is
irrelevant if a single basis dislocation can erase a fortnight of it. The
[§5](05-risk.md) Kelly fraction must be computed on the *full* P&L distribution
(carry minus basis-gap tail), which is heavily left-skewed — never on the modal
"+$10 per interval" that the funding rate alone suggests.

**The risk that bites.** Funding carry is "picking up pennies in front of a
steamroller": the carry is small and steady, but a sharp spot move while you hold
the basis can blow through the funding you collected. Size it by the *worst-case
basis gap*, not by the funding rate.

### Gap: this is a skeleton in the repo

The data layer exists — `funding_rates` (`venue, symbol, ts, rate_micros`) with a
`MarketDataRepository.insertFunding()` writer — but there is **no funding ingest
job and no `FundingCarryStrategy` wired into the live loop yet**. Building it is a
well-scoped next session: a funding-rate `IFundingSource` seam (real Binance
funding endpoint vs mock, mirroring the `IBarFeed` pattern in
[Appendix A.1](appendix-a-code-shapes.md#a1-the-swap-seam-pattern-interface--mock-default--dormant-real)),
the pure signal above with specs, and registration behind the existing
`ITradingVenue`. See [§9.9](09-testing-in-meridian.md#99-honest-gaps-what-this-repo-does-not-yet-test).

## 8.5 Strategy vs. variation — and a multi-strategy desk

The four families are *signals*; the desk that runs them is one capital pool. The
honest framing from [§1.3](01-introduction.md#13-the-four-families-well-cover):
once `onBar()` and the execution/risk/backtest layers are fixed, a "new strategy"
is a new pure signal plus a registry entry. The natural next step — a
**strategy registry + budget allocator** that runs pairs, baskets, and funding
carry concurrently on shared capital with per-strategy P&L attribution — is the
multi-strategy generalisation of the single-pair live loop. It is deferred, but
the seams ([Appendix A.3](appendix-a-code-shapes.md#a3-istrategy-the-canonical-strategy-interface),
A.8) are already shaped for it.

## 8.6 Where to go next

- **Baskets:** Avellaneda & Lee, *Statistical Arbitrage in the US Equities Market*
  (2010) — the canonical PCA-residual cross-sectional construction.
- **Funding carry:** any perp exchange's funding-mechanism docs; the trade is
  mechanical, the edge is in sizing against the basis-gap tail.
- **Validation:** re-read [§6.5](06-backtesting.md) before believing any of these.
  More parameters → larger deflation. The skeletons are real; the edge is the
  discipline around them.
