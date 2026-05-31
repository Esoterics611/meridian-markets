# Meridian Markets

> Sister entity to [Lira-Bridge](https://github.com/vanguard-dao/meridian) (`~/code/meridian`). The yield / treasury / markets arm. The legal name is a working alias; the real one lands at Phase 2 (entity formation).

**Status:** Phase 0 implementation — treasury yield service, mock-default, KYB-gated for real Ondo USDY.

Planning context: [`PHASED_PLAN.md`](PHASED_PLAN.md). The 1-pager that explains *why* this is a separate repo / DB / deploy lives in the same file's preamble and in [`docs/INTEGRATION_WITH_LIRA_BRIDGE.md`](docs/INTEGRATION_WITH_LIRA_BRIDGE.md).

---

## What this service does

A standalone NestJS service that earns yield on Lira-Bridge's idle Path C reserve-pool USDC.

- Exposes `IYieldProvider` — the swap interface. One concrete impl ships in Phase 0:
  - `MockYieldProvider` — deterministic, no network. **Default.**
  - `RealOndoYieldProvider` — Ondo USDY stub. Dormant until `MOCK_YIELD_ENABLED=false` and KYB completes.
- Records every deposit / withdraw / yield-accrual in **append-only** `treasury_movements`. The runtime DB role (`meridian_markets_app`) has `SELECT, INSERT` only — UPDATE/DELETE are revoked at the privilege layer.
- Exposes a thin internal HTTP API (`/api/treasury/*`) authenticated by a shared-secret header `x-meridian-client-key`. This is the `ITreasuryClient` contract Lira-Bridge will eventually call.
- Reconciles against the yield provider every 5 minutes via `YieldSyncCron`, writing a `YIELD_ACCRUAL` movement when the provider has appreciated.

Customer money never touches this service. Phase 4 (3(c)(7) fund) is where that frame changes — see [`PHASED_PLAN.md`](PHASED_PLAN.md).

## Why it must be separate from Lira-Bridge

Payments licenses (MTL / EMI / CMA money-services-business) are conditioned on **not** trading principally with customer funds and **not** offering investments. Stapling yield, hedging-for-customers, or any investment product into Lira-Bridge breaks the licensing pathway it's currently pursuing (CU-05 / CU-07). Putting them in a sister entity that *buys services from* Lira-Bridge (e.g., "manage our reserve float") and *sells products to* Lira-Bridge customers who opt in keeps the regulated surfaces clean.

Cap tables are also priced differently — payments is a unit-economics game (Wise multiples), markets/fund is a fee-on-AUM game (Brevan / Citadel multiples). Investors price them differently; let each raise from its natural buyer.

## Run it locally

```bash
# 1. Install deps.
npm install

# 2. Start Postgres on port 5433 (Lira-Bridge owns 5432).
docker compose up -d postgres

# 3. Configure secrets.
cp .env.example .env
# Then run migrations as the privileged role:
npm run migration:run

# 4. Run the service.
npm run start:dev
```

Default port is `3100` (Lira-Bridge uses `3000`).

### Smoke-test the API

```bash
KEY=dev-meridian-client-key-change-me

# Deposit 100 USDC (6-decimal units).
curl -X POST http://localhost:3100/api/treasury/deposit \
  -H "x-meridian-client-key: $KEY" \
  -H "Content-Type: application/json" \
  -d '{"amount_usdc_units": "100000000", "idempotency_key": "smoke-1"}'

# Read position.
curl http://localhost:3100/api/treasury/position \
  -H "x-meridian-client-key: $KEY"
```

## The live trading desk — run the quant engine & watch paper trades

Meridian is also a **stat-arb trading engine** (CLAUDE.md §1 — the engine *is* the
product; the dashboard is a thin view over it). The "trader" is a background event
loop (`LivePaperTrader`, and the multi-book `LivePortfolioTrader`): each tick it
pulls the next closed 1-minute bar for both legs of a pair from **real Binance
public data**, runs the chosen strategy, and routes orders to `PaperVenue` (fills
at the real ticker, taker fee modelled). Closed round-trips persist to
`stat_arb_trades`. No API key, no account, no real money — paper predicts live
because only the injected venue changes.

A **human** drives it from the `/demo` cockpit (this is not AI — *you* launch the
strategies) or the terminal control plane. Deeper design:
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
`FEED_SOURCE`: `binance` (real public REST, no key) · `mock`. Real money is an
engineering arm switch taken by a human — there is **no** business/KYB gate in the
trading engine.

## Test

```bash
npm test
```

51 tests across 9 suites. The DB-backed suites (`*.int-spec.ts`) auto-skip when Postgres is not reachable; set `MERIDIAN_DB_TESTS=off` to skip them explicitly.

## Phased build

| Phase | What ships | License/cap need | When |
|---|---|---|---|
| **0 — Treasury yield service** | `IYieldProvider` + integrations (BUIDL, Ondo USDY, Maker sDAI). Manages first-party Lira-Bridge Path C float only. No customer money. | None | **This repo, now** |
| **1 — On-chain FX hedge module** | Auto-hedges Path C ILS exposure via on-chain perps (Drift / Hyperliquid). First-party only. | None for first-party | After Phase 0 — ~2–3 sessions |
| **2 — Markets Co. legal formation** | Delaware C-corp + Cayman SPC for future fund vehicles. CCO hire. Counsel opinion on RIA exemption. | $200–300k setup | Months 3–6. Business work; no code. |
| **3 — Prop desk (own capital only)** | Quant infra: market-data ingest, signal store, execution router, risk module. Trades own treasury. No customer money. Builds the track record. | None for own-capital spot; CFTC if futures | Months 6–12 |
| **4 — 3(c)(7) crypto fund for accredited Lira-Bridge members** | NAV calc, subscription/redemption portal, fund admin integration. Opt-in from Lira-Bridge UI. | SEC RIA + accredited verification | Year 2 — requires 1yr of Phase 3 track record |
| **5 — Derivatives venue (optional)** | Permissioned perps DEX or NFA-registered FX dealer | NFA FDM (~$20M net cap) or ISA license | Year 3+. Probably never if 0–4 work. |

Per-phase deep dive: [`PHASED_PLAN.md`](PHASED_PLAN.md).

## Architecture posture

- **Mirror Lira-Bridge.** NestJS 10 + TypeScript strict (CommonJS) + Postgres 16 + TypeORM 0.3 (raw SQL migrations, no entity decorators) + `ISecretProvider` for vault swap-point + mock-default for external integrations. Not re-litigated.
- **Modular monolith, not microservices.** Same rationale as Lira-Bridge §10h. The two services talk over HTTP and only over HTTP — no shared DB, no cross-imports, no shared types.
- **Append-only treasury ledger.** `treasury_movements` is privilege-locked. The runtime app role cannot UPDATE or DELETE — only the migration role can, and only forward-migrations should ever touch it.
- **Mock-default for external integrations.** Real Ondo calls are KYB-gated and refuse to fire until `MOCK_YIELD_ENABLED=false`.

## Layout

```
meridian-markets/
  README.md                              ← this file
  CLAUDE.md                              ← session-binding architecture rules
  PHASED_PLAN.md                         ← per-phase deep dive
  docker-compose.yml                     ← Postgres on :5433
  package.json  tsconfig.json  nest-cli.json
  database/
    data-source.ts                       ← TypeORM CLI DataSource (privileged role)
  migrations/
    1715000000000-Initial.ts             ← treasury_movements + treasury_positions + meridian_markets_app role
  src/
    main.ts                              ← Nest bootstrap on :3100
    app.module.ts
    config/                              ← typed AppConfig (sole reader of process.env)
    secrets/                             ← ISecretProvider + EnvSecretProvider
    database/                            ← DbService (SERIALIZABLE + retry-once-on-40001)
    yield/
      yield-provider.interface.ts        ← IYieldProvider + types + errors
      mock-yield-provider.ts             ← default; deterministic
      real-ondo-yield-provider.ts        ← dormant Phase 0 stub
      yield.module.ts                    ← factory selects mock vs real
    treasury/
      treasury.service.ts                ← append-only ledger + idempotency
      treasury.controller.ts             ← /api/treasury/* endpoints
      treasury-client.guard.ts           ← x-meridian-client-key guard
      yield-sync.cron.ts                 ← periodic provider reconciliation
      treasury.module.ts
    test-helpers/
      postgres-available.ts              ← describeIfDb + DB probe for int specs
  docs/
    SESSION_HISTORY.md                   ← per-session log
    INTEGRATION_WITH_LIRA_BRIDGE.md      ← the ITreasuryClient HTTP contract
  prompts/
    PHASE_0_PROMPT.md                    ← the spec this session implements
    LIRA_BRIDGE_PROD_READY_PROMPT.md     ← parallel-track prompt
```
