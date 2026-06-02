# CLAUDE.md — Meridian Markets

## 0. Git Workflow (READ FIRST — binding)

The real repo is **`/home/nexus/code/meridian-markets`**. The harness's `.claude/worktrees/<name>` checkout is disposable — never deliver only there.

Every session MUST:
1. Work directly in this repo. Do **not** create per-session branches; the harness `claude/*` worktree branch is auto-disposable.
2. **End the session by committing** the work on `master` (one coherent commit, `Co-Authored-By` trailer). Never leave a session with uncommitted deliverables.
3. To ship: push a single well-named feature branch from `master` and open a PR. One PR branch per change set — not orphans.
4. Branches are disposable; commits/tags are forever. Before deleting any branch with unique commits, `git tag archive/<name> <branch>` first so nothing is lost.
5. `.claude/` is git-ignored. Never `git add` it.

**NEVER touch `/home/nexus/code/meridian` (Lira-Bridge) from this repo.** They are deliberately separate filesystems, deliberately separate databases, deliberately separate deploys. The only sanctioned coupling is the `ITreasuryClient` HTTP contract documented in [docs/INTEGRATION_WITH_LIRA_BRIDGE.md](docs/INTEGRATION_WITH_LIRA_BRIDGE.md).

## 1. Project Overview

Meridian Markets is a **stat-arb trading engine** (with a treasury/yield module alongside). The product is the engine — a market-data spine, a signal/risk library, an execution path, and a live event loop — not the web dashboard, which is a thin read-only view over the engine.

The engine runs in three execution postures, selected by `EXECUTION_MODE` + `FEED_SOURCE` (no business/legal gate is involved — these are engineering switches):

- **mock** — synthetic feed + synthetic venue. Offline, deterministic; for unit tests and the demo.
- **paper** — **real** market data (Binance public REST, no API key) + `PaperVenue` (simulates fills at real prices). This is real paper trading: `FEED_SOURCE=binance EXECUTION_MODE=paper LIVE_AUTOSTART=true`. See [docs/PAPER_TRADING.md](docs/PAPER_TRADING.md).
- **canary / live** — routes (some/all) flow to a real venue. Fronted by an *engineering* arm switch (`LIVE_TRADING_ARMED=true`), set only once a real venue adapter is wired and a testnet round-trip passes. Real-money go/no-go is a human decision made outside the code; the code never assumes it.

A separate treasury/yield module earns yield on Lira-Bridge's first-party reserve USDC over the `ITreasuryClient` HTTP contract — see [docs/INTEGRATION_WITH_LIRA_BRIDGE.md](docs/INTEGRATION_WITH_LIRA_BRIDGE.md).

## 2. Tech Stack

- Runtime: Node.js 20, NestJS 10, TypeScript (strict mode, CommonJS) — mirrors Lira-Bridge.
- Database: PostgreSQL 16 via TypeORM 0.3 (raw SQL migrations; no entity decorators).
- Config: `@nestjs/config` with typed `AppConfig` interface, reads from `.env`.
- Secrets: `ISecretProvider` interface — `EnvSecretProvider` in dev; swap a Vault impl in prod without touching other code.
- Containerisation: Docker Compose (`postgres` on port **5433** — Lira-Bridge owns 5432).

## 3. DB Tables

| Table | Key invariants |
|---|---|
| `treasury_movements` | Append-only — `meridian_markets_app` role has `SELECT, INSERT` only (no UPDATE/DELETE). `chk_amount_positive` enforces `> 0`. `(provider, idempotency_key)` UNIQUE for replay safety. `(provider, created_at::date) WHERE direction='YIELD_ACCRUAL'` UNIQUE for cron idempotency. |
| `treasury_positions` | Mutable cache. `(provider)` PK. `SELECT, INSERT, UPDATE` for the app role; no DELETE. Derivable from `treasury_movements` if ever lost. |

USDC has **6 decimals**. `1 USDC = 1_000_000 units`. All `*_units` columns store 6-decimal integer units (BIGINT). Same convention as Lira-Bridge — never store 18-decimal ETH wei here.

## 4. Movement Directions

- `DEPOSIT` — principal flowed into the yield provider.
- `WITHDRAW` — principal pulled out.
- `YIELD_ACCRUAL` — provider reports more yield than we've recorded; this row crystallises the delta. Capped at one per provider per day by a unique partial index.

## 5. Cross-Service Contract

The single sanctioned coupling with Lira-Bridge is the HTTP `ITreasuryClient` contract documented in [docs/INTEGRATION_WITH_LIRA_BRIDGE.md](docs/INTEGRATION_WITH_LIRA_BRIDGE.md). Endpoints:

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/treasury/deposit` | Place reserve float into the yield provider |
| `POST` | `/api/treasury/withdraw` | Pull principal back out for redemption |
| `GET`  | `/api/treasury/position` | Current principal + accumulated yield |
| `GET`  | `/api/treasury/yield-earned` | Yield-only convenience read |

All routes are guarded by `x-meridian-client-key` (shared secret, v1). Replace with mTLS or signed JWT before either side handles real money — flagged in the integration doc as a future hardening step.

## 6. Architecture: modular monolith (binding)

This is a **binding decision**, not a preference. Do not re-litigate it without an explicit, written reason that addresses the rationale below — same posture as Lira-Bridge §10h.

- **NO microservices inside this repo.** The correctness model is append-only tables + Postgres `SERIALIZABLE`. That guarantee only holds against a single DB in a single service.
- **NO polyrepo. NO database-per-service. NO split migration sequence.** One repo, one DB, one ordered migration history.
- **Meridian Markets and Lira-Bridge ARE two separate services** — that's the point of this whole repo existing. They talk only over HTTP, only through the `ITreasuryClient` contract. No shared DB. No cross-repo imports. No shared types. If you ever want a shared type, copy it.
- **`process.env` is read in exactly one place: `src/config/app-config.factory.ts`.** Everything else uses injected `AppConfig` or `ISecretProvider.get()`. (Tests under `src/test-helpers/` are the only other exception, scoped to test setup.)

## 7. Execution modes & the swap seams (binding)

Every external integration sits behind an interface with a real and a mock implementation, selected by config. This is an **engineering** discipline (so the engine is testable offline and paper-tradable without ceremony), not a business gate.

- **Market data** — `IBarFeed` / `IPriceSource`. `FEED_SOURCE=binance` uses real Binance **public** REST (no API key, no account). `FEED_SOURCE=mock` is the synthetic generator. Default `mock` so tests run offline; flip to `binance` to trade live data.
- **Trading venue** — `ITradingVenue`, selected by `EXECUTION_MODE`: `mock` (synthetic) → `paper`/`canary` (`PaperVenue`, real prices + simulated fills) → `live` (real venue adapter).
- **Real-money arming** — `canary`/`live` require `LIVE_TRADING_ARMED=true`, enforced by `ExecutionModeBootGuard` at boot. Arm it once a real venue adapter is wired and a testnet round-trip passes. `paper` requires nothing.
- **Treasury yield** — `IYieldProvider`: `MockYieldProvider` (default) vs `RealOndoYieldProvider` (throws until `ONDO_*` secrets are populated and `MOCK_YIELD_ENABLED=false`). Same pattern — ship the stub, wire the real adapter when its credentials exist.

When adding any new venue/provider: implement the interface, register it in the module factory, leave the safe default on. **Paper trading is a first-class supported mode — `FEED_SOURCE=binance EXECUTION_MODE=paper` paper-trades live data today** (see [docs/PAPER_TRADING.md](docs/PAPER_TRADING.md)).

## 8. Session Log

Full per-session log in [docs/SESSION_HISTORY.md](docs/SESSION_HISTORY.md). Current state (as of 2026-06-01):

- **Done (through Sessions 17–18 + 10):** the engine signal/risk/backtest/execution libraries (Sessions 1–16, 560 tests), the **real market-data spine + live paper loop** (S17), **real-history backfill + real-data backtest** (S18 backend), the **live multi-asset surface** — asset-class market presets, real-data pair discovery, candles, live pair/capital switching (S18), the **multi-currency portfolio** — N pairs trading concurrently on live Binance, isolated paper books, even capital split (S10), and a **rewritten `/demo` live Trading Desk console** (synthetic personas + KYB/Phase/investor-disclosure theater removed). Course (`courses/stat-arb`) extended to chs 8 (more strategies) + 9 (testing in Meridian). Verified live: `scripts/smoke-live-multi-asset.ts` runs the full path against real Binance.
- **Done (S19 — automated market-making desk + fee discipline):** `src/market-making/` runs MM books **next to** the stat-arb portfolio. SymmetricQuoter / AvellanedaStoikovQuoter / GlftQuoter (all `IQuoter`), `InventoryBook` (avg-cost P&L), `VpinEstimator` + `CompositeRiskGate` (Allow/Deny/**Pause**), `MmBacktestRunner` + 4-component `PnlAttributor` + `SimpleQueueModel` (honest queue scaffold), `MmStrategyRegistry`, stablecoin/FX `mm-market-presets`, live `MmBook`/`MmPortfolioTrader` + `/api/market-making` control plane (`MarketMakingModule`, imported once into `AppModule`). New stat-arb `stablecoin-peg` preset. **Fees are now in the entry decision, not just P&L:** z-score pairs strategies carry a fee-aware gate (`signal/fee-gate.ts`, registry default 5 bps × 1.5), MM has a maker break-even spread floor. Verified live: `scripts/smoke-mm-stablecoin.ts` (DB-free). 101 suites / 673 tests. See [docs/MARKET_MAKING.md](docs/MARKET_MAKING.md).
- **Done (S20 — Research-tab realignment + reference data sources):** rebuilt the `/demo` **Research** tab into the *scan → asset-classes → trade* flow: **⊹ Scan all source data** sweeps every asset class at once (`/api/opportunities` + `/api/market-making/screen`), results **grouped by asset class** with a cross-class "fits the model" rollup; the standalone Scanner tab is folded in. Retired the legacy single-book path — **every "trade" launches a portfolio station** (one mental model). Wired the previously-dead **FLATTEN ALL**, added **per-station ✕ remove** on stat-arb cards, and made **Trade-top-N append** (no silent portfolio wipe). Surfaced the **robustness tools** (walk-forward/sweep/Monte-Carlo, `/api/stat-arb/research/*`) with a synthetic-feed caveat. New **FX (EUR stables)** stat-arb preset. **TESSERA reference-data adapters** (`src/market-data/reference/`): `PythBenchmarksClient` (true FX OHLC via the TradingView shim — scannable), `DefiLlamaPegClient`, `Bit2CClient` — one `IReferenceBarSource`, injected HTTP, public/no-key; `ReferenceSourceRegistry` + `makeScannerLoader` route the scanner per source; new `fx-pyth` reference preset; `GET /api/market-data/reference[/sources]` + a UI "data sources wired" readout. Reference-source pairs are **tradeable on the live loop** via a per-source feed (`ReferenceBarFeed`/`ReferencePriceSource`/`warmupFromReference`, selected by `PortfolioPair.source`); each Live-books card shows its `feedId`. 111 suites / 714 tests. See [docs/RESEARCH_TAB_REALIGNMENT_PLAN.md](docs/RESEARCH_TAB_REALIGNMENT_PLAN.md).
- **Done (S21 — quant desk: research harness, sizing truth, sim-fidelity, single desk lot):** `scripts/quant-research.ts` (DB-free) sweeps **asset-class × strategy × entry-z × bar-interval** on live Binance, ranked net-of-fee, + a sizing study; results in `docs/research/*.json`. New strategies in the registry (`pairs-zscore-selective/-wide`, `pairs-ewma-conviction`, `ou-bertram-throttled`); the registry spec is **structural**. **Sizing truth:** `POST /api/market-data/sizing-study` + UI proves size is a *risk* lever (net edge in bps/Sharpe are size-invariant under flat fees), capped by the impact-optimal **N\*** (∝ N²). **P0.1 sim-fidelity:** `HistoricalReplayVenue` now charges **half-spread + linear market impact (λ·notional/ADV)** on every fill (on for the harness + `/api/market-data/backtest`) — and it *flips the rankings* (thin-leg "winners" die; liquid alt-dispersion survives). **Lotting:** `notionalUnits` threads through the portfolio factory so the capital input actually sizes trades; the top-strip **Lots / leg (USDC)** is the single sizing master for **every** trade button (scan, Signal, ⚖ Size, Trade-top-N, Launch cockpit, MM books — panels mirror it + override per-launch). Durable session equity (localStorage) + connection-health heartbeat. Docs: [docs/QUANT_ROLE.md](docs/QUANT_ROLE.md), [docs/QUANT_JOURNAL.md](docs/QUANT_JOURNAL.md), [docs/PRODUCTION_READINESS.md](docs/PRODUCTION_READINESS.md). 111 suites / 717 tests.
- **Run it:** stat-arb: `FEED_SOURCE=binance EXECUTION_MODE=paper MOCK_TRADING_ENABLED=false npm run start:dev` → `/demo` + `/api/stat-arb/live/*`; MM books on the same process at `/api/market-making/*`. Quant research loop: `npx ts-node -r tsconfig-paths/register scripts/quant-research.ts`. Real-money is the `EXECUTION_MODE=live` + `LIVE_TRADING_ARMED=true` engineering decision — no business/KYB gate in the engine. **Equities (S24, paper on Alpaca):** set `ALPACA_KEY_ID`/`ALPACA_SECRET` then `FEED_SOURCE=alpaca EXECUTION_MODE=paper MOCK_TRADING_ENABLED=false npm run start:dev`; thesis test: `STAB_SOURCE=alpaca STAB_PRESETS=equity-banks,equity-megacap-tech npx ts-node -r tsconfig-paths/register scripts/cointegration-stability.ts`.
- **Done (S22 — real-history OOS gate, P0.2+P0.3+P0.5, desk roles):** the `walkForward` harness is slice/train-aware (`venueFactory(barsA,barsB)`; `strategyFactory(trainCtx)`). **P0.2:** `POST /api/market-data/walk-forward` runs a pair over **real Binance history**, **β re-fit per train window** (Engle-Granger), judged OOS net of fee+spread+impact; returns `sharpeDegradation` + β-per-window. **P0.3 (multiple-testing):** `research/deflated-sharpe.ts` (PSR + Deflated Sharpe over `trials`) + `purged-kfold.ts` (CV w/ purge+embargo) + `cross-validate.ts`; the gate's `multipleTesting` block gates **PASS = DSR ≥ 0.95 & ≥ 20 OOS trades** (also a `cv:'purged-kfold'` scheme). **P0.5:** `coverage` block (days/bars/splits + thin-history warnings + survivorship caveat). Surfaced in Research as **↻ Walk-forward / ⊟ Purged k-fold (real OOS)** with a verdict readout. **Desk-scale lots:** synthetic research + `/backtest` + `/walk-forward` default to **$100k/leg** (no $1 toy moves). **Flag closed:** `scripts/oos-candidates.ts` ran the gate on 30d real history → **ai-data z-score candidate KILLED** (too few OOS trades + selection haircut; Journal #4). **Desk roles + skills:** `desk/` (root) now has `ROLE_strategy_developer.md` + `ROLE_market_data_researcher.md` + `README.md` (agentic primer) + `SESSION_NOTES_2026-06-01.md`, with `/strategy-developer` + `/market-data-researcher` skills. 114 suites / 751 tests.
- **Done (S23 — the pivot: MM is the live earner; stat-arb library → total rewrite):** stat-arb stalled *structurally* (cointegration cliff + fee drag; the gate kills every survivor — Journal #4/#5), so the desk **pivoted to market-making as the live earner** and wrote the brief for a strategy-library rewrite. **`scripts/mm-paper-session.ts`** (new, DB-free, real Binance) drives the live `MmBook` + registry unchanged at **desk scale** ($50k/quote, $1M/book, 8-lot cap) over a long horizon, two modes (**replay** real history now / **live**-poll for hours), with an honest **fee sweep** — net at −1bps (VIP rebate), **0bps (structural = spread − adverse)**, +1bps (retail cost) — and conservation judged on the **structural** equity curve. **Result (24h GLFT replay, FDUSD/USDC/TUSD):** structural net **positive + monotone across all 12 buckets**, desk **max DD ~0.001%** at $400k max inventory — *stable profit, large lots, equity conserved*. **Catch:** at +1bps retail maker cost the book loses, so **deploy needs a ≤0bps maker venue** + queue-aware fills (current fills are fill-on-touch = upper bound). **Rewrite brief:** [docs/STRATEGY_LIBRARY_REWRITE.md](docs/STRATEGY_LIBRARY_REWRITE.md) — generalise `IStrategy` (2-leg → N-leg, instrument-typed), add an `IOptionPricer`/**Greeks** layer (BS + Bachelier, Deribit IV) + a Greeks-budget gate + carry/funding in the cost model, behind the **unchanged validation gate**; ranked strategy menu; **build funding-rate carry first** (no new venue). Strategy Developer hat updated to point at it. 118 suites / 785 tests (harness is additive, no `src` logic change). See Journal #6 + [docs/MARKET_MAKING.md](docs/MARKET_MAKING.md) §1.5.
- **Done (S24 — equities pivot, Phase 1: Alpaca paper-trading adapters):** the *other* answer to the cointegration cliff (Journal #5) — crypto cointegration is a short-window artifact, but **same-sector equities are *structurally* cointegrated** (shared cash-flow drivers). Runs **alongside** the S23 MM book; this is the new asset class for the stat-arb engine. Built entirely behind the existing swap seams (§7) — **only the feed + venue are new**; signals, OOS gate, sizing, scanner, risk, live loop reused unchanged. `src/stat-arb/feed/alpaca/`: `AlpacaDataClient` (auth'd Market-Data v2, **`adjustment=all`** split/div-adjusted, `next_page_token` pagination, interval→Alpaca-timeframe map), `AlpacaBarFeed` + `AlpacaPriceSource` (RTH-aware — equities aren't 24/7), `AlpacaPaperVenue` (real Alpaca **paper** order API; whole-share `qty` so the short leg is shortable; commission-free ⇒ fees=0). `FEED_SOURCE=alpaca` config + factory wiring (feed/price/venue/warmup); Binance left default. **8 `EQUITY_PRESETS`** (banks, energy, rails, megacap-tech, payments, staples, pharma, semis), kept *separate* from `MARKET_PRESETS` so the Binance scanner never fetches a ticker. **P0.4 short-borrow carry shipped** in `HistoricalReplayVenue` (`borrowBpsPerYear` × hold-duration on the short leg, into fees; default 0 = back-compat) — equities stat-arb lives or dies on this. `scripts/cointegration-stability.ts STAB_SOURCE=alpaca` runs the **thesis test** (do equity baskets hold cointegration at 90/180d where crypto went to 0?). Offline-verified: **118 suites / 792 tests**. The live thesis run + paper-trade need an Alpaca paper key (**hand-off**); the persistence verdict → **Journal #7**. See [docs/EQUITIES_STATARB_PLAN.md](docs/EQUITIES_STATARB_PLAN.md).
- **Done (S25 — equities Phase 2 plumbing: OOS gate + scanner on Alpaca, offline):** the two remaining offline seams from the S24 pivot, so the whole equities path is one Alpaca key away from running. **(1) OOS gate → Alpaca:** `scripts/oos-candidates.ts` gained `OOS_SOURCE=alpaca` (mirrors `cointegration-stability.ts`) — routes the real-history walk-forward + deflated-Sharpe gate to the Alpaca client + `EQUITY_PRESETS` (`getAnyPreset`), with **equity-aware cost defaults**: fee **0bps** (commission-free), **1bps** half-spread, and **short-borrow carry ON** (`OOS_BORROW_BPS_YEAR`, 50bps/yr easy-to-borrow default) threaded into `HistoricalReplayVenue` (P0.4) with `barSeconds` from the interval. Same gate, same PASS/INSUFFICIENT/NOISE verdict — only the source switched. **(2) Scanner → equities:** `makeScannerLoader` gained an `'alpaca'` branch and the `OpportunityScanner` factory appends `EQUITY_PRESETS` (source `'alpaca'`) **key-gated** on `app.alpaca.keyId` — a no-key deploy scans exactly as before (no 401 churn); with a key, equities join the cross-asset board. *Caveat documented:* the scanner is intraday-tuned, a coarse first look; the structural verdict is the stability + OOS scripts. Pure swap-seam additions — no live-loop change (S24 already wired feed/price/venue/warmup). Offline-verified: **120 suites / 803 tests** (+2 scanner-loader specs; the +2 suites vs S24 are the parallel MM funding session's). The live thesis run + OOS run + paper-trade still need an Alpaca paper key (**hand-off** — run commands in the plan doc); verdict → **Journal #7**. See [docs/EQUITIES_STATARB_PLAN.md](docs/EQUITIES_STATARB_PLAN.md).
- **Next (P0 frontier — per [docs/PRODUCTION_READINESS.md](docs/PRODUCTION_READINESS.md)):** ✅ P0.1 costs, P0.2 OOS, P0.3 multiple-testing all **DONE** and the gate has earned its keep. The binding gap is now **data, not method**: **P0.5 more history** (backfill 6–12 months — OOS *trade count* is what killed the candidate) + a point-in-time universe (survivorship); **P0.4 borrow/funding on the short leg** (deferred). Discovery: a **Market Data Researcher** role to wire **DEX / decentralized sources** (GeckoTerminal first) via the `IReferenceBarSource` seam — widen the universe. Then **P1 (real capital):** risk-parity allocator on the live path, maker/limit execution (reuse `src/market-making/`), real-venue adapter + reconciliation, restart-safe live books. Also open: cross-source pairing, funding-carry + cross-sectional baskets (course §8), L2 ingest → `LobReplayHarness`, WebSocket feed, Johansen.

## 9. Key File Map

```
src/
  main.ts                              Nest bootstrap on :3100
  app.module.ts                        wires ConfigModule, SecretsModule, DatabaseModule, TreasuryModule
  config/
    app-config.interface.ts            typed AppConfig
    app-config.factory.ts              the ONLY sanctioned process.env reader
    config.module.ts
  secrets/
    secret-provider.interface.ts       ISecretProvider + SECRET_PROVIDER token
    env-secret.provider.ts             EnvSecretProvider (vault swap point)
    secrets.module.ts                  @Global
  database/
    db.service.ts                      runInSerializableTransaction (retry-once-on-40001)
    database.module.ts                 @Global; connects as meridian_markets_app role
  yield/
    yield-provider.interface.ts        IYieldProvider + types + errors
    mock-yield-provider.ts             deterministic; default
    real-ondo-yield-provider.ts        dormant; KYB-gated
    yield.module.ts                    factory selects mock vs real
  treasury/
    treasury.service.ts                append-only ledger, idempotency, SERIALIZABLE
    treasury.controller.ts             /api/treasury/* HTTP surface
    treasury-client.guard.ts           x-meridian-client-key guard
    treasury.errors.ts                 InvalidAmountError, InsufficientPrincipalError
    yield-sync.cron.ts                 periodic provider reconciliation
    treasury.module.ts
  test-helpers/
    postgres-available.ts              describeIfDb helper + DB probe
migrations/
  1715000000000-Initial.ts             treasury_movements + treasury_positions + role
database/
  data-source.ts                       TypeORM CLI DataSource (privileged)
docker-compose.yml                     Postgres 16 on :5433
```

## 10. Test discipline

- Pure-unit specs: `*.spec.ts` — run anywhere, no DB.
- Integration specs: `*.int-spec.ts` — require Postgres on `:5433`. Auto-skip via `describeIfDb` when the DB is unreachable; failing the assertion would be a worse experience than a silent skip during local iteration. CI MUST start Postgres before invoking `npm test` so the integration suites actually fire.
- 51 tests across 9 suites today. New surfaces add specs in the same shape.

## 11. SecretProvider Contract

`SecretProvider` interface is the Vault swap point. `EnvSecretProvider` reads `process.env`. No other module may access `process.env` directly — all secret reads go through `ISecretProvider.get()`. The `SECRET_PROVIDER` token is provided globally by `SecretsModule` (imported in `AppModule`).
