# Production Readiness — stat-arb desk

> "What else before we trust the numbers and run strategies full-time?" This is
> the gating checklist. The desk is a **paper** stat-arb engine on real data; the
> gap that matters most is **sim fidelity** — backtest P&L must translate to live,
> or every strategy decision is built on sand. Tiers: **P0** = before trusting a
> backtest / going full-time on strategies; **P1** = before real capital (canary);
> **P2** = polish. Companion: [QUANT_ROLE.md](./QUANT_ROLE.md), [QUANT_JOURNAL.md](./QUANT_JOURNAL.md).

## ✅ Already in place
- **Fees in the loop** — 5 bps/leg taker in backtest + a **fee gate in the entry
  decision** (`signal/fee-gate.ts`, registry `minEdgeMultiple`), not just P&L.
- **Position sizing, honestly** — sizing study proves size is risk-not-alpha under
  flat fees + an impact-aware optimal N* (`/api/market-data/sizing-study` + UI).
- **Risk gates (per book)** — drawdown gate, venue notional cap, correlation cap
  exist (`src/stat-arb/risk/`); arm switch (`LIVE_TRADING_ARMED`) fronts real money.
- **Controls** — flatten, per-station remove, desk kill; persisted trade ledger +
  daily NAV cron.
- **Ops (this session)** — session equity curve persisted across refresh; a
  connection-health heartbeat so an hours-open desk never shows frozen-as-live.
- **Breadth** — multi-asset scan + multi-source data (Binance + Pyth/DefiLlama/Bit2C).

## P0 — sim fidelity (gate before trusting any backtest)
1. **Slippage + half-spread + impact in the backtest venue.** Today
   `HistoricalReplayVenue` fills at the **bar close with zero slippage** — so
   backtest edge is optimistic, worst on thin alts (where the real value is).
   Add a `SlippageReplayVenue`: fill at close ± half-spread ± impact(notional/ADV).
   *Until this lands, every "+$X, Sharpe Y" is an upper bound, not a forecast.*
2. ~~**Out-of-sample / walk-forward on REAL history.**~~ ✅ **DONE (Entry #3).**
   `POST /api/market-data/walk-forward` (+ Research "Walk-forward (real OOS)"
   button) runs the active pair over **real Binance history** with a true
   train/test split: **β re-fit on each train window**, applied **OOS on test**,
   net of fee+spread+impact. Reports avg-test-Sharpe, positive-window-share, and
   **`sharpeDegradation`** (train→test gap) + β per window. The harness
   (`walkForward`) is now slice/train-aware so a replay venue prices each window
   correctly. *Still to do: actually run it on the deploy candidates and record
   the numbers (Journal next-action #1).* **No strategy ships on in-sample numbers.**
3. **Multiple-testing correction.** We scan ~80–90 cointegrated pairs/class and
   report the top — pure selection bias. Add **deflated Sharpe** + purged k-fold;
   discount the headline Sharpe accordingly.
4. **Borrow / funding cost on the short leg.** Stat-arb is short one leg; spot
   borrow (or perp funding) is a real carry we currently ignore → optimistic.
   Add a per-bar carrying cost to the backtest.
5. **More history + point-in-time universe.** 10 days isn't "consistent over
   days" evidence; backtest months for regime coverage, and avoid survivorship
   (presets are *today's* listed symbols).

## P1 — before real capital (canary)
6. **Sizing/allocation policy enforced on deploy.** A risk-parity allocator
   (size ∝ 1/σ_spread) + per-pair impact cap + **desk-level** gross/net limits and
   correlation cap wired into the live path (not just the backtest).
7. **Maker / limit execution.** Biggest alpha lever *and* a fidelity need: model
   passive fills (queue position, fill probability) — reuse `src/market-making/`.
   Cuts the ~20 bps floor toward zero and re-opens whole classes.
8. **Real venue adapter + order management.** `RealBinanceVenue` throws today
   (Track-B stash); needs limit orders, partial-fill handling, idempotent order
   IDs, and a **testnet round-trip** behind `LIVE_TRADING_ARMED`.
9. **Reconciliation.** Position/balance reconcile vs the venue (we have the
   pattern for treasury; trading needs its own).
10. **Restart-safe live books.** The live loop is in-memory (`setInterval`); a
    process restart loses the deployed stations (trades persist, the *config*
    doesn't). Persist deployed-station config + resume on boot.

## P2 — polish / depth
11. **Data hygiene** — `defi-bluechip` + `stablecoin-peg` presets collapse to 0
    aligned bars (sparse/late-listed tickers); robust gap handling + a
    point-in-time bar store.
12. **Headless alerting** — push (not just UI) on drawdown / stale-feed / halt;
    NAV at **hourly** granularity (cron is daily).
13. **L2 ingest** — turn `SimpleQueueModel` into the real `LobReplayHarness` for
    the maker model.
14. **Strategy-level robustness** — time-stops, divergence stop-loss (cointegration
    broke), regime filters (these are ongoing quant work, not infra).

## The one-line answer
Lotting and fees are handled; **slippage/spread/impact (P0.1) and real-history
walk-forward OOS (P0.2) now ship.** What remains before *trusting* a backtested
edge: **a multiple-testing haircut (P0.3, deflated Sharpe — we scan ~80–90
pairs/class) and short-leg borrow/funding (P0.4)** — plus actually *running* the
OOS gate on the deploy candidates and recording the numbers. Until those land,
the desk can find candidates and now judge them out-of-sample, but the headline
Sharpe still owes a selection-bias discount. Everything else (allocator, maker,
real venue) is P1 and gates *real capital*, not *strategy research*.
