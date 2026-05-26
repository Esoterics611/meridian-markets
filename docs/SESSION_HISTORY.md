# Meridian Markets — Session History

Per-session log. Architectural notes that earn keep-around status get a numbered §; everything else is one-paragraph context for future-you.

---

## 1. Session 1 — Phase 0 scaffold (2026-05-26)

**Goal:** execute [prompts/PHASE_0_PROMPT.md](../prompts/PHASE_0_PROMPT.md). Treasury yield service: NestJS scaffold + append-only ledger + `IYieldProvider` interface + mock-default + dormant Ondo stub + HTTP API + tests.

### Shipped

- **Scaffold.** NestJS 10 + TypeScript strict (CommonJS), Postgres 16 on port 5433, `tsconfig` / `tsconfig.build` / `nest-cli.json` / `docker-compose.yml` / `.env.example` mirrored from Lira-Bridge's conventions.
- **Migration `1715000000000-Initial.ts`.**
  - `treasury_movements` — append-only ledger. `meridian_markets_app` role has `SELECT, INSERT` only (no UPDATE/DELETE). `chk_amount_positive` CHECK enforces `> 0`. `(provider, idempotency_key)` UNIQUE for replay safety. `(provider, created_at::date) WHERE direction='YIELD_ACCRUAL'` UNIQUE for cron idempotency.
  - `treasury_positions` — mutable cached current view; `(provider)` PK; `SELECT, INSERT, UPDATE` for the app role; no DELETE.
  - `meridian_markets_app` LOGIN role created; privilege grants asserted in `src/database/append-only.int-spec.ts`.
- **Secrets** — `ISecretProvider` + `EnvSecretProvider` copy-pattern from Lira-Bridge. `SecretsModule` is `@Global()`.
- **Config** — typed `AppConfig`; `appConfigFactory` is the only sanctioned `process.env` reader.
- **Database** — `DbService.runInSerializableTransaction(fn)` with retry-once-on-`40001`. `DatabaseModule` is `@Global()` and connects as `meridian_markets_app`.
- **Yield** — `IYieldProvider` interface with `deposit / withdraw / fetchPosition`. `MockYieldProvider` is deterministic (injectable clock for tests, simple time-weighted yield accrual). `RealOndoYieldProvider` throws `YieldProviderNotConfiguredError` on every method until `MOCK_YIELD_ENABLED=false` AND `ONDO_*` secrets are populated. Factory in `YieldModule` selects on `cfg.yield.mockEnabled`.
- **Treasury** — `TreasuryService.deposit/withdraw/getPosition/getYieldEarned/syncYield`. Every state change is a SERIALIZABLE transaction with idempotency-key dedup. `TreasuryController` serialises BigInts as strings (JSON doesn't carry them). `TreasuryClientGuard` enforces `x-meridian-client-key`. `YieldSyncCron` polls `IYieldProvider.fetchPosition()` and writes `YIELD_ACCRUAL` movements, capped at one per provider per day by the unique partial index.
- **Tests** — 51 tests across 9 suites:
  - `src/secrets/env-secret.provider.spec.ts` (8)
  - `src/yield/mock-yield-provider.spec.ts` (10)
  - `src/yield/real-ondo-yield-provider.spec.ts` (4)
  - `src/treasury/treasury.errors.spec.ts` (2)
  - `src/treasury/treasury-client.guard.spec.ts` (5)
  - `src/treasury/treasury.controller.spec.ts` (9)
  - `src/treasury/treasury.service.int-spec.ts` (6 — DB-gated)
  - `src/database/append-only.int-spec.ts` (4 — DB-gated)
  - `src/treasury/yield-sync.cron.spec.ts` (3)
  - DB-gated suites use `describeIfDb` + `dbAvailableCached` and pass-as-skipped when Postgres on `:5433` is unreachable.

### Architectural notes (binding for future sessions)

1. **`treasury_movements` is forever append-only at the DB privilege layer.** Future migrations may add columns but MUST NOT grant UPDATE or DELETE to `meridian_markets_app`. The privilege test is the regression oracle.
2. **The `IYieldProvider` swap seam is the only point of variance for yield providers.** Adding BUIDL or sDAI is "implement the interface + register in the factory" — no service-layer changes. Same posture as Lira-Bridge's `IBridgeApiClient` / `IOnRampAdapter` family.
3. **Real Ondo wire-up is a business gate, not an engineering gate.** The stub stays NotConfigured until KYB completes. Do not implement real REST calls before that — wrong order.
4. **Cross-service auth is v1 (shared secret in `x-meridian-client-key`).** Replace with mTLS or signed JWT before either side handles real money. Documented in [INTEGRATION_WITH_LIRA_BRIDGE.md](INTEGRATION_WITH_LIRA_BRIDGE.md) §4.
5. **TreasuryService runs the provider call inside the SERIALIZABLE tx today.** Fine for the mock (zero side effects beyond memory). When the real Ondo provider lands, the deposit/withdraw ordering moves to a saga/outbox so a DB rollback after a provider mint isn't possible. Flagged for Phase 1 hardening.
6. **The yield-sync cron is single-replica.** If the service ever runs >1 instance, only one should run the cron — same posture as Lira-Bridge's crons today (no leader election; deployment-level constraint).

### Open follow-ups

- **Lira-Bridge-side `ITreasuryClient` implementation.** Separate session, separate repo (`/home/nexus/code/meridian`). One-line factory swap once it lands.
- **KYB with Ondo.** Business track; engineering unblocked the day it closes.
- **Phase 1 FX hedge orchestrator** — see [Session 2](#2-session-2--phase-1-hedge-scaffold--stat-arb-course-2026-05-26) and [PHASE_1_PROMPT.md](../prompts/PHASE_1_PROMPT.md).
- **Multi-provider routing.** Single provider is enough for v1. Defer.

---

## 2. Session 2 — Phase 1 hedge scaffold + stat-arb course (2026-05-26)

**Goal:** make as much Phase 1 + Phase 3 progress as possible in a tight time budget. Two tracks ran in parallel; both delivered as scaffold-level rather than full implementation.

### Shipped

- **Phase 1 FX hedge scaffold** — `src/hedge/`:
  - `hedge-venue.interface.ts` — `IHedgeVenue` + types (`OpenShortRequest/Result`, `CloseShortRequest/Result`, `HedgePosition`, `VenueHealth`) + errors (`HedgeVenueNotConfiguredError`, `HedgeVenueUnhealthyError`, `HedgeVenueInsufficientMarginError`, `HedgePositionNotFoundError`).
  - `mock-hedge-venue.ts` — deterministic, injectable clock, bigint arithmetic in micros (1e6) for prices and 6-decimal units for notional. 10 bps/day funding placeholder; configurable linear ILS drift.
  - `real-hyperliquid-hedge-venue.ts` — dormant; throws `HedgeVenueNotConfiguredError` on every method. Same posture as `RealOndoYieldProvider`.
  - `hedge.module.ts` — factory selects on `MOCK_HEDGE_ENABLED`.
  - `mock-hedge-venue.spec.ts` (9 specs) + `real-hyperliquid-hedge-venue.spec.ts` (5 specs) — pure-unit, mirror the `mock-yield-provider.spec.ts` patterns.
- **Config additions** — `AppConfig.hedge.{mockEnabled, mockFxDriftBpsPerDay, mockSettleMs}`. New env keys `MOCK_HEDGE_ENABLED`, `MOCK_HEDGE_FX_DRIFT_BPS_PER_DAY`, `MOCK_HEDGE_SETTLE_MS` in `.env.example`. `HedgeModule` registered in `AppModule`.
- **`docs/STAT_ARB_PLAN.md`** — full engineering plan for Phase 3 stat-arb: strategy taxonomy, reference-repo table (URLs flagged unverified pending next-session WebFetch), proposed `src/stat-arb/` module layout, 6-step phased build-out, open questions.
- **`prompts/PHASE_1_PROMPT.md`** — next-session prompt for the Phase 1 orchestrator (HedgeService, monitor cron, circuit breakers, hedge_movements/positions migration). Done-when criteria explicit; out-of-scope items called out.
- **`courses/stat-arb/`** — mkdocs course backing the Phase 3 plan:
  - `mkdocs.yml` building with vanilla mkdocs + readthedocs theme (upgrade path to mkdocs-material + pymdownx documented).
  - Chapters §0 (charter & sources), §1 (intro), §2 (cointegration), §3 (OU), §4 (execution), §5 (risk) — full first drafts with Mermaid diagrams and inline math.
  - Chapters §6 (backtesting), §7 (production), Appendix A (code shapes) — outlines only.
  - Appendix B sources notebook with tier system (A verified, B unverified pending WebFetch, C placeholder).
  - `docs/RESEARCH_PROMPT.md` — detailed self-contained prompt to run in a Claude Code desktop session with web access to verify sources, identify the user-mentioned X thread, flesh out §6/§7/Appendix A, upgrade the mkdocs theme, and add charts.
- **Verified**: `npx tsc --noEmit -p tsconfig.json` clean; `npx jest src/hedge` green (14 new hedge specs); `mkdocs build` clean (warnings are cross-doc-root links, expected).

### Architectural notes (binding for future sessions)

1. **The hedge module follows the swap-seam pattern verbatim.** Future venues (Drift, GMX) implement `IHedgeVenue` and register in the `HedgeModule` factory. No service-layer changes when adding venues.
2. **Bigint price math in micros (1e6) is the codebase convention.** Same as `treasury_movements.amount_units` (USDC micros). `MockHedgeVenue` does all FX math in bigint with explicit scaling to avoid precision loss — the pattern extends to any future hedge venue.
3. **The hedge module ships with no DB tables yet.** Persistence (`hedge_movements`, `hedge_positions`) lands in [PHASE_1_PROMPT.md](../prompts/PHASE_1_PROMPT.md)'s next session. The swap seam works without persistence; persistence is the orchestrator's concern, not the venue's.
4. **`courses/stat-arb/` is documentation, not code.** It lives under `courses/` (not `docs/`) to keep mkdocs-built sites separable from the repo's flat-file docs. The course's existence does not create a Phase 3 commitment — implementation is still gated behind Phase 2 legal formation per [PHASED_PLAN.md](../PHASED_PLAN.md) cross-phase dependency #1.

### Open follow-ups

- **Phase 1 orchestrator** — see [PHASE_1_PROMPT.md](../prompts/PHASE_1_PROMPT.md).
- **Stat-arb course research** — see [courses/stat-arb/docs/RESEARCH_PROMPT.md](../courses/stat-arb/docs/RESEARCH_PROMPT.md). Run in Claude Code desktop with web access.
- **X-thread identification.** The user mentioned a "rohn / roan" thread; the handle is currently unverified. The research prompt's §3 covers the protocol for identifying and integrating it.
