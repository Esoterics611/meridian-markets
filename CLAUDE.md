# CLAUDE.md — Meridian Markets

## 0. Git Workflow (READ FIRST — binding)

The real repo is **`/home/nexus/code/meridian-markets`**. The harness's `.claude/worktrees/<name>` checkout is disposable — never deliver only there.

Every session MUST:
1. Work directly in this repo. Do **not** create per-session branches; the harness `claude/*` worktree branch is auto-disposable.
2. **End the session by committing** the work on `master` (one coherent commit, `Co-Authored-By` trailer). Never leave a session with uncommitted deliverables.
3. To ship: push a single well-named feature branch from `master` and open a PR. One PR branch per change set — not orphans.
4. Branches are disposable; commits/tags are forever. Before deleting any branch with unique commits, `git tag archive/<name> <branch>` first so nothing is lost.
5. `.claude/` is git-ignored. Never `git add` it.

**This repo is self-contained.** It has no external-service integration and no cross-repo coupling — work only inside `/home/nexus/code/meridian-markets`, never reach into a sibling repo. (The former Lira-Bridge treasury integration has been **retired** — see §5.)

## 1. Project Overview

> **Mission (binding — set 2026-06-03):** Meridian is a **paper-trading demonstration of an AI-agent-run quant desk**. Several strategies run concurrently, each manned by a quant agent, and the goal is to **minimize drawdown and show steady, conserved returns over hours and days** of live *paper* trading on real market data. **We are paper-only for the foreseeable future** — there is **no real-capital / production deployment on the roadmap**, and the "production-readiness / real-money" framing is **parked, not pursued** (the `canary`/`live` postures below remain as engineering seams, not goals). Two engines drive the demo: **crypto market-making** (the steady, low-drawdown earner) and **equities stat-arb** (a thin but uncorrelated diversifier). The frontier where the edge actually grows is **market discovery — new, especially DEX / decentralized / anonymous markets** to make markets in. Because it's a demonstration, **honesty about the numbers is the entire game**: a demo that reports inflated returns is worthless, so the OOS / survivorship / cost gates exist to keep the paper P&L truthful, not to clear a deploy.

Meridian Markets is a **stat-arb trading engine** (plus an automated market-making desk; see §8). The product is the engine — a market-data spine, a signal/risk library, an execution path, and a live event loop — not the web dashboard, which is a thin read-only view over the engine. (Historically the README called the engine "the product"; under the mission above the *deliverable* is the **paper-trading demonstration** the engine produces.)

The engine runs in three execution postures, selected by `EXECUTION_MODE` + `FEED_SOURCE` (no business/legal gate is involved — these are engineering switches):

- **mock** — synthetic feed + synthetic venue. Offline, deterministic; for unit tests and the demo.
- **paper** — **real** market data (Binance public REST, no API key) + `PaperVenue` (simulates fills at real prices). This is real paper trading: `FEED_SOURCE=binance EXECUTION_MODE=paper LIVE_AUTOSTART=true`. **This is the mode we run** — the whole demo lives here. See [docs/PAPER_TRADING.md](docs/PAPER_TRADING.md).
- **canary / live** — routes (some/all) flow to a real venue. **Out of scope for the foreseeable future** (the mission is paper-only). The seam is left intact — fronted by an *engineering* arm switch (`LIVE_TRADING_ARMED=true`) — so the architecture stays honest, but wiring a real venue is **not** a current goal and no work should assume it.

> **Legacy:** the repo also still contains a treasury/yield module (`src/treasury/`, `src/yield/`, the `treasury_*` tables). It was built to earn yield on an external service's reserve USDC over an HTTP contract; **that integration is retired** and the module is dormant. It is left in place (not deleted) but is not part of the product — ignore it unless explicitly asked. See §5.

## 2. Tech Stack

- Runtime: Node.js 20, NestJS 10, TypeScript (strict mode, CommonJS).
- Database: PostgreSQL 16 via TypeORM 0.3 (raw SQL migrations; no entity decorators).
- Config: `@nestjs/config` with typed `AppConfig` interface, reads from `.env`.
- Secrets: `ISecretProvider` interface — `EnvSecretProvider` in dev; swap a Vault impl in prod without touching other code.
- Containerisation: Docker Compose (`postgres` on port **5433**).

## 3. DB Tables

> These tables belong to the **legacy (dormant) treasury module** (§1, §5). The trading engine itself runs paper/live in-memory and does not depend on them. They are documented here because the migration still creates them.

| Table | Key invariants |
|---|---|
| `treasury_movements` | Append-only — `meridian_markets_app` role has `SELECT, INSERT` only (no UPDATE/DELETE). `chk_amount_positive` enforces `> 0`. `(provider, idempotency_key)` UNIQUE for replay safety. `(provider, created_at::date) WHERE direction='YIELD_ACCRUAL'` UNIQUE for cron idempotency. |
| `treasury_positions` | Mutable cache. `(provider)` PK. `SELECT, INSERT, UPDATE` for the app role; no DELETE. Derivable from `treasury_movements` if ever lost. |

USDC has **6 decimals**. `1 USDC = 1_000_000 units`. All `*_units` columns store 6-decimal integer units (BIGINT) — never store 18-decimal ETH wei here.

## 4. Movement Directions (legacy treasury module)

- `DEPOSIT` — principal flowed into the yield provider.
- `WITHDRAW` — principal pulled out.
- `YIELD_ACCRUAL` — provider reports more yield than we've recorded; this row crystallises the delta. Capped at one per provider per day by a unique partial index.

## 5. Cross-Service Contract — RETIRED

Meridian Markets used to expose an HTTP treasury contract (`ITreasuryClient`) for an external service (Lira-Bridge) to place reserve USDC into a yield provider. **That integration has been retired — there is no cross-service contract anymore.** This repo is self-contained (§0).

The `src/treasury/` code and the `/api/treasury/*` routes still exist as dormant legacy (§1) but are not consumed by anything and are not a supported surface. The historical spec lives in [docs/archive/INTEGRATION_WITH_LIRA_BRIDGE.md](docs/archive/INTEGRATION_WITH_LIRA_BRIDGE.md) for reference only. If the treasury module is ever fully removed, drop §3/§4 and the `1715000000000-Initial.ts` migration with it.

## 6. Architecture: modular monolith (binding)

This is a **binding decision**, not a preference. Do not re-litigate it without an explicit, written reason that addresses the rationale below.

- **NO microservices inside this repo.** The correctness model is append-only tables + Postgres `SERIALIZABLE`. That guarantee only holds against a single DB in a single service.
- **NO polyrepo. NO database-per-service. NO split migration sequence.** One repo, one DB, one ordered migration history.
- **Self-contained.** No cross-repo imports, no shared DB, no shared types with any other repo. If you ever want a type from elsewhere, copy it.
- **`process.env` is read in exactly one place: `src/config/app-config.factory.ts`.** Everything else uses injected `AppConfig` or `ISecretProvider.get()`. (Tests under `src/test-helpers/` are the only other exception, scoped to test setup.)

## 7. Execution modes & the swap seams (binding)

Every external integration sits behind an interface with a real and a mock implementation, selected by config. This is an **engineering** discipline (so the engine is testable offline and paper-tradable without ceremony), not a business gate.

- **Market data** — `IBarFeed` / `IPriceSource`. `FEED_SOURCE=binance` uses real Binance **public** REST (no API key, no account). `FEED_SOURCE=mock` is the synthetic generator. Default `mock` so tests run offline; flip to `binance` to trade live data.
- **Trading venue** — `ITradingVenue`, selected by `EXECUTION_MODE`: `mock` (synthetic) → `paper`/`canary` (`PaperVenue`, real prices + simulated fills) → `live` (real venue adapter).
- **Real-money arming** — `canary`/`live` require `LIVE_TRADING_ARMED=true`, enforced by `ExecutionModeBootGuard` at boot. Arm it once a real venue adapter is wired and a testnet round-trip passes. `paper` requires nothing.
- **Treasury yield** *(legacy, dormant — §5)* — `IYieldProvider`: `MockYieldProvider` (default) vs `RealOndoYieldProvider`. Still present as a swap seam but unused by the product.

When adding any new venue/provider: implement the interface, register it in the module factory, leave the safe default on. **Paper trading is a first-class supported mode — `FEED_SOURCE=binance EXECUTION_MODE=paper` paper-trades live data today** (see [docs/PAPER_TRADING.md](docs/PAPER_TRADING.md)).

## 8. Session Log

Full per-session log in [docs/SESSION_HISTORY.md](docs/SESSION_HISTORY.md); the chronological research log with per-run numbers + artifact paths is [docs/QUANT_JOURNAL.md](docs/QUANT_JOURNAL.md); the consolidated, citable findings are [docs/RESEARCH_FINDINGS.md](docs/RESEARCH_FINDINGS.md). Current state (as of 2026-06-04):

**What's built (Sessions 1–35+):**
- **Engine (S1–S18):** signal/risk/backtest/execution libraries, the real Binance market-data spine + live paper loop, real-history backfill + backtest, the live multi-asset surface (asset-class presets, real-data pair discovery, candles, live pair/capital switching), the N-pair multi-currency portfolio (isolated paper books, even capital split), and the `/demo` Trading Desk console. Course: `courses/stat-arb` chs 1–10.
- **Market-making (S19+):** `src/market-making/` runs MM books **next to** the stat-arb portfolio — Symmetric / Avellaneda-Stoikov / GLFT quoters (all `IQuoter`, σ price-scale-invariant since S31), `InventoryBook` (avg-cost P&L), `VpinEstimator` + `CompositeRiskGate` (Allow/Deny/Pause), 4-component `PnlAttributor`, `LobReplayHarness` (FIFO queue-aware fills off a real L2 tape), per-pool γ/κ sweep, `venueFeeFor` (per-venue maker/taker bps), `MmStrategyRegistry`, live `MmBook`/`MmPortfolioTrader` + `/api/market-making` control plane. See [docs/MARKET_MAKING.md](docs/MARKET_MAKING.md).
- **Stat-arb honesty gate:** `scripts/quant-research.ts` sweeps asset-class × strategy × entry-z × interval; the gate is `HistoricalReplayVenue` (half-spread + linear impact + short-borrow carry), real-history walk-forward (β re-fit per train window, Engle-Granger), deflated-Sharpe/PSR + purged k-fold (multiple-testing), and the **survivorship gate** (caps a survivor-unsafe equity window to UPPER-BOUND). Run DB-free via `scripts/oos-candidates.ts` + `scripts/cointegration-stability.ts`.
- **Equities (S24–S26):** `FEED_SOURCE=alpaca` adapters (split/div-adjusted, RTH-aware, real paper venue) + `YahooDailyClient` (decades of free daily history) + 8 `EQUITY_PRESETS`, all behind the existing seams (§7). See [docs/EQUITIES_STATARB_PLAN.md](docs/EQUITIES_STATARB_PLAN.md).
- **Discovery frontier (S28–S35):** DEX (`GeckoTerminalClient`, 100+ chains) + perp-CLOB (`HyperliquidClient`: candles + **L2 20×20** + trades-WS + funding) behind `IReferenceBarSource`/`IL2BookSource`; MM books quote them on the live paper loop; **Hyperliquid is the desk's default MM venue** (−0.2bps maker rebate). Venue ledger: [docs/DATA_SOURCES.md](docs/DATA_SOURCES.md).
- **Tests:** grow each session (137 suites / 911 tests at Journal #23, 2026-06-04); tsc clean. The journal carries the live count.

**The findings (detail in QUANT_JOURNAL / RESEARCH_FINDINGS):** crypto taker stat-arb is **killed** (cointegration cliff — a short-window artifact that collapses to ≈0 by 90–180d); equities sector stat-arb is **real but ~0.06 Sharpe** and survivorship-bound (forward paper is the verdict); funding carry is **real but modest** (~3–8%/yr on majors, hold past breakeven); FX-stable basis reverts reliably but is sub-fee for a taker (→ route to a maker book); options VRP is positive + our BS Greeks match Deribit (validated, in reserve); MM on a maker-rebate CLOB is the **live earner** — the first **net-positive honest-fill read** (HL BTC tuned: +$345/2h/$1M, maxDD 0.53%, real WS aggressor flow + queue-aware fills + −0.2bps rebate; ETH/SOL stand aside that window).

**Run it:**
- stat-arb: `FEED_SOURCE=binance EXECUTION_MODE=paper MOCK_TRADING_ENABLED=false npm run start:dev` → `/demo` + `/api/stat-arb/live/*`; MM books on the same process at `/api/market-making/*`.
- quant research (DB-free): `npx ts-node -r tsconfig-paths/register scripts/quant-research.ts`; OOS gate: `scripts/oos-candidates.ts`; cointegration map: `scripts/cointegration-stability.ts`.
- MM session / L2 capture + tune: `scripts/mm-paper-session.ts`, `scripts/mm-l2-session.ts`, `scripts/mm-l2-tune.ts`.
- equities (paper on Alpaca): set `ALPACA_KEY_ID`/`ALPACA_SECRET`, then `FEED_SOURCE=alpaca EXECUTION_MODE=paper MOCK_TRADING_ENABLED=false npm run start:dev`; equity OOS on free history: `OOS_SOURCE=yahoo … scripts/oos-candidates.ts`.
- Real-money is the `EXECUTION_MODE=live` + `LIVE_TRADING_ARMED=true` engineering decision — **parked** (mission is paper-only).

**Next (the paper-demo frontier):** **(a) discovery / MM** — run the long L2 capture + γ/κ sweep across many sessions/regimes to turn the single BTC net-positive read into a distribution; HL funding ingest for the carry leg; more perp-DEX CLOBs (dYdX / Drift / Bybit / OKX). **(b) forward paper track records** — run the MM book + the survivor-safe equities basket on the live loop for hours/days and show steady, low-drawdown equity curves (this *is* the demo). **(c) keep the numbers honest** — the OOS / survivorship / cost / queue-aware gates are the live discipline. **P1 (real capital) is PARKED.** Open research: cross-venue basis pairing, funding-carry baskets (course §8), Johansen.

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
  yield/                               (legacy, dormant — §5)
    yield-provider.interface.ts        IYieldProvider + types + errors
    mock-yield-provider.ts             deterministic; default
    real-ondo-yield-provider.ts        dormant; KYB-gated
    yield.module.ts                    factory selects mock vs real
  treasury/                            (legacy, dormant — §5)
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
