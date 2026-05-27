# 5. Risk, sizing, circuit breakers

!!! abstract "Where this chapter fits"
    **Feeds in from:** [§2 cointegration](02-cointegration.md) and [§3 OU process](03-ou-process.md) (the strategies whose orders this chapter sizes and gates); [§2.8](02-cointegration.md#28-universe-construction-from-infinite-candidate-pairs-to-a-tractable-book) (the effective-$N$ argument feeds directly into [§5.2](#52-per-strategy-fractional-kelly-with-shrinkage)'s Kelly framing).
    **Feeds into:** [§4 execution](04-execution.md) (orders only reach the execution router after the risk layer accepts them; the wiring is in [§5.7](#57-code-shape-how-risk-wires-in)); [§6.5](06-backtesting.md#65-deflated-sharpe-ratio-the-multiple-testing-aware-sharpe) (the DSR is the multiple-testing-aware sizing input that complements the Kelly framing here); [§7.3](07-production.md#73-the-capital-ramp-curve-concrete-dollar-amounts) (capital-ramp gates are operational expressions of the same drawdown and venue-cap discipline).
    **Code shape:** [Appendix A.6 — risk-layer pipeline](appendix-a-code-shapes.md#a6-the-risk-layer-pipeline).

## 5.1 The three risk layers

Risk isn't a single check. It's three nested layers, each catching a different failure mode:

```mermaid
flowchart TB
  P[Per-strategy sizing<br/>Kelly + shrinkage] --> V[Per-venue caps<br/>notional ceiling]
  V --> PT[Portfolio-level<br/>VaR + drawdown gate]
  PT --> CB[Circuit breakers<br/>kill switches]
```

- **Per-strategy** sizes individual bets so no one trade ruins the strategy.
- **Per-venue** caps total exposure to any single venue so no one venue ruins the book.
- **Portfolio-level** caps total exposure so no one bad day ruins the desk.
- **Circuit breakers** are the panic-stop when something the model didn't see is happening.

Each layer must be tight enough that the next one rarely fires. If your portfolio drawdown gate is tripping daily, your per-strategy Kelly is wrong.

## 5.2 Per-strategy: fractional Kelly with shrinkage

The full-Kelly fraction for a single bet is:

$$ f^* = \frac{\mu - r_f}{\sigma^2} $$

where $\mu$ is expected return, $r_f$ is the risk-free rate, $\sigma$ is the standard deviation of returns. Mathematically optimal for **growth** — but assumes you know $\mu$ exactly. You don't.

**Shrinkage:** Take a fraction of Kelly (typically $0.25 \cdot f^*$, sometimes called "quarter-Kelly"). Justification:

- Your backtest's $\mu$ is upward-biased (survivorship + selection).
- The full-Kelly drawdown is brutal — in expectation, half the strategy lifetime is spent at $<$ 50% of peak NAV.
- Quarter-Kelly gives up ~25% of growth in exchange for far smoother equity.

```typescript
// risk/kelly.ts
export function fractionalKelly(
  expectedReturn: number,
  variance: number,
  riskFreeRate: number,
  fraction = 0.25,
): number {
  const fullKelly = (expectedReturn - riskFreeRate) / variance;
  return fraction * fullKelly;
}
```

**Empirical $\mu$ and $\sigma$ from backtest.** Use a robust estimator: trimmed mean over the in-sample window, or a Bayesian shrinkage estimator if you have a prior. **Don't use the raw backtest mean** — it embeds the survivorship of the strategy you chose to deploy.

!!! note "Practitioner note (from RohOnChain archive — Fundamental Law thread)"
    Roan's "50 weak signals" thread ([archive](_archive/roan-fundamental-law-active-mgmt-2026-05-26.md), claim #5) offers a sharper functional form for the Kelly shrinkage:

    $$ f_{\text{empirical}} = f_{\text{Kelly}} \cdot (1 - \text{CV}_{\text{edge}}) $$

    where $\text{CV}_{\text{edge}}$ is the coefficient of variation of the *edge estimate itself* — i.e. how uncertain you are about your IC. When your edge estimate is precise (low CV), shrinkage is light; when the estimate is noisy (high CV), shrinkage is aggressive. This is sharper than the generic 0.25 multiplier because it adapts to the actual standard error of your IC measurement. The generic Tier-A version (Thorp 2006 on fractional Kelly) gives "use 0.25 of full Kelly because you don't really know μ" as an aphorism; the practitioner version operationalises it.

    **Course default stays at 0.25** because measuring $\text{CV}_{\text{edge}}$ reliably is hard in the small-sample regime that Phase 3 will start in. The CV-shrinkage form becomes the upgrade path once a strategy has 6+ months of live data with statistically-meaningful per-trade edge measurements.

## 5.3 Per-venue caps

A single number per venue:

$$ \text{cap}_v = \min(\text{absoluteCap}, k \cdot \text{venueDailyVolume}_v) $$

with $k$ typically 1–2%. Rationale: even at 2% of daily volume your impact is felt; above that your fills will be statistically worse than backtest assumes. Caps are a hard floor — strategies that try to size above the cap have their orders truncated, not rejected, with an alert.

Venue ordering for solvency risk (consistent with [PHASED_PLAN.md §Phase 1](../../../PHASED_PLAN.md)):

| Venue | Solvency tier | Notes |
|---|---|---|
| Top-3 CEX (Binance, OKX, Bybit) | A | Largest, well-capitalised, but not zero-risk (cf. FTX) |
| Hyperliquid | A− | Highest TVL among perps DEXs; fully on-chain |
| Coinbase, Kraken | A | Smaller liquidity but US-regulated |
| Drift | B | Smaller perp DEX |
| GMX | B− | Smaller, design has historical exploit surface |
| Anywhere else | C+ | Cap aggressively |

These are tiers, not blacklists. Even Tier-A venues should not hold more than ~30% of working capital.

!!! note "Practitioner note (from RohOnChain archive — Markov Hedge Fund Method)"
    Roan's framework ([archive](_archive/roan-markov-hedge-fund-method-2026-05-26.md), claim #3) suggests a second per-asset filter that's orthogonal to the venue-cap above: the asset's **long-run stationary regime distribution**. If a fitted Markov model's stationary distribution gives that asset a Bear-share above some threshold (e.g. $\pi_{\text{Bear}} > 0.40$), the asset is structurally tail-heavy and should be sized down regardless of which venue you hold it on:

    ```python
    bear_baseline = stationary_distribution['bear']
    size_multiplier = max(0, 1.0 - bear_baseline)   # heavier-bear baseline → smaller bets
    ```

    The hard variant — `if bear_baseline > 0.40: size = 0` — is a "this asset is too tail-heavy to trade" kill. Maps to Hamilton (1989) on unconditional regime probabilities; the *operationalisation as a sizing input* is the practitioner contribution.

## 5.4 Portfolio-level: VaR & drawdown gate

**VaR (Value at Risk).** "With 95% / 99% confidence, daily loss won't exceed X." Compute two ways and take the worse:

1. **Historical VaR:** $\text{P\&L}_t$ over the last $N$ days; take the 5th / 1st percentile.
2. **Parametric VaR:** assume normal returns; $\text{VaR}_{95} = 1.65 \cdot \sigma_{\text{daily}}$, $\text{VaR}_{99} = 2.33 \cdot \sigma_{\text{daily}}$. Underestimates fat tails; that's why you take the worse of the two.

VaR is **monitoring**, not a hard limit. Cap exposure to keep VaR under a budget you've decided (e.g. 1% of NAV at 99%).

**Drawdown gate.** A hard limit. If the portfolio is down N% peak-to-trough (intraday or rolling), trading stops. New entries blocked; open positions closed (or held at operator discretion). N typically 3–5%.

```typescript
// risk/drawdown-gate.ts
export class DrawdownGate {
  private peakNav = 0n;
  constructor(private readonly maxDrawdownBps: bigint) {}

  check(currentNav: bigint): boolean {
    if (currentNav > this.peakNav) this.peakNav = currentNav;
    const drawdown = ((this.peakNav - currentNav) * 10_000n) / this.peakNav;
    return drawdown <= this.maxDrawdownBps;
  }
}
```

**Critically: the gate's state lives in the DB, not memory.** A process restart that resets `peakNav` to zero would silently disable the gate. Persist on every NAV update.

## 5.5 Circuit breakers

Specific events that bypass the normal risk machinery. Mirror the circuit-breaker list from [PHASED_PLAN.md §Phase 1](../../../PHASED_PLAN.md) and [PHASE_1_PROMPT.md](../../../prompts/PHASE_1_PROMPT.md):

| Gate | Trips on | Effect | Reset |
|---|---|---|---|
| Funding spike | Funding rate > 100 bps | Close affected venue positions; pause new opens on that venue | Manual after funding normalises |
| Venue health | `fetchHealth().healthy === false` | Pause all activity on the venue | Manual after venue self-clears |
| Data staleness | Feed quiet > 30s (live) | Pause strategies depending on that feed | Auto when feed resumes |
| Cointegration decay | Pair's ADF $p > 0.10$ for 2 days ([§2.9](02-cointegration.md#29-spread-staleness-diagnostics-knowing-when-a-cointegrated-pair-has-broken)) | Close the pair | Pair re-passes the test |
| OU $\theta$ floor | Fitted $\theta < \theta_{\min}$ ([§3.6](03-ou-process.md#36-reading-the-ou-fit-diagnostics-in-practice)) | Close OU positions on that spread; pause new entries | $\theta$ recovers above floor on next refit |
| Drawdown | Portfolio drawdown > 5% | Stop everything | Manual after operator review |

**Reset discipline.** Auto-resets are tempting and dangerous. The default for "soft" gates (data staleness) can be auto. For "hard" gates (drawdown, venue health) require an operator action. The cost of a false-positive reset is much higher than the cost of a few minutes of paused trading.

## 5.6 The kill switch

A single function — operator-callable — that:

1. Cancels all open orders across all venues.
2. Closes all positions at market.
3. Writes a `KILL_SWITCH` movement to `prop_movements` for the audit trail.
4. Sets a persistent "halted" flag that blocks all subsequent strategy invocations until cleared.

This exists separately from the circuit breakers. Circuit breakers are automated; the kill switch is the human override. They should never be needed; they will be.

## 5.7 Code shape — how risk wires in

The strategy never holds the keys to risk. Strategy emits desired orders; risk layer transforms them.

```mermaid
flowchart LR
  S[Strategy.onBar<br/>emits desiredOrders] --> R1[Per-strategy sizer<br/>scales to Kelly fraction]
  R1 --> R2[Per-venue cap<br/>truncates if oversize]
  R2 --> R3[Portfolio gate<br/>blocks if drawdown / VaR]
  R3 --> CB{Circuit breaker<br/>tripped?}
  CB -- Yes --> X[Reject. Log.]
  CB -- No --> EX[Execution router]
```

```typescript
export class RiskLayer {
  async vet(orders: Order[], ctx: RiskContext): Promise<Order[]> {
    if (this.killSwitch.isHalted()) return [];
    if (!this.drawdownGate.check(ctx.currentNav)) return [];
    if (!this.circuitBreaker.allows(ctx)) return [];
    return orders
      .map((o) => this.sizer.scale(o, ctx))
      .map((o) => this.venueCap.cap(o, ctx))
      .filter((o) => o.sizeUnits > 0n);
  }
}
```

Each step is independently testable. Each rejection is logged. Risk does not silently swallow orders without recording why.

## 5.8 Citations

- **Kelly, J. L. (1956).** *A new interpretation of information rate.* Bell System Technical Journal, 35, 917–926. Original Kelly.
- **Thorp, E. O. (2006).** *The Kelly criterion in blackjack, sports betting, and the stock market.* In *Handbook of Asset and Liability Management*. The shrinkage argument.
- **MacLean, L. C., Thorp, E. O., & Ziemba, W. T. (Eds.) (2011).** *The Kelly Capital Growth Investment Criterion.* World Scientific. Comprehensive.
- VaR methodology: **Jorion, P. (2006).** *Value at Risk: The New Benchmark for Managing Financial Risk* (3rd ed.). McGraw-Hill.
- **GK99**: Grinold, R., & Kahn, R. (1999). *Active Portfolio Management* (2nd ed.). McGraw-Hill. Chapter 6 — the Fundamental Law of Active Management that underpins the §5.2 Practitioner-note Kelly-with-edge-uncertainty form.
- **H89**: Hamilton, J. D. (1989). *A new approach to the economic analysis of nonstationary time series and the business cycle.* Econometrica, 57(2), 357–384. — Stationary-distribution-as-sizing-input rationale for the §5.3 Practitioner-note callout.
- **Tier C — RohOnChain archive**: [`_archive/roan-markov-hedge-fund-method-2026-05-26.md`](_archive/roan-markov-hedge-fund-method-2026-05-26.md); [`_archive/roan-fundamental-law-active-mgmt-2026-05-26.md`](_archive/roan-fundamental-law-active-mgmt-2026-05-26.md). Practitioner sources for the two callouts in §5.2 and §5.3.
- The drawdown gate and kill switch are operational practice; no canonical citation. The argument for persisting their state across restarts is from incident write-ups across multiple desks (no single citable source).
