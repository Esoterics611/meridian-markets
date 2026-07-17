# 1 · What long-horizon options investing actually is

## What it is

An option is a transferable insurance contract on a price. **Long-horizon options investing is the business of being a disciplined insurance company** — collecting premium for risks you have measured and sized (income), buying coverage whose cost you account for honestly (insurance), and using the contracts' embedded leverage to free capital (efficiency) — over holding periods of weeks to months, where the position's *structure* does the risk management that a faster desk would do with reaction speed.

That sentence contains the whole course. The rest is measurement, math, and the discipline of not lying to yourself at a feedback cadence of twelve data points per year.

## The three franchise lines

Every legitimate long-horizon options operation — an institutional overwriting mandate, a defensive-equity fund, the Meridian desk — is some mix of three businesses:

**1. Income: selling optionality for the variance risk premium.**
Implied volatility has exceeded subsequently realized volatility in most markets, most of the time, for as long as both have been measurable (§3 has the evidence, including this desk's own: BTC +5.9 vol points, ETH +3.7, journal #12). Sellers of options — cash-secured puts (§4), covered calls (§4), delta-hedged strangles (§6) — harvest that spread. The premium is real; it is compensation, not a free lunch, and the thing it compensates for arrives in §9's history lesson.

**2. Insurance: buying the drawdown bound.**
Options are the only instrument that lets a portfolio *prove* a floor: a long put means the position cannot be worth less than the strike at expiry, as a matter of contract rather than of forecast. Collars (§5) and tail hedges (§9) spend measured premium to cap the left tail. The catch — and the literature is brutal on this — is that naive protection is systematically overpriced, so the craft is buying the floor cheaply and accounting for its cost as an explicit line, never pretending it's free.

**3. Efficiency: convexity as capital structure.**
A deep in-the-money call replicates most of a spot position's delta for 20–30% of the capital (§10). The freed capital can earn elsewhere. This is the least glamorous line and the most quietly institutional: it's how overlay desks actually justify their seat.

The mix is a mandate decision. A desk whose first commandment is *conserve equity* (Meridian's is) runs income sized small, insurance always-on, and reports the cost of the second against the earnings of the first without flinching.

## Why the premium exists (the economics, not the folklore)

The variance risk premium is not an anomaly waiting to be arbitraged away; it is a price for risk transfer with identifiable payers on the other side:

- **Hedgers pay for certainty.** Institutions with mandates, leverage constraints, or career risk buy puts structurally, not tactically. Demand is price-insensitive; supply requires a balance sheet that can survive gaps. The spread between them is the premium (Gârleanu, Pedersen & Poteshman 2009 formalize this as demand-based option pricing).
- **Gap risk cannot be hedged away.** Between the close and the open, through a halt, across a weekend — replication fails exactly when it matters. The Black-Scholes seller can hedge continuously in the model and cannot in the world; the premium is partly the fee for that difference (§6 measures it as hedging error).
- **Crash aversion is priced.** People pay more to insure against events that are catastrophic and vivid than diffusion statistics justify — the same behavioral regularity that makes lottery tickets and earthquake insurance both "overpriced" in expectation. Coval & Shumway (2001) showed option returns are too low (for buyers) to be explained by standard risk models.

None of these payers is going away. That is what "structural" means, and it is also the honest limit of the claim: the premium persists *on average*; it inverts violently in exactly the episodes that define the strategy's risk (§3, §9).

## The institutional evidence

The claim "selling options earns a premium worth having" has a rare luxury: a third-party-computed, investable, four-decade track record.

- **CBOE PUT index** (systematic at-the-money cash-secured SPX put writing, monthly, data from 1986): returned approximately equity-like performance with roughly two-thirds of the volatility over its first two decades (Whaley 2002; the pattern held in later extensions). Not because put-selling is magic — because it converts equity beta plus the variance premium into a smoother path.
- **CBOE BXM index** (covered calls on SPX): the same story from the other side of parity. Israelov & Nielsen (2014) decomposed it correctly: a covered call is *passive equity exposure plus a short volatility position* — the "income" is the short-vol leg, and calling it income without saying "short vol" is the field's original sin.
- **The graveyard, which is also evidence:** October 1987 (put sellers annihilated in a day, and the SPX smile has priced a crash ever since — §8), February 5, 2018 (the XIV ETN, a levered short-vol product, lost ~95% in an afternoon), March 2020 (short-vol funds gated or closed). Every one of these was a *sizing* failure wearing a strategy's clothes. The premium was real before each episode and real after; the accounts that died were the ones sized as if the 13.7% of windows (#42) didn't exist.

Crypto has no PUT index. It has Deribit (BTC and ETH options with real depth since ~2019), a measurable smile, and — on this desk — a validated pricing engine and its own premium measurements. Part of what the Meridian options desk *is*, is the construction of exactly the scored, honest, third-party-checkable record that crypto options don't have (§12–§13).

## What this is not

- **Not market making.** The MM course's desk quotes both sides for milliseconds and lives on the re-quote. This desk *takes* positions in options and holds them for weeks; it happily pays the MM's spread (once, at entry, measured in vol points) as a cost of doing business.
- **Not directional trading with extra steps.** A naked call bought because "BTC is going up" is a delta-one bet with worse costs. Every book on this desk is defined by its *volatility and convexity* exposures; delta is either hedged (§6), structural and floored (§5), or explicitly budgeted (§11).
- **Not "income generation."** The word "income" implies the coupon is safe. Option premium is not a coupon; it is an insurance float. The correct mental model is combined ratio, not yield — an insurer that writes policies below actuarial cost calls its premium income too, right up until the hurricane.

## When it works / when it breaks

**Works:** in the long, boring middle of the distribution — sideways markets, slow trends, high-IV-after-the-panic regimes where the premium is fattest (the best month to sell vol is historically the month *after* the spike, not before). Works structurally when sized so no single tail event can consume more than a budgeted, pre-registered fraction of equity.

**Breaks:** in vol spikes (short gamma bleeds fastest exactly when hedging costs most — §6), in slow grinding trends against a wheel position (§4's assignment spiral), and — most dangerously — in the *trader*, at month eleven of a smooth curve, when the temptation to double the size because "it obviously works" peaks precisely as the sample proves nothing (§12). The instrument's failure modes are priced; the operator's are not.

## Code shape

The desk mandate as a type — everything else in the course hangs off these fields:

```typescript
/** The mandate for one long-horizon options book (see ch. 11 for the desk level). */
export interface OptionsBookMandate {
  id: string;                       // 'wheel-btc', 'collar-core', 'vrp-ladder-eth', ...
  franchise: 'income' | 'insurance' | 'efficiency';
  /** Sleeve cap, fraction of desk NAV. Initial value; the stress grid (ch. 11) binds. */
  sleeveFrac: number;
  /** Every short is fully collateralized — the field that makes blow-ups a bug, not a risk. */
  collateral: 'cash-secured' | 'covered-by-inventory' | 'stress-sized';
  /** Pre-registered before the first trade; the book is judged on this and nothing else. */
  preRegisteredMetric: string;
  /** Books earn capital through the scored-paper gate (ch. 12), never by narrative. */
  status: 'scored-paper' | 'token-capital' | 'sized' | 'cut';
}
```

## Sources

- Whaley (2002), "Return and Risk of CBOE Buy Write Monthly Index" / CBOE PUT & BXM index methodologies — the four-decade evidence base.
- Israelov & Nielsen (2014), "Covered Call Strategies: One Fact and Eight Myths" — the decomposition that keeps this course honest.
- Coval & Shumway (2001), "Expected Option Returns" — buyers systematically overpay.
- Gârleanu, Pedersen & Poteshman (2009), "Demand-Based Option Pricing" — who pays the premium and why.
- Sinclair, *Positional Option Trading* — the practitioner treatment of everything above.
- Meridian journal #12, #42 (the desk's own VRP measurements), #96 (the gate behaving honestly in live paper).
