# Quant Session Log — Strategy Registry + Live Paper Desk

Date: 2026-05-29/30. Role: quant analyst, paper trading on **live Binance data**
(`FEED_SOURCE=binance EXECUTION_MODE=paper`). No real money, no API key.

Companion docs: [QUANT_DESK_GAPS_PLAN.md](./QUANT_DESK_GAPS_PLAN.md) (gaps) and
[../prompts/QUANT_FOLLOWUP_PROMPTS.md](../prompts/QUANT_FOLLOWUP_PROMPTS.md) (next sessions).

---

## What I did

Turned the single hard-coded pairs strategy into a **managed multi-strategy desk**:
a registry of strategies that drop unchanged into both the backtest runner and the
live paper loop, picked from the `/demo` UI, with history-warmup so a freshly armed
pair trades on its **first live bar** instead of waiting ~an hour for a lookback.

### New files
- `src/stat-arb/strategies/strategy-registry.ts` (+ `.spec.ts`) — the desk catalogue.
  4 live-capable strategies across 2 course families; each entry carries id, family,
  course ref, default risk profile, frozen tuning, and a `build({beta, notionalUnits})`.
  - `pairs-zscore` — cointegration pairs, rolling z (course §2)
  - `pairs-ewma` — cointegration pairs, EWMA z (§2 variant)
  - `ou-bertram` — OU mean-reversion, Bertram bands (§3)
  - `ou-bertram-fast` — OU, short-window variant (§3)
- `src/stat-arb/strategies/ou-spread-strategy.ts` (+ `.spec.ts`) — §3 OU: fit θ/μ/σ
  on a rolling window, trade simplified Bertram bands, stand aside when θ≤0.
- `src/stat-arb/strategies/bollinger-pairs-strategy.ts` (+ `.spec.ts`) — §2 pairs with
  an EWMA mean/variance z-score.
- `scripts/quant-session.ts` — headless runbook: list catalogue → backfill a preset →
  discover spreads → backtest every strategy on the top pair → drive each through the
  **real `LivePaperTrader`** over a replay of recent real 1m bars (same class prod
  paper mode uses; only the feed is a deterministic replay) → arm the control plane.
- `docs/QUANT_DESK_GAPS_PLAN.md`, `prompts/QUANT_FOLLOWUP_PROMPTS.md`, this log.

### Wiring changes
- `src/stat-arb/backtest/strategy.interface.ts` — added shared `Regime` +
  `ManagedStrategy` (the one contract registry / runner / live loop agree on).
- `src/stat-arb/backtest/backtest-runner.ts` — `BacktestConfig.strategy` accepts any
  `ManagedStrategy` (was hard-typed to `PairsStrategy`).
- `src/execution/live-paper-trader.ts` — `strategyId` on config/snapshot; **history
  warmup** (`seedHistory` + `WarmupProvider`, runs once on first tick from ~240 real
  klines); `seededBars` in the snapshot.
- `src/execution/live-portfolio-trader.ts` — per-book `strategyId`.
- `src/execution/live.controller.ts` — `GET /api/stat-arb/live/strategies`;
  `configure` and `portfolio` take `strategyId`.
- `src/market-data/market-data.controller.ts` — `backtest` takes `strategyId`.
- `src/config/app-config.{interface,factory}.ts` + `.env` — `LIVE_STRATEGY_ID`.
- `src/stat-arb/stat-arb.module.ts` — registry + Binance warmup wired into both the
  single and portfolio live loops.
- `src/stat-arb/demo/public/index.html` — a **Strategy** dropdown feeding
  trade / backtest / portfolio actions; live card shows strategy + seeded bars.

### Verified
- `npx tsc --noEmit -p tsconfig.json` → **exit 0** (whole project, incl. new script).
- `npx jest src/stat-arb/strategies` → **10/10 pass** (OU, EWMA, registry specs).

### NOT verified (be aware)
- **`scripts/quant-session.ts` was never observed to completion** — that run hung the
  sandbox tool channel and the session ended before I saw its output. So live trades
  are **not yet personally confirmed**; tsc + the strategy unit tests are the only
  proof. **Run it yourself (below) for the actual evidence.**
- **Nothing is committed.** Verify, then `git add -A && git commit`.

---

## How to test it

```bash
# 0. Postgres on :5433 (already running for me) + migrations
echo 5784 | sudo -S docker compose up -d postgres
npm run migration:run

# 1. Unit + type checks (offline, fast)
npx tsc --noEmit -p tsconfig.json
npx jest src/stat-arb/strategies

# 2. Headless proof the LIVE loop enters trades on real Binance (paper).
#    Lower QS_HOURS if the network/backfill is slow.
FEED_SOURCE=binance EXECUTION_MODE=paper MOCK_TRADING_ENABLED=false LIVE_AUTOSTART=false \
  QS_PRESET=crypto-majors QS_HOURS=24 \
  npx ts-node -r tsconfig-paths/register scripts/quant-session.ts
#  Expect: a strategy catalogue, discovered spreads, a per-strategy backtest table,
#  per-strategy live-loop round-trips with realised PnL, and "QUANT SESSION OK".

# 3. The UI — watch live trades land
FEED_SOURCE=binance EXECUTION_MODE=paper MOCK_TRADING_ENABLED=false LIVE_AUTOSTART=false \
  npm run start:dev          # → http://localhost:3100/demo
```

In `/demo`: pick a **Market set** + **Strategy** → **Backfill live history** →
click a discovered pair's **trade** (or **Trade top 3** for a multi-currency book).
The book warms from real history and enters trades on the next live bars; the
**Live position** card + **Recent fills** table show them.

Quick API checks:
```bash
curl -s localhost:3100/api/stat-arb/live/strategies | jq
curl -s -XPOST localhost:3100/api/market-data/backtest \
  -H 'content-type: application/json' \
  -d '{"symbolA":"ETH","symbolB":"BTC","strategyId":"ou-bertram","lookbackHours":24}' | jq
```

---

## Gaps (full detail in QUANT_DESK_GAPS_PLAN.md)

**P0 — two of four course families can't trade live.** The live loop is strictly
2-leg, so it covers pairs (§2) + OU (§3) only. Cross-sectional baskets (§8.2, N-leg)
and funding carry (§8.4, perp+spot + funding signal) need an N-leg loop, a perp/spot
paper venue, and a funding ingest/`IFundingSource`. → follow-up prompts A & B.

**P1 — multi-strategy plumbing.** Capital is split *evenly* (no budget allocator;
`kelly.ts` and `RiskProfile.notionalFraction` exist but are unused); no per-strategy
P&L attribution; no validate-before-arm gate. → prompts C & D.

**P2 — hardening.** Persistent kill-switch / per-position flatten / gate override;
slippage off by default (paper PnL optimistic); NAV endpoint reads cumulative P&L not
`stat_arb_nav`; REST-poll feed (no WebSocket); no `LivePaperTrader` integration spec
for seed+tick→trade; tuning frozen in code (no admin UI / sweep wiring); real venue
adapter for `EXECUTION_MODE=live` (Track-B `git stash@{0}`).
