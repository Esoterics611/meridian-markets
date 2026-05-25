# Session: Meridian Markets Phase 0 — Treasury Yield Service

Self-contained kickoff prompt for the first Meridian Markets implementation session. **Pre-condition:** the user has run `cd ~/code/meridian-markets && git init && npm init -y` (or you do it as Step 1).

## Hard rules
1. Work directly on `master` in `/home/nexus/code/meridian-markets`. End the session with ONE commit (Co-Authored-By trailer).
2. **NEVER touch `/home/nexus/code/meridian`** in this session. The two repos are deliberately separate; there is no shared filesystem state, no shared database, no shared dependency.
3. Mirror the Lira-Bridge architectural choices: **NestJS 10 + TypeScript strict (CommonJS) + PostgreSQL 16 + TypeORM 0.3 (raw SQL migrations, no entity decorators) + `ISecretProvider` for vault swap-point + mock-default for external integrations**. Do not re-litigate these — they're proven.
4. **MOCK_YIELD_ENABLED=true is the default.** Real on-chain placement requires KYB onboarding with the issuer (BlackRock/Securitize for BUIDL, Ondo for USDY, MakerDAO for sDAI) — that's a business gate, not engineering. Mock first; flip later.
5. Append-only audit posture from day one: a `treasury_movements` table where the `lirabridge_app`-equivalent role has `SELECT, INSERT` only (no UPDATE/DELETE). This is treasury — we need a tamper-proof movement log forever.

## Reading order (stop after these)
1. `README.md` (Meridian Markets 1-pager)
2. `PHASED_PLAN.md` §Phase 0 (the scope-bounding spec)
3. `../meridian/docs/PATH_C_DESIGN.md` §8 (FX rate strategy — explains *why* Path C float earns yield and what the integration boundary looks like)
4. `../meridian/docs/SESSION_HISTORY.md` §7 (Session 7 architectural notes — explains the reserve-pool patterns this service will plug into)
5. `../meridian/CLAUDE.md` §10h (the binding architecture decision — same posture applies here: modular monolith, no microservices, machine-enforced boundaries when the codebase justifies it)

## What you are building

A standalone NestJS service that:
1. Exposes `IYieldProvider` (the swap interface — same pattern as Lira-Bridge's `IBridgeApiClient`, `IOnRampAdapter`, `IReservePool`, `IBridgeRecipientClient`).
2. Implements ONE concrete provider — **recommend Ondo USDY** (clean API, real-world USD T-bill yield, multi-chain, institutional KYB instead of Securitize's heavier flow). Document why if you pick differently.
3. Exposes a thin internal HTTP API for the `ITreasuryClient` contract Lira-Bridge will eventually call: `POST /api/treasury/deposit`, `POST /api/treasury/withdraw`, `GET /api/treasury/position`, `GET /api/treasury/yield-earned`.
4. Records every movement in append-only `treasury_movements` with running balance, idempotency-protected.
5. Has a mock provider (`MockYieldProvider`) that simulates the real flow deterministically — accrues yield over wall-clock time at a configurable APR, instant deposits/withdrawals, but signs its own "settlement confirmations" with the real provider's HMAC scheme so the verification path is exercised. Same trick Lira-Bridge's mocks use.

## Scope

### Step 1 — Project scaffold
- `package.json` (NestJS 10 deps mirror Lira-Bridge: `@nestjs/common`, `@nestjs/core`, `@nestjs/config`, `@nestjs/typeorm`, `@nestjs/schedule`, `typeorm`, `pg`, `axios`, `typescript`, `jest`, `ts-jest`).
- `tsconfig.json` strict mode, `tsconfig.build.json` excludes tests.
- `nest-cli.json`, `.gitignore` (node_modules, dist, .env, `.claude/`).
- `docker-compose.yml` with `postgres:16` (different port than Lira-Bridge — use `5433`).
- `.env.example` with all required vars templated.

### Step 2 — Schema & migration
`migrations/1715000000000-Initial.ts`:
- `treasury_movements` table — `id UUID`, `direction CHECK(direction IN ('DEPOSIT','WITHDRAW','YIELD_ACCRUAL'))`, `amount_usdc_units BIGINT CHECK(amount_usdc_units > 0)`, `provider TEXT`, `external_ref TEXT`, `running_balance_units BIGINT`, `created_at TIMESTAMPTZ`, `metadata JSONB`. **6-decimal USDC convention same as Lira-Bridge.**
- `treasury_positions` table — `provider TEXT PRIMARY KEY`, `principal_units BIGINT`, `yield_earned_units BIGINT`, `last_synced_at TIMESTAMPTZ`. This one is mutable (it's the cached current view).
- Role `meridian_markets_app` with `SELECT, INSERT` on `treasury_movements` only; `SELECT, INSERT, UPDATE` on `treasury_positions`. Asserted via `has_table_privilege()` in an integration test.

### Step 3 — Core modules
Mirror Lira-Bridge's structure:
- `src/secrets/` — `ISecretProvider` + `EnvSecretProvider` (verbatim from Lira-Bridge — copy-paste, this is the vault swap-point pattern).
- `src/config/` — typed `AppConfig` factory.
- `src/database/` — `DbService.runInSerializableTransaction<T>()` (verbatim from Lira-Bridge — same SERIALIZABLE retry-once-on-40001 pattern).
- `src/yield/yield-provider.interface.ts` — `IYieldProvider` + `YIELD_PROVIDER` injection token + types.
- `src/yield/mock-yield-provider.ts` — deterministic mock; tracks principal, accrues yield at `MOCK_YIELD_APR` (default 5% APR), simulates settlement latency `MOCK_YIELD_SETTLE_MS` (default 250).
- `src/yield/real-ondo-yield-provider.ts` — dormant stub today. Throws `YieldProviderNotConfiguredError` until `MOCK_YIELD_ENABLED=false` AND `ONDO_*` secrets present. When live: USDY mint via Ondo's REST API, redeem via the same, yield is implicit in the USDY price appreciation (rebase mechanism).
- `src/yield/yield.module.ts` — factory selects mock vs real from `MOCK_YIELD_ENABLED`.
- `src/treasury/treasury.service.ts` — `deposit(amount)`, `withdraw(amount)`, `getPosition()`, `getYieldEarned()`. Each writes to `treasury_movements` append-only, updates `treasury_positions`, all in one SERIALIZABLE tx with idempotency.
- `src/treasury/treasury.controller.ts` — `/api/treasury/*` endpoints. Auth via a single shared-secret header `x-meridian-client-key` (the simplest cross-service auth that's not embarrassing; later replace with mTLS or signed JWT).
- `src/treasury/yield-sync.cron.ts` — every 5 min, calls `IYieldProvider.fetchYieldEarned()` and writes a `YIELD_ACCRUAL` movement if the position has appreciated. Idempotent on `(provider, accrual_date)`.

### Step 4 — Tests (real assertions, mirror Lira-Bridge's discipline)
- `MockYieldProvider`: deposits accrue correctly over fake time (jest fake timers); withdrawal reduces principal; yield calculation matches APR math; deterministic across runs.
- `TreasuryService`: deposit writes one movement + updates position atomically; concurrent deposits don't lose money (SERIALIZABLE proves it); idempotency-key replay collapses to one movement; over-withdraw throws.
- Migration: `has_table_privilege('meridian_markets_app', 'treasury_movements', 'UPDATE')` returns `false`.
- HTTP: `x-meridian-client-key` mismatch → 401; valid key → 200; missing body fields → 400.
- Target: **30+ tests / 6+ suites passing.**

### Step 5 — Docs
- `README.md` at repo root — mirrors Lira-Bridge's README but for Markets. What it does, how to run, how to test.
- `docs/SESSION_HISTORY.md` — first entry: this session.
- `docs/INTEGRATION_WITH_LIRA_BRIDGE.md` — documents the `ITreasuryClient` contract (HTTP shape) Lira-Bridge will eventually implement on its side. This is the boundary doc.
- `CLAUDE.md` at repo root — modeled on Lira-Bridge's trimmed CLAUDE.md (~150 lines). Include the binding §0 git workflow (same rules), tech stack, the §10h-style architecture decision (this is a modular monolith, no microservices, Markets and Lira-Bridge talk over HTTP and only over HTTP).

## Out of scope (do not build, document why if asked)
- **Customer money** — no LP onboarding, no fund vehicle, no accredited-investor flows. Phase 4.
- **Real on-chain calls** — KYB-gated; mock-default until business handles it.
- **FX hedging** — Phase 1, separate session.
- **Multi-provider routing / yield optimization** — single provider is enough for v1. Adding `BUIDL` or `sDAI` is a follow-up session.
- **Direct Lira-Bridge integration** — Lira-Bridge's `IReservePool` plugin to call this service is a separate session in the Lira-Bridge repo. We just expose the API contract.
- **Web UI** — internal service, no UI. If we want operator dashboards, those come later.
- **Production deployment** — local + tests only this session.

## Definition of done
- `npm test` green; 30+ tests across 6+ suites.
- `npm run build` green (`nest build`).
- One concrete provider (Ondo USDY recommended) wired through the mock-default pattern.
- All four `/api/treasury/*` endpoints functional against mock.
- `docker compose up -d postgres && npm run migration:run` works on a clean machine.
- Append-only privilege asserted in test.
- `README.md` + `CLAUDE.md` + `docs/INTEGRATION_WITH_LIRA_BRIDGE.md` written.
- Single commit on `master`. If you want to PR it: push a feature branch and open PR — but since the repo has no remote yet, just commit.

## What "good" looks like

Future-you opens this repo cold, reads `CLAUDE.md` and `docs/INTEGRATION_WITH_LIRA_BRIDGE.md`, and in 5 minutes knows: (a) what this service does, (b) what calls it, (c) how to run it, (d) how to swap the mock for real Ondo. The same posture Lira-Bridge has earned — pickup latency is the metric, not lines of code.

## Estimated effort
Medium session. Scaffold + mock + Treasury + tests is achievable in one session if focused. Real Ondo client stub + docs in the same session. Defer multi-provider, FX, and UI to follow-ups.
