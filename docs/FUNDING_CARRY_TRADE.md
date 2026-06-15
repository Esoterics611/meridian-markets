# Funding Carry Trade — How It Works

This is the live strategy tracked by `scripts/funding-carry-live.ts` and gated by
`scripts/funding-carry-oos.ts`. It is **T2 of the Profit Pivot** (see `docs/PROFIT_PIVOT.md`).

---

## 1. The instrument: perpetual futures

A **perpetual future** (perp) is a contract that tracks the price of an asset — BTC, ETH, BNB —
but never expires. Unlike a regular futures contract (which converges to spot at expiry), a perp
can stay open forever.

The problem: if a perp never expires, what keeps its price from drifting away from the real spot
price? The answer is the **funding rate**.

---

## 2. The funding rate mechanism

Every hour (on Hyperliquid), anyone holding a perp position makes or receives a small cash payment:

- If the **perp is trading above spot** → long holders **pay** short holders. This makes longs less
  attractive, pushing the perp price back down toward spot.
- If the **perp is trading below spot** → short holders **pay** long holders. This makes shorts less
  attractive, pushing the perp price back up toward spot.

The size of the payment is the **funding rate** — a small bps-per-hour applied to your notional.
It is the market's self-correcting mechanism that keeps perp ≈ spot.

This is what `rate(bps/hr)` shows in the live tracker output. ETH at +0.125bps/hr means:
**longs are paying shorts 0.125bps of notional every hour.**

---

## 3. The trade: delta-neutral carry

The insight is simple: if longs are paying shorts, **be short.** But being short a perp is a
directional bet — if ETH rises 10%, you lose 10% on the short.

The fix: **simultaneously hold the same notional of ETH on spot.** Now:

```
P&L = spot goes up $X  −  perp short loses $X  +  funding collected
    = $0 (flat directional)  +  funding stream
```

You are **delta-neutral** — the price moving up or down does not affect you. The only thing
remaining is the funding stream, which you collect every hour. This is the carry.

This is exactly what the paper positions look like:

```
ETH: LONG Binance spot / SHORT HL perp | $50,000/leg
BNB: LONG Binance spot / SHORT HL perp | $50,000/leg
```

Two legs, equal size, opposite direction. Price risk cancels. Funding remains.

---

## 4. The math on live positions

ETH accruing at +0.125bps/hr on a $50,000 leg:

```
$50,000 × 0.000125/hr = $6.25/hr
$6.25 × 24h           = $150/day
$150 × 365             = $54,750/yr gross → ~109% annualised at this rate
```

That rate is a **hot patch**, not the 90-day average. What the OOS gate reported as +3.6%/yr for
ETH is the average across all hours — including zero-rate and negative-rate periods. What the live
tracker shows is the real-time variability around that average.

**Entry cost:** Binance taker (4.5bps) + HL taker (2.5bps) on each $50k leg = **$35 per symbol.**
Poll 1 starts at −$34.38 net for ETH because the $35 entry fee is owed immediately, and the carry
starts paying it back from tick 1.

At the T2a average rates:

| Symbol | Gross carry/yr | Breakeven |
|--------|---------------|-----------|
| BNB    | +6.1%         | ~6.9 days |
| ETH    | +3.6%         | ~11.6 days |

---

## 5. Why BNB can be flat for hours

BNB's rate oscillates near zero during quiet patches (the T2b live output shows −0.043 to
+0.032bps/hr in a single session). This does not mean the trade is broken — it means you are in a
quiet patch.

The T2a OOS gate said BNB had positive funding **81% of hours over 90 days.** That 19% of
neutral/negative hours is exactly what you watch in the live tracker. The carry comes in **lumpy
clusters**, not smoothly.

The discipline: **hold past the breakeven window, do not churn.** If you close and re-open on
every quiet hour, you pay $35 twice and reset your clock. You need to sit through the zero-rate
windows to collect the positive ones.

---

## 6. What the OOS gate protects against

Without the gate you'd pick symbols with the highest recent funding and run them. That is a trap:
**survivorship / recency bias.** A symbol with spectacular recent funding is often mean-reverting
back to zero — the mechanism forces it, because high positive funding kills the longs who were
driving it up, reducing demand and bringing the rate back down.

The gate splits 90 days into two windows (2/3 train, 1/3 OOS) and asks: **was the funding
positive in both halves independently?** A one-window spike fails. A regime-persistent carry
passes.

```
Gate: posFrac_inSample ≥ 0.65  AND  posFrac_OOS ≥ 0.65
```

This is why BTC failed the gate: its first 60 days had IS posFrac = 0.595 — barely better than a
coin flip. BNB and ETH had ≥0.69 in both halves, meaning the carry was present across two
separate time periods, not just once.

**Full gate results (2026-06-15, 90d HL hourly):**

| Symbol | IS posFrac | OOS posFrac | Gross carry | Breakeven | Gate |
|--------|-----------|------------|------------|-----------|------|
| BNB    | 0.81      | 0.81       | +6.1%/yr   | 8.3d      | PASS |
| DOGE   | 0.82      | 0.77       | +6.1%/yr   | 8.4d      | PASS |
| ETH    | 0.69      | 0.79       | +3.6%/yr   | 14.1d     | PASS |
| BTC    | 0.60      | 0.83       | +2.5%/yr   | 20.5d     | FAIL |
| ADA    | 0.57      | 0.51       | +2.4%/yr   | 21.7d     | FAIL |
| SOL    | 0.48      | 0.55       | +2.0%/yr   | 25.2d     | FAIL |
| XRP    | 0.49      | 0.43       | +1.3%/yr   | 39.6d     | FAIL |
| SUI    | 0.51      | 0.76       | +0.9%/yr   | 57.1d     | FAIL |

Re-run the gate before each new position — rates shift over weeks and a passer today can fail in
30 days:

```bash
FCO_DAYS=90 FCO_SOURCE=hl npx ts-node -r tsconfig-paths/register scripts/funding-carry-oos.ts
```

---

## 7. The risks

**Basis risk.** Your spot and perp leg do not move identically tick-for-tick. If HL's perp
temporarily disconnects from Binance spot during a crash, you can show a paper loss even though
your delta is theoretically flat. T1 (cross-venue basis) monitors this — the structural discount
of ~2–5bps we observe means the basis is stable, not blowing out. A spike beyond ~19bps is a
T4 dislocation signal.

**Rate reversal.** If sentiment flips (a large down move, everyone goes short), the funding sign
can reverse: longs start getting paid, and you as a short holder now pay. This is why posFrac
matters — you want funding positive most of the time so the occasional reversal does not wipe
the accumulated carry. The 0.65 gate threshold is the minimum you'll tolerate.

**Liquidation on the perp leg.** Your short perp shows unrealised losses if price spikes hard.
You need enough margin on HL to survive the move without being liquidated. Sizing at $50k/leg
with a matching $50k spot position means the combined position is fully collateralised — the spot
gain covers the perp loss in any price scenario.

**Fee drag on small positions.** The $35 entry cost is real and must be earned back before you
are profitable. On $50k that is 7bps — you need to hold long enough for the carry to clear it.
Scale up per-leg notional to make the entry fee a smaller fraction: at $500k/leg the same $35
cost is 0.7bps.

---

## 8. The live tracker

```bash
# 48h paper track — runs the OOS gate first, refuses any symbol that fails today
FCL_HOURS=48 FCL_SYMBOLS=BNB,ETH \
  npx ts-node -r tsconfig-paths/register scripts/funding-carry-live.ts
```

Output columns:
- `rate(bps/hr)` — the current HL funding rate for that symbol (live, polled each interval)
- `accruedFunding$` — cumulative simulated carry received so far
- `netAfterEntryFee$` — the number that matters: carry minus the $35 round-trip entry cost
- `breakeven?` — flips to ✅ when `netAfterEntryFee$` crosses zero

The **pre-registered success metric:** net funding accrued across all gate-passing symbols
exceeds entry+exit fee cost over the full breakeven window. Judge on `netAfterEntryFee$` at
session end — not on the unrealised basis P&L between the two legs.

---

## 9. One line

> You hold spot to cancel the price risk of shorting the perp, and collect the hourly funding
> payment that leveraged longs pay to stay in their positions. It is a bet that leveraged long
> demand persists — which it does, consistently, on assets where futures markets are active and
> speculative interest is high.
