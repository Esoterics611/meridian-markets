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
- **Phase 1 FX hedge.** Separate prompt; separate session.
- **Multi-provider routing.** Single provider is enough for v1. Defer.
