# 10 · Capital efficiency — synthetics & stock replacement

## What it is

Put-call parity (§2) means option combinations can *replicate* delta-one positions — and replication with less capital is a business. **Stock replacement** is the institutional version: instead of holding the core long in spot, hold a **deep in-the-money long call** (the desk's shape: **90d+ 80Δ**), which carries most of the delta for a quarter of the capital, and put the freed capital to work elsewhere. On this desk "elsewhere" is not hypothetical: the carry desk (PROFIT_PIVOT_II M1) earns a measured 6–12%/yr on deployable capital, which turns the replacement decision into a **measurable inequality between two of the desk's own books** — the only strategy in this course that a single-strategy shop cannot even evaluate. This chapter is the arithmetic of that inequality, plus the honest list of what replication *doesn't* replicate.

## Math sketch

### What a deep-ITM call actually is

Parity, rearranged: $C = (S - Ke^{-r\tau}) + P$. A long call **is** a financed long position plus a protective put at the same strike. For an 80Δ 90d call the embedded put is far OTM (it's the 20Δ put by parity), so the position behaves like spot — until a crash, where the embedded put becomes exactly §9's convexity. Stock replacement therefore does three things at once: frees capital, keeps most of the delta, and *adds a floor at the strike for free-ish*. The "-ish" is the whole chapter.

**Worked example** at the course's smile (BTC 60k, 90d, 80Δ → strike ≈ $50{,}000$, IV at the 90d point ≈ 39):

- Call price ≈ intrinsic $10{,}000$ + time value ≈ $2{,}600$ → ≈ **\$12,600** per 1-BTC contract.
- Capital freed vs spot: $60{,}000 - 12{,}600 = \$47{,}400$ — **79% of the notional**.
- Cost of the replacement, per 90d cycle: the time value ≈ \$2,600, *minus* what the embedded 20Δ put is worth to the desk (not zero! it feeds the §11 stress grid exactly like §9's ladder), *plus* the roll toll (two crossings of the quoted spread per quarter, charged from the tape).
- The inequality that decides the book: $\underbrace{\text{carry earned on } \$47{,}400}_{\approx\; \$700\text{–}1{,}400/\text{qtr at M1's } 6\text{–}12\%/yr} \;\gtrless\; \underbrace{\text{time value} - \text{embedded-put credit} + \text{roll costs}}_{\approx\; \$1{,}800\text{–}2{,}400/\text{qtr at this smile}}$

At the course's snapshot the inequality is **close** — which is the honest and useful finding: stock replacement in crypto is not automatic (crypto's high IV makes even 80Δ time value expensive relative to equity-market replacements), it is *conditional on the smile and the carry regime*, and the book's entry gate is the measured inequality itself, recomputed per roll cycle. When it fails, the core stays in spot and the book reports "replacement uneconomic this cycle" — a valid, frequent output.

### The financing subtlety (crypto has no $r$, it has a basis)

In equities, the call's time value embeds the risk-free rate — replacement competes against T-bills. In crypto, §2 said $r \approx 0$ in the pricer, but financing is *not* free — it lives in the **futures basis and perp funding**, which the desk's carry book already measures live. The consistent framing: the option's time value at the tape's IV *is* the market's all-in charge for levered, floored BTC exposure; the carry desk's yield *is* the market's payment for warehousing the other side. The book is arbitraging the desk's own two measured curves against each other, which is why both inputs come from live books rather than models.

### What replication doesn't replicate (the tracking-error ledger)

An 80Δ call is not 0.80 BTC. The differences, each a tear-sheet line: **delta drift** (rallies push delta toward 1 — good drift — while selloffs bleed it toward 0.5 exactly as spot falls: the floor engaging *is* tracking error on the way down); **vega** (the position is long ≈ \$115/vol-pt at this shape — a vol crush after a euphoric entry costs real basis points even if spot goes nowhere); **the roll** (four times a year, paying the 80Δ strike's spread — tight by options standards, but 4× anything compounds); and **no yield on the notional you no longer hold** (in equities, dividends; in crypto, staking/lending yield forgone on ETH-type cores — for BTC ≈ 0, one honest reason BTC is the desk's replacement candidate and not ETH).

Pre-registered metric (from `OPTIONS_DESK.md` §2-O7): **90d tracking error vs the delta-one core ≤ 1.5%, AND net (carry earned − replacement cost) > 0 over two consecutive scored roll cycles** — else the book stays in spot and says so.

## When it works / when it breaks

**Works:** calm-to-grinding-bull regimes with fat funding — spot drifts up (delta drift is favorable), IV is stable-to-bid (no vega bleed), and the carry desk's 8 legs are all accruing on the freed capital. This is also the regime where the desk's income books are *smallest* (low premium), so O7 is counter-cyclical to the desk's earnings mix — a portfolio-construction point §11 uses.

**Breaks:** the vol crush after euphoria (bought the call at IV 55 in the FOMO top, spot flat for a quarter, IV 38: the time value halves — tracked, budgeted, and the reason entry *prefers* low-IV regimes and the §8 call-skew signal gates against FOMO-priced entries); the crash (the floor engages — by design, but the tracking error vs spot is then *positive* and large, and the honest tear-sheet reports replacement + carry vs spot **both** ways, because outperforming in the crash is not the metric, matching the core cheaply is); and the operational break — the carry desk's yield collapsing mid-cycle (funding flips), which unwinds the inequality after entry. The response is pre-registered: the roll cycle is the decision cadence; no intra-cycle flip-flopping between spot and synthetic (the churn would eat the edge).

## Code shape

```typescript
export interface ReplacementQuote {
  strike: number;                 // the live 80Δ strike from the chain
  callPriceUsd: number;
  intrinsicUsd: number;
  timeValueUsd: number;           // the gross cost of the replacement per cycle
  embeddedPutCreditUsd: number;   // parity: the 20Δ put's stress-grid value to the desk (§11)
  rollCostUsd: number;            // 2 × half-spread at the 80Δ strike, from the tape
  freedCapitalUsd: number;        // spot − callPrice
}

/** The entry gate IS the inequality — measured, both sides, from the desk's own books. */
export function replacementEconomic(q: ReplacementQuote, carryAprFrac: number, cycleDays: number): boolean {
  const carryEarned = q.freedCapitalUsd * carryAprFrac * (cycleDays / 365);
  const netCost = q.timeValueUsd - q.embeddedPutCreditUsd + q.rollCostUsd;
  return carryEarned > netCost;
}

export interface ReplacementCycleReport {
  trackingErrorVsSpotFrac: number;  // pre-registered bound: ≤ 0.015 per 90d
  carryEarnedUsd: number;           // from the M1 book's REAL accrual, not the estimate
  netCostUsd: number;               // realized, including the actual roll fills
  verdict: 'REPLACED' | 'STAYED-SPOT';  // "uneconomic this cycle" is a normal, logged outcome
}
```

## Sources

- Hull ch. on synthetic positions; Natenberg ch. 14 — parity-based replication mechanics.
- Israelov & Tummala (2017), "Which Index Options Should You Sell?" and the AQR overlay literature — capital-efficiency framing on institutional desks.
- The cash-and-carry / basis-trade literature (crypto: the perp-funding studies the carry desk is built on) — the financing side of the inequality.
- Meridian: PROFIT_PIVOT_II M1 (the carry yield that funds the trade), `docs/OPTIONS_DESK.md` §2-O7 (the book spec and its two-cycle scored gate).
