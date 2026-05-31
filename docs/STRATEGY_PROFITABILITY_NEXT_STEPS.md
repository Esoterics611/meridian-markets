# Strategy Profitability — Diagnosis & Next Steps

_Written 2026-05-31 from a ~2h live paper run (7-pair portfolio, `ou-bertram-fast`, real Binance feed, PaperVenue). For the next session._

## TL;DR

The strategies are losing money **because of fees, not a broken signal.** Per-trade
gross edge (~2–3 bps of captured reversion) is ~10× smaller than the ~20 bps round-trip
fee. The signal is directionally correct; the cost hurdle eats it. Ronnie's "if we did the
opposite we'd gain" hunch is the *feel* of paying the spread on every entry — flipping the
sign still pays the 20 bps. Don't flip; cut cost and raise the edge bar.

## Evidence (from the live books, ~282 bars in)

- Portfolio total: **realised −13.98 USDC, unrealised −1.96** on 100k capital (~−0.016%).
  Small in % but consistently red across almost every book.
- The one fully-closed trade with full detail (ADA/SOL fast snapshot):
  - notional **1000 USDC**, **entry z −1.40 → exit z −0.15** (reverted toward 0 — signal RIGHT).
  - `pnlUnits = −1,760,813` (net, −1.76), `feesUnits = 2,000,000` (2.00).
  - **gross = net + fees = +0.24 USDC** → a gross winner that fees turned into a net loss.
- Fee math: 5 bps taker × 4 fills (long leg + short leg, entry + exit) = **~20 bps round-trip**.
  2.00 USDC on 1000 USDC notional = 20 bps. Confirmed.

## Root causes

1. **`ou-bertram-fast` mis-prices its own costs.** `defaultParams.txCostFraction = 0.0004`
   (4 bps) vs the real ~20 bps. The Bertram band optimises entry/exit assuming a 5×-too-cheap
   world, so it opens trades that cannot clear the true cost. `ouWindow: 60` + `aggressive`
   risk profile = high trade frequency = fee churn. See
   `src/stat-arb/strategies/strategy-registry.ts:149` (OU_BERTRAM_FAST).
2. **Degenerate hedge ratios.** Worst losers have tiny betas: ADA/BNB `beta 0.10` (−6.76,
   the single biggest loser), ADA/LINK `beta 0.50`. A 0.10 hedge ratio ≈ naked-long ADA —
   directional bleed, not market-neutral arb. Discovery is admitting non-cointegrated pairs.

## Plan to turn it profitable (ordered by leverage)

1. **Maker, not taker.** Post limit orders at the band → ~0–5 bps instead of 20 bps taker.
   Single biggest lever. PaperVenue is taker-only today (`src/execution/paper-venue.ts:43`,
   `takerFeeBps ?? 5n`, 4 fills/round-trip) — needs a maker/limit fill mode to simulate
   resting orders + (non-)fill. This is the real fix; everything else is tuning around fees.
2. **Tell the strategy the truth about costs.** Raise `txCostFraction` to the real round-trip
   (~0.0020 for taker, lower once maker lands). The band then only fires on trades that clear
   cost. Cheap one-line change to validate the thesis even before maker fills.
3. **Trade less, demand more edge.** Wider `entryZ`, fewer round-trips; add a minimum-expected-
   edge gate so we don't round-trip on 1.25 z of reversion worth ~2 bps. Ronnie's instinct.
4. **More + better markets.** More *independent* pairs each clearing the cost bar diversifies
   the thin edge. Pair it with a cointegration / beta-quality floor in discovery to reject the
   0.10-beta junk (a `0.2 ≤ |beta| ≤ 5` sanity band + a half-life / ADF gate would kill the
   worst books).

## How to reproduce / verify next session

- Server was running: `FEED_SOURCE=binance EXECUTION_MODE=paper ... npm run start:dev` on :3100.
- Live books: `GET /api/stat-arb/live/portfolio` and `GET /api/stat-arb/live/snapshot`.
- Quick gross-vs-net check on any closed trade: `gross = pnlUnits + feesUnits`. If gross is
  consistently ≥ 0 while net < 0, the diagnosis holds and the work is cost reduction, not signal.

## Note (NOT done yet)

This is a diagnosis only — no strategy/venue code was changed this session.
