# 8 · Skew — the smile as a tradable object

## What it is

Black-Scholes says one vol prices every strike. The market disagrees: plot implied vol against strike and you get the **smile** — in equities a persistent smirk (OTM puts always richer than OTM calls, ever since October 1987 taught index option sellers what a gap is), in crypto something stranger and more useful: **a skew that changes sign**. BTC puts trade rich in fear regimes and BTC *calls* trade rich in FOMO regimes — retail pays up for lottery-ticket upside in a way index markets never do. A premium that oscillates around zero is a mean-reversion trader's object: this chapter builds the desk's skew-harvest book — selling the temporarily-rich wing through **defined-risk credit verticals** — and the skew *inputs* that two earlier books (§4's entry condition, §5's strike governance) already consume.

## Math sketch

### Measuring skew at trading resolution

Academic smile models (SVI, SABR) fit whole surfaces; a trading desk needs two numbers per tenor, quoted the way the market quotes them:

$$\text{RR}_{25} = \sigma(25\Delta\,\text{put}) - \sigma(25\Delta\,\text{call}) \qquad\text{(the risk reversal: skew's direction and size)}$$

$$\text{BF}_{25} = \tfrac{1}{2}\big[\sigma(25\Delta\,\text{put}) + \sigma(25\Delta\,\text{call})\big] - \sigma_{\text{ATM}} \qquad\text{(the butterfly: how fat both wings are)}$$

Equity index RR₂₅ is reliably positive (puts rich) and has been for nearly four decades. Crypto RR₂₅ **crosses zero routinely** — deep negative in parabolic rallies (calls bid), sharply positive in cascades. That sign instability is the whole trade: a premium that is *always* positive gets priced as compensation (hard to harvest); a premium that *oscillates* is at least partly sentiment flow, and sentiment flow mean-reverts.

Why any skew exists at all, in one line each: crash risk is real (the underlying's returns are negatively skewed, so the put wing *should* be richer — some of RR is fair); hedging flow is one-directional (structural put demand from §1's hedgers); and in crypto, leverage-seeking retail buys calls the way equity institutions buy puts — producing the sign flips.

### The trade: sell the rich wing, defined-risk only

The naive skew trade is the naked risk reversal (sell the rich 25Δ put, buy the cheap 25Δ call). This desk doesn't run it: a naked short put is a tail position (§4 accepts that only cash-secured, as an inventory mechanism), and a skew *signal* does not deserve tail *risk*. The desk's container is the **credit vertical on the rich wing**:

- Puts rich (RR z ≥ +2): **sell the 25Δ put, buy the 10Δ put**, same tenor. Collect credit $c$; max loss = $(K_{25} - K_{10}) - c$, fixed at fill time.
- Calls rich (RR z ≤ −2): the mirror call spread.

The arithmetic that governs it: the spread is priced by the *difference* of two implied vols, so it is a nearly pure skew position with a bounded worst case. Expected value per signal $\approx p \cdot c - (1-p)(W - c)$ where $W$ is the width — with the honest note that $p$ (probability the spread expires worthless / is closed at target) must come from the scored record, not from lognormal deltas, precisely because the smile exists (the market already told you the tails aren't lognormal; using BS deltas as probabilities on the very wing you're trading is circular). Entry at credit ≥ ⅓ of width is the desk's design prior — it puts breakeven $p$ at ⅔, comfortably below the historical worthless-expiry rate of far-OTM spreads — re-set from the tape like every prior.

### The trigger, same discipline as §7

$z$-score of RR₂₅ against its own 90-day rolling distribution from the surface tape; enter at $|z| \ge 2$, exit at 50% of credit or $|z| \le 0.5$, expiry allowed (defined risk means expiry is a plan, not an emergency). The signal and both earlier consumers of it — §4's "sell puts only when the put wing pays" and §5's "sell the call leg the expensive strike when calls are FOMO-bid" — read the *same* tape rows, which is the quiet architectural point: **one measured surface, many books.**

## When it works / when it breaks

**Works:** sentiment extremes with no event attached — the funding-rate-mania top where 25Δ calls trade 6 pts over puts (sell the call spread into euphoria), the post-cascade morning where puts trade 12 pts over (sell the put spread into the hangover). The mean-reversion evidence in equities (skew harvesting via put-spread selling) is decent; in crypto the desk treats it as *plausible pending tape* — Phase O-3 measures the RR distribution's half-life before the first trade, and if RR shocks don't decay within the position's tenor, the book never launches.

**Breaks:** **skew is sometimes right.** Rich puts precede real crashes often enough that "fade the fear" has a body count; the cascade that follows leaves the put spread at max loss. Three things keep that survivable rather than fatal: max loss is a *number chosen at entry* (the width is the sleeve's unit of risk, and the sleeve cap is in max-loss terms, not premium terms); the spread's loss is capped **regardless of how far spot falls** — the 10Δ long leg is the difference between a bad month and §1's graveyard; and the signal's asymmetric failure mode is pre-registered: fading rich *calls* (euphoria) has historically been safer than fading rich *puts* (fear), so the book is permitted to run call-side-only if the scored record splits that way. Residual honest costs: two-legged entries pay two spreads on wings where quotes are widest (the cost model charges the tape's numbers), and pin risk between the strikes at expiry is real (close by 2 DTE unless > 80% of credit is earned).

## Code shape

```typescript
export interface SkewSignal {
  underlying: 'BTC' | 'ETH';
  tenorDays: 14 | 30;
  rr25: number;                 // put25Iv − call25Iv, vol pts (fraction)
  rrZ: number;                  // vs its own rolling 90d distribution — from the tape, like §7
  richWing: 'PUT' | 'CALL' | null;   // null when |z| < entry threshold
}

export interface CreditVertical {
  wing: 'PUT' | 'CALL';
  shortLeg: OptionSpec;         // the 25Δ — the rich vol being sold
  longLeg: OptionSpec;          // the 10Δ — the wing that bounds the world
  creditUsd: number;
  maxLossUsd: number;           // (width − credit) × qty: fixed at fill, THE sleeve's risk unit
}

/** Sleeve capacity is consumed in max-loss terms — premium collected is irrelevant to risk. */
export function sleeveHasRoom(open: CreditVertical[], candidate: CreditVertical, sleeveUsd: number): boolean {
  const committed = open.reduce((a, v) => a + v.maxLossUsd, 0);
  return committed + candidate.maxLossUsd <= sleeveUsd;
}
```

## Sources

- Rubinstein (1994), "Implied Binomial Trees" — the post-1987 birth of the equity smirk as an object of study.
- Derman (1999), "Regimes of Volatility"; Gatheral, *The Volatility Surface* — how smiles move and what they imply.
- Mixon (2011), "What Does Implied Volatility Skew Measure?" — skew as sentiment/flow vs fair crash compensation.
- Bennett, *Trading Volatility* — risk-reversal and vertical-spread mechanics, wing liquidity realities.
- Meridian: `docs/OPTIONS_DESK.md` §2-O5 (the book spec and its max-loss sleeve accounting); the surface tape (O-E1) that carries `put25dIv/put10dIv/call25dIv` for this chapter's signals.
