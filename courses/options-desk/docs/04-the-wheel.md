# 4 · Selling puts & the wheel

## What it is

The wheel is the oldest systematic option-income strategy and the best first book for a long-horizon desk: **sell a cash-secured out-of-the-money put; if it expires worthless, keep the premium and sell another; if it's assigned, take delivery of the underlying at the strike and sell covered calls against it until it's called away.** Then repeat. It is VRP harvesting (§3) packaged with an *inventory-acceptance mechanism* instead of a delta hedge — you accept becoming a long-term holder at a discount rather than paying to stay flat. On a coin-settled venue where the covered call is natively collateralized (§2), it is also the most operationally honest structure available: nothing is levered, nothing can be margin-called, and every possible outcome was collateralized at entry.

## Math sketch

### The two halves are one position

Put-call parity (§2) says $C - P = S - Ke^{-r\tau}$, so **short put ≈ covered call at the same strike** — same P&L profile, same short-vol exposure, different collateral (cash vs inventory). The wheel is therefore *one* continuous short-volatility position that toggles its collateral form on assignment. Israelov & Nielsen's covered-call decomposition applies to the whole cycle: the wheel = **passive long exposure (conditional) + short volatility + a mechanical rebalancing rule**. The "income" is the short-vol leg; say it that way and the risk is never a surprise.

### What selling a 25Δ put actually pays

Strike selection is by delta (§2's convention). For the course's standard snapshot (BTC $60{,}000$, 30d, IV 37):

- The 25Δ put sits near $K \approx S\,e^{-0.67\,\sigma\sqrt{\tau}}$ ≈ $60{,}000 \times e^{-0.0713}$ ≈ **\$55,900** (0.67 = $z$ of the 25th percentile; the skew in §8 shifts this in practice).
- Its premium ≈ **\$700–850** per 1-BTC contract at that smile — call it **1.3% of the \$55.9k collateral per 30d cycle ≈ 15–16%/yr gross** if every cycle were captured in full.
- Nobody captures every cycle in full. The honest arithmetic that matters is **cycle premium capture** — retained/collected across all cycles including the assigned ones — and the desk's pre-registered bar for this book is ≥ 55% (which nets to mid-single-digit %/yr on collateral: real, modest, steady — the number the PUT index's four decades says to expect, not the 16% gross).

### Why the management rules exist (not folklore — the gamma clock)

Every serious wheel operation closes early and rolls before expiry. The reason is §2's identity, run through time: for an OTM short option, the **theta collected per unit of gamma risk carried deteriorates as expiry approaches** — by the last week, most of the premium is already earned and what remains is a coin-flip on pin risk near the strike with gamma at its maximum. Two mechanical rules capture nearly all of the benefit:

- **Take profit at 50% of max premium.** The first half of the premium decays fastest (while the option is comfortably OTM); the second half pays worst per unit of tail risk. Closing at 50% roughly doubles cycle count while shedding the worst risk-hours of each cycle.
- **Roll at 7 DTE regardless.** Past that point you are trading gamma, which is §6's job, not this book's.

And the covered-call leg carries the wheel's one non-negotiable: **never sell a call struck below net acquisition cost minus collected premium** — the rule that makes "the wheel locked in a loss" structurally impossible rather than merely unlikely. The cost of that rule is honest too: after a deep drawdown the callable strikes pay almost nothing, and the book simply holds (that *is* the loss being realized slowly; the rule just forbids crystallizing it at the bottom).

### The entry gate (this desk's version)

The naive wheel sells every cycle unconditionally — that's the PUT-index design and it works as *beta plus premium*. A desk gated on measurement does better on the same structure by only selling when it's paid: **(a)** the VRP gate at tenor is open — $IV_{30d,25\Delta} - \hat\sigma_{EWMA} \ge 3$ pts (§3) — and **(b)** the 25Δ put skew is at or above its rolling 90d median (§8): sell puts when the fear premium is present, stand aside when you'd be selling cheap insurance. Both thresholds come from the desk's own surface tape, per the distribution-first rule (§12).

## When it works / when it breaks

**Works:** rangebound, drifting, and post-panic markets — the fat middle of the distribution. The evidence base is the best in the field: the CBOE PUT index (unconditional monthly SPX put-writing since 1986) delivered roughly equity-like returns at ~⅔ the volatility across four decades, multiple crashes included. That is the strategy's honest ceiling: **a smoother path to underlying-like returns plus a premium — not a money machine.**

**Breaks:** the trending crash. The wheel's failure mode is not one bad expiry — it's **selling puts all the way down**: assigned at 55.9k, spot at 48k; covered calls above cost pay pennies; spot at 40k; the book is now a full long position acquired 15% above market, earning nothing, in exactly the market where IV (and the premium you're not collecting) is richest. Crypto 2022 was a 12-month version of this. The mitigations are structural, not clever: the sleeve cap (this book is 30% of the desk's options NAV, so a full assignment is a bounded event), the skew gate (which refuses the cheap-insurance sells in complacent tops more often than it refuses panic bottoms), and the desk's honesty rule that an assigned wheel is *reported* as a long inventory position at mark, never carried at cost as if the drawdown weren't real. What does **not** mitigate it: doubling size to "average down" the strike — the classic account-killer, forbidden by the mandate's fixed sleeve.

## Code shape

The wheel is a state machine with two states and mechanical transitions — write it that way and there is nothing to discretion:

```typescript
type WheelState =
  | { phase: 'CASH'; sleeveUsd: number }                                  // selling cash-secured puts
  | { phase: 'ASSIGNED'; coinQty: number; netCostUsd: number;            // selling covered calls
      premiumBankedUsd: number };                                        // lifetime premium — feeds the floor rule

export interface WheelConfig {
  tenorDays: number;            // 30
  targetDelta: number;          // 0.25 — strike chosen from the live chain by delta
  minVrpPts: number;            // 3 — the §3 gate at tenor
  requireSkewAboveMedian: boolean; // the §8 condition on the put wing
  takeProfitFrac: number;       // 0.5 — buy back at 50% of max premium
  rollAtDte: number;            // 7 — the gamma clock
}

/** The one rule that makes a locked-in loss impossible: lowest callable strike. */
export function minCallStrike(s: Extract<WheelState, { phase: 'ASSIGNED' }>): number {
  return (s.netCostUsd - s.premiumBankedUsd) / s.coinQty;
}

/** Contracts are set by collateral, never by conviction. */
export function cashSecuredContracts(sleeveUsd: number, strike: number): number {
  return Math.floor(sleeveUsd / strike);
}
```

The cycle scorer (premium capture, assignment-episode recovery) is the §12 scored-paper harness; the book ships to scored-paper first like everything else on the desk.

## Sources

- Whaley (2002) and the CBOE PUT / BXM index methodologies — the unconditional wheel's four-decade record.
- Israelov & Nielsen (2014), "Covered Call Strategies: One Fact and Eight Myths" — the decomposition; the "income" framing debunked with data.
- Natenberg ch. 11–13; Sinclair, *Positional Option Trading* ch. 8 — strike selection and management-rule evidence (the 50%/21-DTE family of rules; this desk shortens to 7 DTE at 30d tenor).
- Santa-Clara & Saretto (2009) — transaction costs and margin in systematic put-writing (why the cost model uses the real quoted spread).
- Meridian: `docs/OPTIONS_DESK.md` §2-O1 (the live book spec + pre-registered metric); journal #12/#42/#96 for the gate inputs.
