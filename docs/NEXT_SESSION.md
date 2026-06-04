# Next-session kickoff brief — Backend Telemetry P1

> Paste the **Kickoff prompt** block below to start the session. It is self-contained: a fresh session auto-loads `CLAUDE.md` + the memory index, and this brief points at everything else. Work autonomously for the whole session — **do not ask for approval**; verify with `tsc` + `jest` and commit each phase on `master` per CLAUDE.md §0.

---

## Kickoff prompt

```
GOAL (one session, ~1–2h, fully autonomous — do NOT ask for approval at any point):
Implement backend telemetry P1 — metrics + health endpoints — END TO END, so the
persistent paper-trading research system is observable for unattended multi-hour runs.
Build it exactly to the spec in docs/TELEMETRY_REQUIREMENTS.md (I wrote that spec; treat
it as the contract). Ship behind a config-gated swap seam with a no-op default, with
unit tests, wiring, and doc updates. If time remains, start P3 (durable NAV / equity-
curve history). Commit each coherent phase on master; end the session with everything
committed and tsc + jest green.

FIRST, read in this order: docs/ROADMAP.md (state + priorities), docs/TELEMETRY_
REQUIREMENTS.md (the contract — four pillars, the §4 metric catalog, design constraints
DC-1..DC-6, acceptance criteria §8), docs/PNL_ACCOUNTING.md §I (the snapshot/ledger
telemetry must READ, not duplicate), and the memory index. Then read the surfaces you'll
instrument: src/market-making/live/mm-portfolio-trader.ts (snapshot() + tick()),
src/market-making/live/mm-book.ts (MmBookSnapshot fields), src/stat-arb live portfolio
snapshot, src/config/app-config.factory.ts (the ONLY process.env reader), and how a
@Global module is wired (src/database/database.module.ts) + a controller is registered.

WHERE WE ARE (all on master): Meridian is a persistent paper-trading research system.
The MM frontier is mature — real HL trades/WS aggressor feed, funding carry full-stack
(harness + live MmBook), restart-safe books (MM_PERSIST: serialize/restore → mm_book_
state → boot-rehydrate + per-tick checkpoint + flatten-on-shutdown). The financial state
already lives in snapshot() (equity, net/realised/unrealised, fees, funding, inventory,
maxDrawdown, fills, blockedQuotes, risk verdict). Telemetry's job is to EXPOSE that as
metrics + add operational/feed/persistence metrics + health endpoints. 137 suites / 911
tests, tsc clean. There is NO telemetry yet — this session builds it.

BUILD (P1 — deliverables):
1. A telemetry swap seam: src/telemetry/telemetry.interface.ts — ITelemetry (counter /
   gauge / histogram + a uniform alert/event hook) + a TELEMETRY token + a NullTelemetry
   (no-op default). Selected by config (TELEMETRY_ENABLED, default false) in a @Global
   TelemetryModule. Discipline per DC-1/DC-2/DC-5: zero behaviour change + near-zero
   overhead when off; process.env only in app-config.factory; metric updates O(1) and
   non-blocking (an emit error is swallowed + counted, never fails a tick).
2. A Prometheus implementation behind the seam. Prefer the `prom-client` library (add it
   to package.json); if you'd rather not add a dep, hand-roll a minimal Prometheus text-
   exposition registry — either is fine as long as it stays behind ITelemetry.
3. GET /metrics (Prometheus text format) + GET /health (liveness) + GET /health/ready
   (readiness: DB reachable when MM_PERSIST, ≥1 feed reachable, last tick within N×poll-
   interval ⇒ non-200 when not ready). A small MetricsController/HealthController.
4. The §4 metric catalog: operational (uptime, event-loop lag, tick count/duration/
   OVERRUN per loop, http, db), feed/data-quality (poll success/fail, last-bar-age
   STALENESS, ws connected), desk/financial (per-book + desk equity/net/realised/
   unrealised/fees/FUNDING/inventory/maxDrawdown/fills/blockedQuotes/risk-verdict —
   MAPPED FROM snapshot(), bounded labels book/source/strategy/verdict per DC-3/DC-4),
   persistence (checkpoint count/failures, rehydrated-books). Pull model: a collector
   reads snapshot() on scrape so there's no parallel accounting path.
5. Instrument the MM tick loop (tick count/duration/overrun) + feed polls + persistence
   via the injected ITelemetry (no-op by default ⇒ existing tests unchanged).
6. Tests: NullTelemetry no-op, the Prometheus registry/text formatting, the snapshot→
   metrics mapping, and the /health/ready readiness logic. Keep them offline (no real DB
   /network — fake the snapshot + deps like the existing repo unit specs do).
7. Docs: flip docs/TELEMETRY_REQUIREMENTS.md P1 to done + check off the §8 criteria it
   meets; update docs/ROADMAP.md (telemetry P1 ✓); add /metrics + /health[/ready] +
   TELEMETRY_ENABLED to docs/CHEATSHEET.md and .env.example.

STRETCH (only if P1 is fully done + green): P3 — durable NAV / equity-curve history: an
mm_nav (or shared) table + a cron writing desk NAV + per-book equity per interval
(mirror src/stat-arb/persistence/stat-arb.repository.ts + the stat_arb_nav migration +
nav.cron patterns), behind MM_PERSIST, with a query endpoint for the multi-day track
record. This is the research output and ties into the restart-safe-books work.

DEFINITION OF DONE: GET /metrics exposes the §4 metrics with correct types + bounded
labels; /health + /health/ready behave per DC/FR-8; with TELEMETRY_ENABLED=false the
full suite passes with no measurable overhead and no behaviour change; new unit tests
cover the seam + Prometheus + mapping + readiness; tsc + jest green; each phase committed
on master with a Co-Authored-By trailer; a short journal/roadmap note records what shipped.

CONSTRAINTS / CONVENTIONS: paper-only; honesty about the numbers is the whole game;
modular monolith (CLAUDE.md §6) — telemetry READS the ledger, never duplicates it;
swap-seam discipline (§7) — interface + real + no-op, config-selected, safe default on;
`npm run start:dev` exits 144 in this sandbox, so VERIFY via `npx tsc --noEmit` + `npx
jest` (hand any live/long run to me). Proceed autonomously to the end of the session.
```

---

## Why this goal (context for me, not part of the prompt)

It's the highest-value **self-contained, offline-verifiable, no-hand-off** work left: a full engineering build with a spec already written, infrastructure the persistent system needs, and a clean definition of done. It does not depend on the ~2h live captures (those are the parallel *research* thread — regime-breadth on the rebate verdict — which are hand-offs, not active session work). After telemetry lands, the natural follow-ups are: regime-breadth captures, stat-arb live persistence, and the manual-testing walkthrough doc, then the capital allocator + agentic layer (see ROADMAP.md).
```
