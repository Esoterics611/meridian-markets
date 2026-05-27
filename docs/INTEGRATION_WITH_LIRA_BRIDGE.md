# Integration with Lira-Bridge — the `ITreasuryClient` contract

> The single sanctioned coupling between Meridian Markets and Lira-Bridge. They share **nothing else** — no DB, no filesystem, no imports, no types. This document is the wire contract; both sides re-declare any shapes they need from it.

---

## 1. Why an HTTP boundary at all

Markets and Lira-Bridge are deliberately separate companies with separate licensing surfaces ([PHASED_PLAN.md §Why](../PHASED_PLAN.md)). If they share a database or import each other's types, the legal "these are two entities" story becomes fiction the day a regulator looks at the architecture. So:

- **Two processes**, two deploys, two databases.
- **One contract**, HTTP/JSON, intentionally narrow.
- **No shared library.** Each side re-declares the wire shapes it uses.

## 2. Caller / callee responsibilities

- **Markets is the callee.** It exposes `/api/treasury/*` and owns `treasury_movements`, `treasury_positions`, and the relationship with the upstream yield provider (Ondo USDY in Phase 0).
- **Lira-Bridge is the caller.** It implements an internal `ITreasuryClient` adapter (TypeScript interface, name shared by convention only) and uses it from wherever the Path C reserve pool decides to park or pull idle USDC.

The Lira-Bridge-side `ITreasuryClient` does not exist yet — it's a separate session in the Lira-Bridge repo. Markets ships first so the contract is concrete by the time Lira-Bridge integrates.

## 3. Endpoints

All endpoints require the header `x-meridian-client-key: <shared-secret>`. Missing or wrong header → `401 Unauthorized`. Malformed body → `400 Bad Request`. Business rejections (over-withdraw, etc.) → `400 Bad Request` with a descriptive message.

USDC amounts are always **6-decimal integer units encoded as strings** (`"100000000"` = 100 USDC). Numbers in JSON would lose precision past 2^53; strings carry it exactly and decode cleanly into `BigInt`.

### 3.1 `POST /api/treasury/deposit`

Place reserve float into the yield provider.

```json
// Request
{
  "amount_usdc_units": "100000000",
  "idempotency_key": "lb-reserve-deposit-2026-05-26-001"
}

// Response 200
{
  "id": "00000000-0000-0000-0000-000000000001",
  "direction": "DEPOSIT",
  "amount_usdc_units": "100000000",
  "provider": "mock",
  "external_ref": "mock-dep-lb-reserve-deposit-2026-05-26-001",
  "running_balance_units": "100000000",
  "created_at": "2026-05-26T00:00:00.000Z"
}
```

`idempotency_key` MUST be globally unique per Lira-Bridge intent (e.g., the originating reserve-pool ledger row id). Replays return the original `id` and do not double-credit the provider.

### 3.2 `POST /api/treasury/withdraw`

Pull principal back out for redemption.

```json
// Request
{
  "amount_usdc_units": "25000000",
  "idempotency_key": "lb-reserve-withdraw-2026-05-26-001"
}

// Response 200: same shape as deposit, with direction: "WITHDRAW"
```

Over-withdraw returns 400 with `"treasury: cannot withdraw ... from <provider> — only N available"`.

### 3.3 `GET /api/treasury/position`

Current principal + accumulated yield. Lira-Bridge uses this to compute "effective Path C yield" for its own dashboards.

```json
// Response 200
{
  "provider": "mock",
  "principal_units": "75000000",
  "yield_earned_units": "342817",
  "last_synced_at": "2026-05-26T00:00:00.000Z"
}
```

### 3.4 `GET /api/treasury/yield-earned`

Yield-only convenience read.

```json
// Response 200
{ "provider": "mock", "yield_earned_units": "342817" }
```

## 4. Auth — v1 is a shared secret, do not ship to prod

Today: `x-meridian-client-key` matches the `MERIDIAN_CLIENT_KEY` env on the Markets side. Constant-time compare in the guard.

Before either side handles real customer-derived money:
- Move to mTLS (Markets and Lira-Bridge each present a cert pinned by the other), OR
- Move to a short-lived signed JWT issued by a shared identity service.

Both options keep the contract shape identical — only the guard implementation changes. Flagged because the shared-secret model is fine for first-party-treasury Phase 0 but inadequate for anything customer-facing.

## 5. Idempotency, retries, and partial failure

Both sides assume the network can drop any request. The contract is built so the caller can retry safely:

- Every mutation requires an `idempotency_key`.
- The `(provider, idempotency_key)` UNIQUE constraint on `treasury_movements` collapses replays to one row at the DB layer.
- `MockYieldProvider` and (future) `RealOndoYieldProvider` BOTH dedupe internally on the same key. A successful provider call + a network-failed response → Lira-Bridge retries → same outcome, same external_ref.

Lira-Bridge MUST persist the idempotency_key it sent **before** issuing the request and reuse it across retries. Anything else loses the safety property.

## 6. Operational expectations

- **Markets must be available before Lira-Bridge calls it.** If Markets is down, Lira-Bridge SHOULD treat the call as deferrable (the Path C reserve pool doesn't *need* to be optimised on every drawdown) rather than blocking the customer-facing path.
- **Markets does NOT push events to Lira-Bridge.** Yield accrual is observed by Lira-Bridge polling `/position` on its own cadence (daily is plenty). The unique partial index on `(provider, created_at::date) WHERE direction='YIELD_ACCRUAL'` guarantees at most one accrual per provider per day.
- **No cross-database reconciliation.** If the two sides disagree about how much float Markets is managing, the source of truth is **Markets** for principal + yield, and **Lira-Bridge** for "what we intended to send." Reconciliation is a manual operational task, not an automated one — at Phase 0 volumes that's correct.

## 7. Versioning

The path prefix `/api/treasury` is the version (implicit v1). Breaking changes:

- New endpoints: additive, no version bump.
- New optional request fields: additive, no version bump.
- New response fields: additive, no version bump. (Lira-Bridge MUST ignore unknown fields.)
- Removed or renamed fields, changed types: bump to `/api/treasury/v2/*` and run both prefixes during the cutover.

## 8. What this contract is NOT

- Not a place to expose internal yield-provider details. Lira-Bridge sees `provider: "mock" | "ondo-usdy" | ...` and that's the limit. The chain, the smart contract address, the rebase mechanism, the redemption window — Markets' problem, not Lira-Bridge's.
- Not a place to expose customer-money operations. Phase 4 (3(c)(7) fund subscriptions and redemptions) gets its own contract on a different surface with different auth.
- Not a place to pass Lira-Bridge member identifiers. This is first-party treasury management — there is no "per-member" balance in Markets. Anything that would need one is a Phase 4+ concern.

---

## 9. Phase 1 addition — Path C outstanding-exposure endpoint (Lira-Bridge → Markets)

> **Status (2026-05-27):** endpoint defined here; **not yet implemented on the Lira-Bridge side** (separate session in `/home/nexus/code/meridian`). The Markets side uses `StubExposureClient` until the real endpoint is available.

The hedge monitor cron needs to read Lira-Bridge's outstanding ILS-pending exposure so it can size the short-ILS position appropriately. This reverses the caller/callee direction: **Markets calls Lira-Bridge**.

### 9.1 `GET /api/path-c/outstanding-exposure`

Returns the current sum of all Path C transactions where the customer's ILS wire has been credited but the USDC replenishment has not yet arrived (the FX gap-risk window).

```json
// Response 200
{
  "ils_units": "18500000000",
  "usdc_units": "5000000000",
  "as_of": "2026-05-27T14:00:00.000Z"
}
```

- `ils_units` — outstanding ILS amount in 6-decimal integer units (1 ILS = 1_000_000 units).
- `usdc_units` — equivalent USDC value in 6-decimal integer units (at the market rate at `as_of`).
- `as_of` — timestamp of the computation; used by `HedgeCircuitBreaker.checkFeedStaleness()`.

### 9.2 Auth

Same `x-meridian-client-key` header, same constant-time compare. Markets presents the key; Lira-Bridge verifies. Same upgrade path to mTLS / signed JWT before real money.

### 9.3 Idempotency and polling cadence

This is a **read** — no idempotency required. Markets polls on `HEDGE_MONITOR_INTERVAL_MS` (default 60s). Lira-Bridge SHOULD cache the exposure computation for at most `HEDGE_MAX_FEED_STALENESS_MS / 2` (default 2.5 minutes) to keep the response fast.

### 9.4 Lira-Bridge implementation notes

When building this endpoint in the Lira-Bridge repo:
- Query the `path_c_transactions` table for `status IN ('CREDITED','PENDING_REPLENISHMENT')`.
- Sum `ils_amount` and convert to USDC at the current FX rate.
- The `as_of` field MUST be the time of the DB read, not a cached timestamp — the circuit-breaker on the Markets side uses it to detect stale data.

