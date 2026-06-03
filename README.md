# Meridian Markets

A **paper-trading demonstration of an AI-agent-run quant desk** — several strategies running concurrently, each manned by a quant agent, aiming to **minimize drawdown and show steady, conserved returns over hours and days** of live paper trading on real market data. Underneath is a self-contained **stat-arb engine** plus an automated **market-making desk** (market-data spine, signal/risk library, execution path, live event loop); the `/demo` dashboard is a thin read-only view over it.

> **Scope: paper-only, for the foreseeable future.** This is a *demonstration*, not a path to managing real capital — there is **no production / real-money deployment on the roadmap**. Two engines drive it: **crypto market-making** (the steady, low-drawdown earner) and **equities stat-arb** (a thin, uncorrelated diversifier). The frontier where the edge grows is **discovering new markets — especially DEX / decentralized / anonymous markets** to make markets in. Because it's a demo, **truthful numbers are the whole point**: the OOS / survivorship / cost gates exist to keep the paper P&L honest, not to clear a deploy.

It runs in three postures — engineering switches, no business gate (`EXECUTION_MODE` + `FEED_SOURCE`):

- **mock** — synthetic feed + synthetic venue; offline, deterministic (unit tests + demo).
- **paper** — **real** market data (Binance public REST / Alpaca equities) + `PaperVenue` (simulated fills at real prices). **This is the mode we run** — the demo lives here. No API key for crypto, no real money.
- **canary / live** — routes flow to a real venue, behind the `LIVE_TRADING_ARMED=true` arm switch. **Out of scope for now** — the seam is kept honest but wiring a real venue is not a current goal.

Read [`CLAUDE.md`](CLAUDE.md) first — the authoritative architecture + session log.

> **Legacy:** this repo began as a treasury/yield service that fed an external payments service over an HTTP contract. **That integration is retired** and the repo is now standalone. The `src/treasury/` + `src/yield/` code and the `treasury_*` tables remain as dormant legacy (CLAUDE.md §5); the historical spec is archived at [`docs/archive/INTEGRATION_WITH_LIRA_BRIDGE.md`](docs/archive/INTEGRATION_WITH_LIRA_BRIDGE.md).

## Run it locally

```bash
npm install
docker compose up -d postgres        # Postgres on :5433 (sudo on this host if needed)
cp .env.example .env
npm run migration:run                # one-time / when the schema changes
```

Default port is `3100`. The product run path is the **live trading desk** below; deeper design in [docs/PAPER_TRADING.md](docs/PAPER_TRADING.md).

## The live trading desk — run the quant engine & watch paper trades

Meridian is also a **stat-arb trading engine** (CLAUDE.md §1 — the engine *is* the
product; the dashboard is a thin view over it). The "trader" is a background event
loop (`LivePaperTrader`, and the multi-book `LivePortfolioTrader`): each tick it
pulls the next closed 1-minute bar for both legs of a pair from **real Binance
public data**, runs the chosen strategy, and routes orders to `PaperVenue` (fills
at the real ticker, taker fee modelled). Closed round-trips persist to
`stat_arb_trades`. No API key, no account, no real money — paper predicts live
because only the injected venue changes.

An operator drives it from the `/demo` cockpit or the terminal control plane. In the
**agentic** design (the mission, [docs/AGENTIC_HEDGE_FUND_DESIGN.md](docs/AGENTIC_HEDGE_FUND_DESIGN.md))
each book is *manned by a quant agent* (a Claude session) that fits, launches, and
babysits its strategy; a human supervises the one screen. Deeper design:
[docs/PAPER_TRADING.md](docs/PAPER_TRADING.md) ·
[docs/UI_REWRITE_SPEC.md](docs/UI_REWRITE_SPEC.md) ·
[docs/QUANT_TERMINAL_SPEC.md](docs/QUANT_TERMINAL_SPEC.md) ·
[docs/AGENTIC_HEDGE_FUND_DESIGN.md](docs/AGENTIC_HEDGE_FUND_DESIGN.md).

### Prerequisites
```bash
docker compose up -d postgres      # Postgres on :5433 (sudo on this host if needed)
npm run migration:run              # one-time / when the schema changes
```

### A. The cockpit — launch strategies and watch them live
```bash
FEED_SOURCE=binance EXECUTION_MODE=paper MOCK_TRADING_ENABLED=false \
  LIVE_AUTOSTART=false npm run start:dev
# → open http://localhost:3100/demo
```

> **Same command as before — the new data sources need no extra env.** The
> reference sources wired into the scanner (Pyth FX, DefiLlama peg, Bit2C ILS)
> are **public, no API key**, with built-in default URLs. Override only if you
> need a mirror/proxy:
> `PYTH_BENCHMARKS_BASE_URL`, `DEFILLAMA_STABLECOINS_BASE_URL`, `BIT2C_BASE_URL`
> (see `.env.example`). They do make outbound calls, which paper mode already does
> for Binance.

In `/demo`:
1. **Research → ⊹ Scan all source data** is the front door: it sweeps **every
   asset class at once** (crypto, stablecoin, **FX via Pyth**, …) and ranks each
   candidate by net-edge-after-fees, **grouped by asset class** with a rollup of
   which classes fit the model. A "data sources wired" readout shows the live
   sources (binance.spot + Pyth/DefiLlama/Bit2C). **Trade** straight from a row —
   every trade launches an isolated paper book (a *station*).
2. **▶ Launch a station** (Launch tab): asset class → market (leg A / leg B) →
   strategy → **edit its params** (entry/exit z, windows, tx-cost…) → β + capital
   → **Launch**. β auto-fills from discovery when the pair was found cointegrated.
3. **Desk → Live books** shows every concurrent station as a param card — z-score,
   β, bands, regime, position, capital, equity, realised/unrealised, **feed** —
   with z & equity **sparklines**. Each card has ▸ (chart its signal) and ✕
   (flatten + remove). **FLATTEN ALL** / **HALT ALL** are desk-wide.
4. **Research → Deep-dive** discovers one market set in detail (after ⤓ Backfill);
   **Validate before you trade** runs walk-forward / sweep / Monte-Carlo. **Trade
   history** is the persisted `stat_arb_trades` ledger (survives restart). The
   header strip shows desk P&L, feed/venue, a live UTC clock and a heartbeat.

> **Verify the reference sources** (no server, no DB):
> `npx ts-node -r tsconfig-paths/register scripts/smoke-reference-sources.ts`

> 1-minute bars: a freshly launched book warms from ~240 real klines so its
> z-score is live immediately, but an *entry* waits for z to cross the band —
> minutes or longer. Lower the lookback / use a faster interval to iterate.

### B. Headless proof the loop enters trades (no server)
```bash
FEED_SOURCE=binance EXECUTION_MODE=paper MOCK_TRADING_ENABLED=false LIVE_AUTOSTART=false \
  QS_PRESET=crypto-majors QS_HOURS=24 \
  npx ts-node -r tsconfig-paths/register scripts/quant-session.ts
```
Prints the strategy catalogue → discovered cointegrated pairs → a per-strategy
backtest table on real history → per-strategy live-loop round-trips with realised
PnL → arms the control plane. Ends `QUANT SESSION OK`.

### C. Terminal control plane
```bash
curl -s  localhost:3100/api/stat-arb/live/snapshot  | jq   # single book: z, regime, PnL, position
curl -s  localhost:3100/api/stat-arb/live/portfolio | jq   # all live books
curl -s  localhost:3100/api/stat-arb/live/trades    | jq   # persisted blotter (stat_arb_trades)
# launch one station additively, with param overrides:
curl -sX POST localhost:3100/api/stat-arb/live/portfolio/launch \
  -H 'content-type: application/json' \
  -d '{"symbolA":"ETH","symbolB":"BTC","strategyId":"ou-bertram","beta":18.0,"params":{"ouWindow":90},"capitalUsdc":50000}' | jq
```

### Execution modes
`EXECUTION_MODE`: `mock` (synthetic) · `paper`/`canary` (`PaperVenue`: real prices +
simulated fills) · `live` (real venue, requires `LIVE_TRADING_ARMED=true`).
`FEED_SOURCE`: `binance` (real public REST, no key) · `mock`. The `live` posture is an
engineering seam only — **real-money deployment is out of scope for the foreseeable
future** (the mission is paper-only); there is no business/KYB gate either way.

## Test

```bash
npm test
```

The DB-backed suites (`*.int-spec.ts`) auto-skip when Postgres is not reachable; set `MERIDIAN_DB_TESTS=off` to skip them explicitly. (Pure-unit specs run anywhere — see CLAUDE.md §10.)

## Architecture

Modular monolith — one repo, one Postgres, one ordered migration history. Every external integration sits behind a swap-seam interface (a mock and a real impl, selected by config), so the engine is testable offline and paper-tradable without ceremony. The repo is **self-contained** — no cross-repo coupling.

The binding rules and the maintained file map live in [`CLAUDE.md`](CLAUDE.md): §6 architecture, §7 execution modes & swap seams, §8 session log, §9 file map. Per-session history is in [`docs/SESSION_HISTORY.md`](docs/SESSION_HISTORY.md).
