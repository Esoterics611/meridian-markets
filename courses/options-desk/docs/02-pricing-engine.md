# 2 · The pricing engine — Black-Scholes, Greeks, inverse options

## What it is

Before a desk can trade options it needs a machine that answers, for any contract at any moment: *what is this worth, and how does that value move?* The answers are a price and five partial derivatives — the Greeks — and for European options on a liquid underlying the machine is Black-Scholes. This chapter is the minimum working theory, the conventions that actually bite in practice, and the two crypto-specific wrinkles (inverse settlement, no financing rate) that the textbooks skip. Everything here is implemented and **validated line-by-line against Deribit's own Greeks** in the Meridian engine (`src/derivatives/greeks/black-scholes.ts`, journal #12) — this is the one chapter of the course where the code is *known correct against the venue*.

## Math sketch

### The contract and the model

A European call (put) pays $\max(S_T - K, 0)$ ($\max(K - S_T, 0)$) at expiry $T$. Under the Black-Scholes assumptions — geometric Brownian motion with constant vol $\sigma$, continuous frictionless hedging, constant rate $r$ — the value is:

$$C = S\,N(d_1) - K e^{-r\tau} N(d_2), \qquad P = K e^{-r\tau} N(-d_2) - S\,N(-d_1)$$

$$d_1 = \frac{\ln(S/K) + (r + \tfrac{1}{2}\sigma^2)\tau}{\sigma\sqrt{\tau}}, \qquad d_2 = d_1 - \sigma\sqrt{\tau}$$

with $\tau$ the year-fraction to expiry. Deribit BTC/ETH options are **European**, so this formula — not an American-exercise tree — is the correct model, exactly.

Every assumption in that list is false in the world (vol is not constant → §8; hedging is not continuous → §6; the underlying gaps → §3, §9). The model survives anyway because the market uses it *as a quoting convention*: nobody believes constant vol, everybody quotes the $\sigma$ that makes the formula match the price. That number is **implied volatility**, and it is the market's actual language — prices are noisy in dollars and comparable in vol points.

### The Greeks (with this desk's conventions)

Conventions vary by venue and library; these are the engine's (documented at the top of `option-pricer.interface.ts`), and all formulas below assume them:

| Greek | Formula (call) | Convention | Working intuition |
|---|---|---|---|
| Delta $\Delta$ | $N(d_1)$ | unitless; puts $N(d_1)-1$ | hedge ratio; also ≈ P(expires ITM) — the desk names strikes by delta ("the 25Δ put") because deltas are comparable across tenors and vol levels while raw strikes are not |
| Gamma $\Gamma$ | $\dfrac{\varphi(d_1)}{S\sigma\sqrt{\tau}}$ | per 1 unit of spot | how fast your hedge goes stale; largest ATM, explodes near expiry |
| Vega $\nu$ | $S\varphi(d_1)\sqrt{\tau}$ | per 1.00 of vol (÷100 for per-point) | P&L per vol point; grows like $\sqrt{\tau}$ — long-dated options are vol instruments, short-dated are gamma instruments |
| Theta $\Theta$ | $-\dfrac{S\varphi(d_1)\sigma}{2\sqrt{\tau}} - rKe^{-r\tau}N(d_2)$ | per **year**; ÷365 for per-day | the rent; what the seller collects for warehousing gamma |
| Rho $\rho$ | $K\tau e^{-r\tau}N(d_2)$ | per 1.00 of rate | negligible in crypto (see below) |

### The identity that runs the desk

Set $r=0$ in theta and compare with gamma:

$$\boxed{\Theta \approx -\tfrac{1}{2}\,\Gamma S^2 \sigma^2}$$

Theta and gamma are the same quantity with opposite signs and a price tag. A short option position collects $|\Theta|$ per unit time *because* it is short $\Gamma$ — it has sold the right to be re-hedged against moves. §3 turns this identity into the P&L decomposition that defines the desk's edge; §6 turns it into a hedging policy. If you retain one equation from the course, this is it.

### Put-call parity (model-free)

$$C - P = S - Ke^{-r\tau}$$

No model, no vol input — just no-arbitrage. Parity is why a covered call and a short put are the same position (§4), why synthetics exist at all (§10), and the first sanity check on any option chain snapshot: if parity is violated beyond transaction costs in your data, your data is wrong, not the market.

### Useful ATM approximations (mental arithmetic for the desk)

At the money, $d_1 \approx \tfrac{1}{2}\sigma\sqrt{\tau}$ and everything simplifies:

$$\text{ATM straddle} \approx \sqrt{\tfrac{2}{\pi}}\; S\sigma\sqrt{\tau} \approx 0.8\, S\sigma\sqrt{\tau}$$

**Worked example** (the numbers used throughout the course): BTC at $S=\$60{,}000$, 30-day tenor ($\tau = 30/365 = 0.0822$), IV at the desk's measured 37.1 (#12):

- $\sigma\sqrt{\tau} = 0.371 \times 0.2867 = 0.1064$
- ATM straddle ≈ $0.7979 \times 60{,}000 \times 0.1064 \approx \$5{,}090$ (≈ 8.5% of spot)
- Straddle theta per day ≈ straddle ÷ (2 × days) = $5{,}090 / 60 \approx \$85$/day per 1-BTC contract — the same order as the #12 measurement ($≈\$110$/day at the higher spot of that snapshot). This is the "rent" a short-straddle seller collects while the identity above holds.

## When it works / when it breaks

**Works:** pricing and Greeks for liquid European options within one smile snapshot. Deribit's own displayed Greeks are Black-Scholes at the mark IV — so a validated BS engine agrees with the venue by construction, which is what #12 verified and why the desk can trust its marks.

**Breaks:** (1) **Across strikes** — one $\sigma$ cannot price the whole chain; the smile (§8) is the market telling you the lognormal assumption fails in the tails. The engine handles this the way desks do: each strike is priced at *its own* implied vol from the chain, and BS is the interpolator, never the forecaster. (2) **Across time** — vega P&L from smile moves is real P&L that a static-vol mark misses; the v0 VRP book's "marked at entry IV" simplification is honest-but-stated for exactly this reason. (3) **Rho in crypto** — there is no clean risk-free rate; the engine runs $r \approx 0$ and the *actual* financing signal lives in the perp funding rate and futures basis, which this desk trades as a separate book (the carry desk). Where financing matters to an options structure (§10's synthetics), it enters as a measured basis, not a textbook $r$.

### The crypto wrinkle: inverse (coin-settled) options

Deribit BTC options are **inverse**: premium and settlement are paid in BTC, while strikes are in USD. A 1-BTC-contract call quoted at 0.0850 BTC costs 0.0850 × spot in dollar terms *today*, and a seller's collateral is coin whose dollar value moves with the very underlying being optioned. Consequences that matter at this desk's horizon:

- **P&L accounting must pick a numéraire and say so.** The Meridian paper books convert at mark and state it on the tear-sheet (the v0 `VrpBook` precedent) — in a violent move the coin-vs-USD gap is material, and hiding it would flatter exactly the episodes that matter.
- **A covered call is natively collateralized** — short a call against coin inventory needs no USD margin model; this is why the wheel (§4) and covered structures are the natural first books on a coin-settled venue.
- The USD-margined Black-Scholes above remains the correct *relative-value* engine (Deribit's marks are quoted in IV terms); the numéraire choice is an accounting layer on top, not a different pricing model.

## Code shape

The engine's real seam — this is quoted from the repo, not idealized (`src/derivatives/greeks/option-pricer.interface.ts`):

```typescript
export type OptionType = 'CALL' | 'PUT';

export interface OptionSpec { type: OptionType; strike: number; expiryMs: number; }

export interface PriceInputs {
  spot: number;
  iv: number;      // fraction: 0.55 = 55% vol
  rate: number;    // fraction; ~0 in crypto — financing lives in funding/basis
  asOfMs: number;
}

export interface Greeks { delta: number; gamma: number; vega: number; theta: number; rho: number; }

export interface OptionQuote extends Greeks {
  price: number;
  tYears: number;  // the year-fraction used — surfaced so nothing hides the τ conversion
}

export interface IOptionPricer {
  readonly modelId: string;
  price(opt: OptionSpec, inp: PriceInputs): OptionQuote;
}

/** Year-fraction to expiry, floored so an expiring option stays finite. */
export function yearsToExpiry(expiryMs: number, asOfMs: number): number {
  return Math.max((expiryMs - asOfMs) / (365 * 24 * 3600 * 1000), 1e-9);
}
```

Two implementations sit behind it, per the repo's swap-seam discipline: `BlackScholesPricer` (real, validated #12) and `MockOptionPricer` (deterministic stand-in so tests run model-free). Every book in this course consumes `IOptionPricer` and never calls a formula directly — which is what lets the whole desk be tested offline.

## Sources

- Hull, *Options, Futures and Other Derivatives* — the derivations behind every formula above.
- Natenberg, *Option Volatility and Pricing* ch. 5–9 — Greek intuition the way traders actually use it.
- Deribit documentation: inverse contract specifications, mark-IV methodology (the venue conventions the engine matches).
- Meridian journal #12 — the line-by-line Greeks validation against Deribit; `src/derivatives/greeks/black-scholes.ts` + its spec.
