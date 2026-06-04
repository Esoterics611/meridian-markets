# Phase 1 Prompt — On-chain FX hedge module

> **Session goal:** flesh out the Phase 1 FX hedge module beyond the scaffold (already committed). Read [PHASED_PLAN.md §Phase 1](../docs/archive/PHASED_PLAN.md) and [docs/SESSION_HISTORY.md](../docs/SESSION_HISTORY.md) first — the scaffold (interface + mock + dormant real + module + tests) is already on disk; do not duplicate it.

---

## 0. Hard constraints (do not violate)

- **First-party only.** Never customer-facing. Never "hedging-as-a-service." See [PHASED_PLAN.md cross-phase dependency #3](../docs/archive/PHASED_PLAN.md).
- **Modular monolith.** One repo, one DB, one ordered migration history. Same posture as [CLAUDE.md §6](../CLAUDE.md). No new microservice. No new database.
- **Mock-default discipline.** `MOCK_HEDGE_ENABLED=true` is the default. `RealHyperliquidHedgeVenue` stays dormant until venue KYB + secrets land. Flipping it is a **business gate**, not an engineering gate.
- **`process.env` only in `src/config/app-config.factory.ts`.** All other consumers read typed `AppConfig` via `ConfigService` or secrets via `ISecretProvider.get()`.
- **Append-only at the DB privilege layer.** New tables MUST grant `SELECT, INSERT` only to `meridian_markets_app`. The privilege test in `src/database/append-only.int-spec.ts` is the regression oracle — extend it for each new table.

---

## 1. Already shipped (from the prior session — do not re-create)

```
src/hedge/
  hedge-venue.interface.ts             IHedgeVenue + types + errors
  mock-hedge-venue.ts                  Deterministic; default
  real-hyperliquid-hedge-venue.ts      Dormant; KYB-gated
  hedge.module.ts                      Factory selects mock vs real
  mock-hedge-venue.spec.ts             ~9 pure-unit specs
  real-hyperliquid-hedge-venue.spec.ts ~5 dormant specs
```

Config: `AppConfig.hedge.{mockEnabled, mockFxDriftBpsPerDay, mockSettleMs}`. Env keys: `MOCK_HEDGE_ENABLED`, `MOCK_HEDGE_FX_DRIFT_BPS_PER_DAY`, `MOCK_HEDGE_SETTLE_MS`. `HedgeModule` is registered in `AppModule`.

---

## 2. Scope for this session

The scaffold gives us the **swap seam**. This session builds the **orchestrator** that decides when to hedge, sizes positions, persists movements, and exposes the operator surface. Roughly:

### 2.1 Persistence — `hedge_movements` + `hedge_positions`

New migration `migrations/<timestamp>-AddHedgeTables.ts`. Schema (mirrors `treasury_movements` exactly in posture):

- `hedge_movements` (append-only):
  - `id` BIGSERIAL PK
  - `venue` TEXT NOT NULL — matches `IHedgeVenue.venueId`
  - `direction` TEXT NOT NULL — one of `OPEN_SHORT`, `CLOSE_SHORT`, `FUNDING_ACCRUAL`, `MARK_TO_MARKET`
  - `notional_units` BIGINT NOT NULL — signed; positive for opens, negative for closes
  - `pnl_units` BIGINT — nullable; populated on CLOSE_SHORT and MARK_TO_MARKET
  - `funding_units` BIGINT — nullable; populated on FUNDING_ACCRUAL
  - `position_ref` TEXT — nullable; non-null for OPEN_SHORT / CLOSE_SHORT
  - `external_ref` TEXT NOT NULL — venue's response identifier
  - `idempotency_key` TEXT NOT NULL
  - `created_at` TIMESTAMPTZ NOT NULL DEFAULT NOW()
  - CHECK constraint: `(direction = 'OPEN_SHORT' AND notional_units > 0) OR (direction = 'CLOSE_SHORT' AND notional_units < 0) OR (direction IN ('FUNDING_ACCRUAL','MARK_TO_MARKET'))`
  - UNIQUE `(venue, idempotency_key)`
  - UNIQUE `(venue, position_ref, created_at::date) WHERE direction = 'MARK_TO_MARKET'` — cron idempotency, same shape as `treasury_movements`' YIELD_ACCRUAL partial index
  - Grants: `meridian_markets_app` gets `SELECT, INSERT` only — no UPDATE, no DELETE

- `hedge_positions` (mutable cache):
  - `position_ref` TEXT PK
  - `venue` TEXT NOT NULL
  - `notional_units` BIGINT NOT NULL
  - `entry_price_micros` BIGINT NOT NULL
  - `opened_at` TIMESTAMPTZ NOT NULL
  - `closed_at` TIMESTAMPTZ — nullable
  - `last_mark_micros` BIGINT — nullable
  - `last_pnl_units` BIGINT — nullable
  - `last_funding_units` BIGINT — nullable
  - `updated_at` TIMESTAMPTZ NOT NULL
  - Grants: `meridian_markets_app` gets `SELECT, INSERT, UPDATE` only — no DELETE (consistent with `treasury_positions`)

Extend `src/database/append-only.int-spec.ts` with privilege assertions for both new tables.

### 2.2 `HedgeService` — append-only ledger + idempotency

`src/hedge/hedge.service.ts`. Mirrors `TreasuryService` exactly:

- `openShort({ notionalUnits, idempotencyKey })` — inside `DbService.runInSerializableTransaction`:
  1. Idempotency check on `(venue, idempotency_key)`.
  2. Call `IHedgeVenue.openShort`.
  3. INSERT into `hedge_movements` (direction = `OPEN_SHORT`).
  4. INSERT into `hedge_positions`.
  5. Return the result.

- `closeShort({ positionRef, idempotencyKey })` — same pattern; UPDATE `hedge_positions.closed_at`; INSERT CLOSE_SHORT row.

- `getPosition(positionRef)` — read-through cache: prefer `hedge_positions`, fall back to `IHedgeVenue.fetchPosition` if stale beyond `STALE_THRESHOLD_MS`.

- `markAll()` — for the cron: list open positions, call `fetchPosition` on each, INSERT `MARK_TO_MARKET` and `FUNDING_ACCRUAL` rows where appropriate. Constrained to one MARK_TO_MARKET per position per day via the partial index.

**Outbox / saga note:** the scaffold runs the provider call inside the SERIALIZABLE transaction. For the real venue this becomes a saga (open with the venue first, write the row on confirmation, with a compensating close if the row fails). Flagged in [SESSION_HISTORY.md §1 architectural note 5](../docs/SESSION_HISTORY.md) — same flag applies here.

### 2.3 `HedgeMonitorCron` — exposure watcher

`src/hedge/hedge-monitor.cron.ts`. Polls Lira-Bridge's exposure feed via the existing `ITreasuryClient` HTTP contract (the *reverse* direction — Lira-Bridge currently *calls* Meridian; for hedging Meridian needs to read Lira-Bridge's outstanding Path C ILS-pending exposure). This is a **new HTTP endpoint** that needs to land in Lira-Bridge first: `GET /api/path-c/outstanding-exposure` returning `{ ilsUnits: bigint, usdcUnits: bigint, asOf: Date }`.

**Important:** this is the only new Lira-Bridge ↔ Meridian coupling since Phase 0. It must be documented in [docs/INTEGRATION_WITH_LIRA_BRIDGE.md](../docs/INTEGRATION_WITH_LIRA_BRIDGE.md) and guarded by the same `x-meridian-client-key` shared secret (v1 — upgrade to mTLS or signed JWT before real money flows).

Cron behavior:
1. Pull current exposure from Lira-Bridge.
2. Compare to current open-short notional sum.
3. If under-hedged by > N% (configurable, default 5%), open additional shorts via `HedgeService.openShort`.
4. If over-hedged by > N%, close shorts via `HedgeService.closeShort`.
5. Sizing rule: hedge to **100% of outstanding exposure** by default; configurable per env.

### 2.4 Circuit breakers — `HedgeCircuitBreaker`

`src/hedge/hedge-circuit-breaker.ts`. Enforces the [PHASED_PLAN.md §Phase 1](../docs/archive/PHASED_PLAN.md) gates:

- **Funding spike:** kill switch if `IHedgeVenue.fetchHealth().lastFundingBps > MAX_FUNDING_BPS` (default 100 bps).
- **Venue health degradation:** kill switch if `fetchHealth().healthy === false`.
- **Data staleness:** kill switch if Lira-Bridge exposure feed has been stale > `MAX_FEED_STALENESS_MS` (default 5 minutes).
- **3σ liquidation buffer:** sizing helper that returns the maximum hedge notional given current margin + 3σ ILS move sizing. The hedge monitor consults this before sending opens.

Wire the breaker into `HedgeService.openShort` (refuses to open if any gate is tripped) and `HedgeMonitorCron` (pauses the loop with structured log lines, not exceptions).

### 2.5 No HTTP controller for hedge

First-party only. The hedge module exposes **no HTTP surface**. Operator interaction is via the cron + logs. (If Phase 4 ever lands, a separately-permissioned admin endpoint can read `hedge_positions` — but **not** in this session.)

### 2.6 Tests

Mirror the Phase 0 shape:
- `hedge.service.spec.ts` (mocked DB + mocked venue, ~8 specs)
- `hedge.service.int-spec.ts` (`describeIfDb`, ~6 specs)
- `hedge-monitor.cron.spec.ts` (~5 specs with fake Lira-Bridge client)
- `hedge-circuit-breaker.spec.ts` (~6 specs)
- Privilege assertions added to `database/append-only.int-spec.ts` (+4 specs)

Target: at least 25 net-new tests, repo total above 75.

---

## 3. Out of scope (deliberately deferred)

- **Real Hyperliquid REST wire-up.** Stays dormant. Same posture as `RealOndoYieldProvider`.
- **Multi-venue routing** (Drift / GMX fallback). Single venue is enough for v1.
- **Funding-carry strategy.** That belongs in Phase 3 stat-arb (see [docs/STAT_ARB_PLAN.md](../docs/STAT_ARB_PLAN.md)), even though the venue-health stream is shared.
- **Path C exposure feed on the Lira-Bridge side.** That's a separate session in `/home/nexus/code/meridian` (different repo, deliberately separate per [CLAUDE.md §0](../CLAUDE.md)). This session can stub the client with a fake until the real endpoint lands.

---

## 4. Done when

1. Migration applied; both new tables exist with correct grants; privilege specs pass.
2. `HedgeService` performs SERIALIZABLE-tx open/close/mark with idempotency.
3. `HedgeMonitorCron` runs against a stub `ITreasuryExposureClient` and produces deterministic open/close decisions.
4. `HedgeCircuitBreaker` blocks opens under each documented condition.
5. 25+ new tests; full repo above 75. `npx tsc --noEmit` clean. `npx jest` green (DB-gated suites skip if Postgres :5433 is down).
6. `docs/SESSION_HISTORY.md` updated with a new "Session 3 — Phase 1 orchestrator" entry summarising what shipped and any new architectural notes.
7. One coherent commit on `master`, `Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>` trailer, per [CLAUDE.md §0](../CLAUDE.md).

---

## 5. After this session

- **Phase 1 hardening:** saga / outbox replacement of the in-tx provider call. Required before any real-money flip.
- **Lira-Bridge-side exposure endpoint:** separate session in `/home/nexus/code/meridian`.
- **Venue KYB with Hyperliquid:** business track; engineering unblocked the day it closes.
- **Phase 3 stat-arb:** see [docs/STAT_ARB_PLAN.md](../docs/STAT_ARB_PLAN.md) — independent track; can run in parallel.
