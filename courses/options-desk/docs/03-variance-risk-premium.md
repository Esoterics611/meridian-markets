# 3 · The variance risk premium — the structural edge

## What it is

Options are systematically priced at a higher volatility than the underlying subsequently realizes. The difference — implied minus realized — is the **variance risk premium (VRP)**, and it is the single structural edge this entire desk is built on: every income book in this course (§4, §5's call leg, §6) is a different container for harvesting it, chosen for its risk shape rather than its signal. This chapter states the premium precisely, proves *why* selling it earns the IV−RV spread (not a metaphor — an identity), shows the evidence including this desk's own measurements, and covers the part almost everyone gets wrong in practice: **measuring realized volatility without fooling yourself**.

## Math sketch

### The decomposition that makes it tradable

Sell an option at implied vol $\sigma_i$ and delta-hedge it continuously. The Black-Scholes P&L of the hedged position over $[0,T]$ is (Carr & Madan 2001; the "fundamental theorem of derivatives trading"):

$$\text{P\&L} = \int_0^T \tfrac{1}{2}\,\Gamma_t S_t^2\,\big(\sigma_i^2 - \sigma_{r,t}^2\big)\,dt$$

Read it term by term: $\Gamma_t S_t^2$ is the position's dollar convexity (always positive for a bought option, so the *sign* of the seller's P&L is the sign of $\sigma_i^2 - \sigma_r^2$); the integrand says the hedged seller earns theta at the implied rate and pays re-hedging losses at the realized rate. **A delta-hedged short option is a pure bet that realized vol comes in below the implied vol you sold.** No direction, no forecast of price — only of the *gap between two volatilities*.

Two honest footnotes to the theorem, both of which become chapters: the P&L is *path-weighted* by $\Gamma S^2$, so where the gamma sits when the market moves matters (dollar-gamma weighting — a quiet month that goes wild exactly ATM in the last week can lose money even if average RV was below IV); and continuous hedging is impossible, so a discrete hedger keeps hedging error on top (§6).

### Definitions and magnitude

The desk quotes the premium in **vol points**: $\text{VRP} = \sigma_i - \sigma_r$ (e.g. IV 37.1 − RV 31.2 = **+5.9 pts**). The academic literature works in variance terms ($\sigma_i^2 - \sigma_r^2$) via variance swaps; same object, different units. Rule of thumb for what a point is worth: from §2's identity, a 1-BTC ATM straddle's vega ≈ $0.8\,S\sqrt{\tau}$ ≈ $\$13{,}700$ per 1.00 of vol at 30d/$60k — so **each vol point of premium ≈ \$137 per straddle-month** if captured cleanly. The #12 snapshot's +5.9 pts is therefore ≈ \$800/month/contract of expected edge before costs — real money against ≈ \$150–300 of round-trip spread and hedge costs, and that ratio (edge ≈ 2–4× cost) is the honest reason the book exists.

### The evidence

**Literature (decades, multiple markets):** Bakshi & Kapadia (2003) — delta-hedged option portfolios systematically lose money for buyers, i.e. earn it for hedged sellers; Carr & Wu (2009) — variance swap strike exceeds realized variance in 18 of 19 markets studied, with the premium concentrated in (and occasionally destroyed by) crises; Eraker (2008) and many since on why: jump risk and crash aversion carry a price.

**This desk (crypto, our own harness — thinner sample, stated):**

- **#12:** BTC ATM IV 37.1 vs RV 31.2 = **+5.9 vol pts**; ETH **+3.7 pts**; measured with the engine whose Greeks were validated against Deribit the same session.
- **#42:** across **117 rolling 24h windows over 30 days**, a long-gamma (bought straddle) position cleared its premium in **16 windows — 13.7%**. The short-vol side won **86.3%** of windows. This was originally filed as "gamma insurance is expensive" — its positive content is this chapter.
- **#96:** in live paper, the VRP gate held the book **out** all night while iv−rv ran −2 to −15 pts — the premium is a *condition*, not a constant, and the desk's discipline (no premium → no position) already behaves correctly in production.

### Measuring realized vol (where practitioners actually go wrong)

The premium is a spread between one observable (IV, quoted) and one **estimate** (RV, constructed). Get the estimator wrong and you will trade phantom premium. Three estimators, in order of increasing desk-worthiness:

1. **Close-to-close:** $\sigma_r^2 = \frac{365}{n}\sum \ln^2(S_t/S_{t-1})$ (mean term dropped — at daily horizons it adds noise, not information). Unbiased, converges slowly, and every point enters/exits the window with a thud.
2. **Range-based (Parkinson):** $\sigma_P^2 = \frac{365}{4n\ln 2}\sum \ln^2(H_t/L_t)$ — ~5× more efficient per observation; ideal for 24/7 crypto candles where H/L are clean.
3. **EWMA:** $\sigma_t^2 = \lambda\,\sigma_{t-1}^2 + (1-\lambda)\,r_t^2$ — no window edges at all; each observation decays smoothly instead of falling off a cliff.

**The lesson this desk paid for (#96):** the v0 VRP book used a rolling-window RV from hourly candles. One stale print rolling *out* of the window moved measured RV from 0.511 to 0.429 **in a single minute** — a 8-vol-point swing with no market event — and the gate, correctly reading its inputs, opened a position on an artifact. The fix (EWMA, or requiring $k$ consecutive gate-open reads) is a pre-condition for every book in this course: **a window-edge artifact is indistinguishable from edge until you look at the estimator, so the estimator gets a spec of its own.** This is what "no theoretical stuff" means in practice — the difference between the theorem above and a live book is exactly these details.

### The gate

Everything reduces to one pre-condition, evaluated per underlying and per tenor:

$$\text{tradeable}(T) \iff \sigma_i(T) - \hat\sigma_{r,\text{EWMA}} \;\ge\; \theta_{\min}(T) \quad (+\text{cost floor})$$

with $\theta_{\min}$ rising in tenor (longer holding = more hedge-error variance = more demanded premium; the Meridian ladder uses 3/4/5 pts at 7/14/30d as design priors, re-set from the desk's own surface tape). When the gate is closed the books sit in cash. The #42 fat tail is not avoided by forecasting it — it is avoided *mostly* by not being short vol when there's no premium, and *finally* by the sizing budget (§11).

## When it works / when it breaks

**Works:** most of the time, by measurement (86.3% of #42's windows; 18/19 markets in Carr-Wu) — and *best* immediately after vol spikes, when panic-bid IV overshoots the realized vol that actually follows. The premium is fattest exactly when it feels worst to sell — a psychological moat that is part of why it persists.

**Breaks:** the 13.7%. The premium doesn't erode — it **inverts violently**: realized explodes past implied in hours (a cascade, a depeg, a weekend gap) and the delta-hedged seller loses at the rate $\tfrac{1}{2}\Gamma S^2(\sigma_r^2-\sigma_i^2)$ with $\Gamma$ largest exactly where the market now is. Carr-Wu's crisis windows gave back years of premium in the same markets that reliably earned it. The response is never a better forecast; it is the loss stop, the vega budget, and the tail overlay (§9) — sizing so the inversion is an expected, budgeted, boring event. One more crypto-specific honesty note: crypto RV is itself fat-tailed and regime-switching harder than equity RV, so the #42-style window fraction must be re-measured per regime (the desk's surface tape, §13) rather than trusted as a constant.

## Code shape

```typescript
/** EWMA realized-vol estimator — the #96 fix. One instance per underlying; fed per bar. */
export class EwmaRv {
  private variance: number | undefined;                 // annualized variance state
  constructor(private readonly lambda = 0.94,           // RiskMetrics daily; tune per bar interval
              private readonly barsPerYear = 365 * 24) {}
  update(logReturn: number): number {
    const r2 = logReturn * logReturn * this.barsPerYear; // annualize the single-bar variance
    this.variance = this.variance === undefined ? r2 : this.lambda * this.variance + (1 - this.lambda) * r2;
    return Math.sqrt(this.variance);
  }
  get rv(): number | undefined { return this.variance === undefined ? undefined : Math.sqrt(this.variance); }
}

/** The VRP gate: one boolean, no discretion. thresholdPts rises with tenor. */
export function vrpGateOpen(markIv: number, ewmaRv: number, thresholdPts: number, halfSpreadPts: number): boolean {
  return markIv - ewmaRv >= thresholdPts + halfSpreadPts;   // premium must clear the demanded edge AND the cost of entry
}
```

The live v0 of this gate is `src/derivatives/vrp/vrp-book.ts` (`minVrpPts`, default 3 pts) — the book this whole course grows into a desk in §13.

## Sources

- Bakshi & Kapadia (2003), "Delta-Hedged Gains and the Negative Market Volatility Risk Premium."
- Carr & Wu (2009), "Variance Risk Premia" — the 18-of-19-markets result and the crisis givebacks.
- Carr & Madan (2001), "Towards a Theory of Volatility Trading" — the P&L decomposition.
- Sinclair, *Volatility Trading* ch. 2–3 — the practitioner's treatment of RV estimators (close-close, Parkinson, Yang-Zhang) and their efficiency.
- Meridian journal #12 (the measurement), #42 (the window distribution), #96 (the estimator artifact + the live gate behaving honestly).
