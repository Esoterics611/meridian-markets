# Lira-Bridge — Production-Ready Session

Parallel-track prompt for the **Lira-Bridge repo** (`~/code/meridian`), to be run independently of any Meridian Markets session. Combines Session 9 (refund executors + observability) with S-B2 (member JWT), S-B3 (recipient_id INSERT enforcement), and the four admin UI screens still stubbed.

## Hard rules
1. Work directly on `master` in `/home/nexus/code/meridian`. End the session with ONE commit (Co-Authored-By trailer).
2. Mock-default stays default. Do NOT flip `MOCK_BRIDGE_ENABLED`, `MOCK_MESH_ENABLED`, `PATH_C_ENABLED`, or `RECIPIENT_DISPATCH_ENABLED`.
3. All env-var reads via `SECRET_PROVIDER` (per-call, never cached). No raw `process.env` outside the two sanctioned seams (`env-secret.provider.ts`, `app-config.factory.ts`).
4. `npm run lint:boundaries` MUST stay green. New cross-module repo imports require explicit §10h exception + documentation.
5. The §10h architecture decision is binding — no microservices, no polyrepo, no DB-per-service.
6. **NEVER touch `/home/nexus/code/meridian-markets`** in this session. Separate repo, separate concern.

## Reading order (stop after these)
1. `CLAUDE.md` (the trimmed version — 150 lines)
2. `docs/SESSION_HISTORY.md` §1 (session log) + §7 (Path C notes) + §8 (admin notes) + §9 (recipient notes)
3. `docs/build_plan.md` §9 (lines 1551+) — Session 9 detailed spec
4. `docs/MEMBER_APP_DESIGN.md` §6 — recipient model rationale
5. `docs/NEXT_STEPS_ADMIN_UI.md` — admin UI gap spec
6. `docs/PATH_C_DESIGN.md` §11 — operational runbook (informs refund executor for Path C)

## Scope — four parallel tracks

### Track A — Session 9: Refund executors + observability
- **Refund executors**: one worker per path consuming `refund_jobs` where `status='QUEUED'`. Each transitions `QUEUED → EXECUTING → DONE|FAILED|BLOCKED`. Atomic with the compensating money movement.
  - **Path A** — call `IMeshApiClient.reverseTransfer()` (new interface method); on success ledger reversal credit (idempotency key suffix `:refund:{jobId}`) + state → `REFUNDED`.
  - **Path B** — call Rapyd refund API (`POST /v1/refunds`); on confirmation webhook (new event type) → reversal credit + `REFUNDED`.
  - **Path C** — initiate IL wire-out via new `IWireOutAdapter` (stub today; real later) + credit USDC back to reserve pool via `IReservePool.credit({mode: 'refund'})`. Document as "manual today, automated when custodian wired."
- **Metrics**: `/metrics` Prometheus endpoint. Counters per-state, per-path. Histograms for dispatch latency, settlement latency, refund latency. Use `prom-client` (single small dep).
- **k6 load test**: `test/load/transactions.js`. Target: 100 RPS sustained on `/api/transactions` (mock providers), p95 < 500ms, zero 5xx. Document in `docs/LOAD_TEST_RESULTS.md`.
- **Provider health**: populate `provider_health` table (existing schema from 8.5) from adapter pings. Cron every 60s. Surfaces in admin dashboard.

### Track B — S-B2: Member JWT replaces x-member-id header
- Member auth model: magic-link (email-based, single-use 15-min token). New table `member_sessions`. Issuance endpoints: `POST /api/auth/member/magic-link`, `POST /api/auth/member/verify`.
- Member JWT: HS256, separate `aud: 'member'` (admin tokens use `aud: 'admin'`). New `MemberAuthGuard` parallel to `AdminRoleGuard`.
- `/api/recipients` derives owner from `req.user.memberId` (JWT subject). **Remove the `x-member-id` header path entirely.**
- Update `docs/SESSION_HISTORY.md` §9 to remove "S-B2 pending" note.

### Track C — S-B3: recipient_id INSERT enforcement
- New error `TransferRequiresRecipientError`. Throw at INSERT in `MeshService.initiateTransfer`, `OnRampOrchestrator.handlePaymentReceived` (BOTH rows of the two-row pattern), `ILSCollectionService.attributeWire`.
- `recipient_id` column stays nullable (append-only history demands it); enforcement is service-level only.
- Path B two-row tests: assert both rows carry the same `recipient_id`.
- Document the cutover sequence in `docs/SESSION_HISTORY.md` §9.

### Track D — Admin UI stubs → live
Each replaces `client/src/admin/pages/StubPages.tsx` entry with a real page wired to the existing backend:
- **Reports**: date-range picker; tables for daily-volume, settlement-rates (p50/p95 per source), fx-rate history, failed-payments by reason, reserve-pool movement. Export CSV via existing `POST /admin/reports/export`.
- **Compliance**: KYC queue (filter by `kyc_status='pending'`); OFAC review queue (reads `admin_audit_log` for `ofac_block`); OFAC override (dual-approval modal); blocklist hashed-display + add/remove (dual-approval).
- **Operators**: list `admin_users`; invite modal; role patch dropdown; reset-MFA button; deactivate (refuses self).
- **Settings**: flag display table; flag-flip buttons (PATH_C_ENABLED → compliance dual-approval modal); provider health table; cron last-fired table.

## Out of scope (next sessions, separate prompts)
- `RECIPIENT_DISPATCH_ENABLED` flip (CU-R1/R2 sandbox verify first)
- `PATH_C_ENABLED` flip (CU-07 first)
- Real Bridge sandbox (still pending business-entity onboarding)
- `IOutboundDispatcher` / crypto-out remittance (separate session — the architectural refactor for USDC→USDC and multi-asset-out)
- ARCH-1 Phase 4 physical app split (cosmetic, defer)
- Treasury yield, FX hedging, Markets sister company (separate repo: `~/code/meridian-markets`)

## Definition of done
- `npm test` green; target 280+ tests across 35+ suites (≈ +60 from current 218)
- `npm run test:integration` green; +2–3 suites for refund executors
- `npm run lint:boundaries` green
- `npm run build:all` green
- All four admin UI pages functional against real backend (no stubs reachable)
- k6 result documented; p95 < 500ms at 100 RPS
- ONE commit on `master`; feature branch `prod-ready-9-sb2-sb3-adminui` pushed; PR opened against `master`
- `CLAUDE.md` §7 "Test counts last recorded" updated
- `docs/SESSION_HISTORY.md` §1 gains a `Session 9 complete` entry; §8 admin UI section updated; §9 S-B2/S-B3 notes updated

## Estimated effort
Large session. If you cannot land all four tracks, ship A+B+C and leave D for a follow-up — but commit what's done. The whole point of CLAUDE.md §0 is no uncommitted work between sessions.
