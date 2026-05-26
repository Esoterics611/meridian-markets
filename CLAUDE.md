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

Meridian Markets is the yield / treasury / markets sister entity to Lira-Bridge. Phase 0 (this codebase) is a standalone NestJS service that earns yield on Lira-Bridge's first-party Path C reserve-pool USDC. No customer money flows through this service in Phase 0; that gate moves at Phase 4 (3(c)(7) fund — see [PHASED_PLAN.md](PHASED_PLAN.md)).

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

## 7. Mock-default discipline

The Lira-Bridge mock-default pattern applies here:

- `MOCK_YIELD_ENABLED=true` is the default in `.env.example`.
- `MockYieldProvider` simulates principal + yield deterministically — no network calls.
- `RealOndoYieldProvider` throws `YieldProviderNotConfiguredError` until `MOCK_YIELD_ENABLED=false` AND the `ONDO_*` secrets are populated.
- Flipping to real Ondo is a **business gate** (KYB onboarding with Ondo), not an engineering gate. Do not flip without explicit sign-off.

Same rule for any future provider (Maker sDAI, BlackRock BUIDL): ship the stub, leave mock-default on, refuse to fire without KYB.

## 8. Session Log

Full per-session log in [docs/SESSION_HISTORY.md](docs/SESSION_HISTORY.md). Current state (as of 2026-05-26):

- **Done:** Session 1 — Phase 0 scaffold: schema, mock yield provider, Ondo stub, treasury service, controller, yield-sync cron, 51 tests across 9 suites. Real Ondo wire-up pending KYB.
- **Next:** Lira-Bridge-side `ITreasuryClient` implementation (separate session, in `/home/nexus/code/meridian`); KYB with Ondo (business track); Phase 1 FX hedge (separate prompt).

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
