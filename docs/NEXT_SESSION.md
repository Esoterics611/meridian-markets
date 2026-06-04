# Next-session kickoff brief — Telemetry P3: durable MM NAV / equity-curve history

> Paste the **Kickoff prompt** block below to start the session. It is self-contained: a fresh session auto-loads `CLAUDE.md` + the memory index, and this brief points at everything else. Work autonomously for the whole session — **do not ask for approval**; verify with `tsc` + `jest` and commit each phase on `master` per CLAUDE.md §0.

---

## Kickoff prompt

```
GOAL (one session, ~1–2h, fully autonomous — do NOT ask for approval at any point):
Implement TELEMETRY P3 — durable MM NAV / equity-curve history — END TO END, so the
persistent paper-trading research system produces its actual deliverable: a queryable,
multi-day desk-NAV + per-book equity curve that survives restart. This closes the one
remaining ⏳ item in docs/TELEMETRY_REQUIREMENTS.md §8 ("Desk NAV queryable over a
multi-day run and matches the ledger's equity to the unit"). Build it behind MM_PERSIST
(the existing restart-safe-books flag) with a Null/Postgres swap seam, unit + DB-gated
tests, wiring, and doc updates. Commit each coherent phase on master; end the session
with everything committed and tsc + jest green.

FIRST, read in this order: docs/ROADMAP.md (state + the "Active — persistence" section),
docs/TELEMETRY_REQUIREMENTS.md (FR-9 + §7 P3 + §8 NAV criterion), docs/PNL_ACCOUNTING.md
§I (units: equity/PnL in 6-dec USDC-units bigint, prices in micros), and the memory index.
Then read the EXACT pattern to MIRROR (stat-arb already did per-day NAV; you generalise it
to a per-interval MM time series):
  - src/stat-arb/persistence/nav.cron.ts          (StatArbNavCron — setInterval, OnModuleInit/Destroy, explicit tick() in tests, skip when nodeEnv==='test')
  - src/stat-arb/persistence/stat-arb.repository.ts (insertNav / navHistory / coerceNav — raw SQL via DbService.runInSerializableTransaction, bigint↔string)
  - src/stat-arb/persistence/stat-arb.repository.spec.ts (the describeIfDb DB-gated spec shape)
  - migrations/1717000000000-AddStatArbTables.ts  (stat_arb_nav table: append-only, grants SELECT+INSERT to meridian_markets_app, the (as_of AT TIME ZONE 'UTC')::date immutability fix)
  - migrations/1720000000000-AddMmBookState.ts    (the MM migration conventions: TEXT keys, CHECK constraints, app-role grants, up/down)
And the surfaces you'll read + wire:
  - src/market-making/live/mm-portfolio-trader.ts (snapshot(): MmPortfolioSnapshot — desk equity/net/realised/unrealised/fees/funding + books[] per-book MmBookSnapshot with equityUnits/source/strategyId/maxDrawdownPct/inventoryUnits)
  - src/market-making/market-making.module.ts     (how MmPortfolioTrader + MmStateRepository + PostgresMmStateStore are factory-wired with an OPTIONAL DbService; MM_PERSIST gating; the @Global TELEMETRY optional inject)
  - src/market-making/persistence/mm-state.repository.ts + postgres-mm-state-store.ts (the MM raw-SQL repo + store pattern + app-role grants)
  - src/market-making/mm.controller.ts            (control-plane shape; add the NAV query endpoint here)
  - src/telemetry/metrics-collector.ts            (meridian_desk_nav_units is already set = desk equity on scrape — the persisted NAV must match it to the unit)
  - src/config/app-config.factory.ts + app-config.interface.ts (the ONLY process.env reader; marketMaking.persist lives here)

WHERE WE ARE (all on master; PR #7 just shipped telemetry P1):
Meridian is a persistent paper-trading research system. Telemetry P1 is DONE
(src/telemetry/: ITelemetry swap seam + dependency-free Prometheus registry at GET
/metrics, GET /health[/ready], desk/feed/persist metrics pulled from snapshot(), tick
instrumentation; TELEMETRY_ENABLED default off ⇒ no-op). The live meridian_desk_nav_units
GAUGE already equals desk equity on scrape, but it is NOT durable — a restart loses the
curve. Restart-safe MM books are done (mm_book_state: serialize/restore → boot-rehydrate +
per-tick checkpoint + flatten-on-shutdown, gated by MM_PERSIST). Stat-arb has a per-DAY NAV
cron (stat_arb_nav) you generalise. 143 suites / 942 tests, tsc clean.

BUILD (P3 — deliverables):
1. Migration migrations/1721000000000-AddMmNav.ts — an APPEND-ONLY time series. Recommended
   single table `mm_nav` with a nullable/`''` book_key (book_key='' or a DESK sentinel = the
   desk aggregate row; a real symbol = that book's row), columns: id BIGSERIAL PK, as_of
   TIMESTAMPTZ, book_key TEXT, source TEXT, strategy_id TEXT, equity_units BIGINT, net_pnl_units
   BIGINT, realised_units BIGINT, unrealised_units BIGINT, fees_units BIGINT, funding_units
   BIGINT, inventory_units BIGINT, max_drawdown_pct DOUBLE PRECISION, created_at. Unlike
   stat_arb_nav this is a genuine per-INTERVAL series (NO per-day unique index — every interval
   is a distinct row); index on (as_of DESC) and (book_key, as_of DESC). GRANT SELECT, INSERT
   to meridian_markets_app (append-only, NO update/delete). down() drops it. Use (as_of AT TIME
   ZONE 'UTC') if any date-cast index (the known immutability fix — see CLAUDE.md memory).
2. src/market-making/persistence/mm-nav.repository.ts (mirror stat-arb.repository.ts) —
   insertNavSnapshot(rows: MmNavInsert[]) batch-inserting the desk row + every per-book row in
   ONE SERIALIZABLE txn (DbService), and navHistory(fromAsOf: Date, bookKey?: string):
   MmNavRow[] for the query endpoint. bigint↔string coercion both ways. DB-gated spec
   (describeIfDb) round-trip like stat-arb.repository.spec.ts.
3. src/market-making/persistence/mm-nav.cron.ts (mirror nav.cron.ts) — MmNavCron, reads
   MmPortfolioTrader.snapshot() each interval and writes the desk + per-book rows. Gated:
   only runs when marketMaking.persist AND a DbService is present (else a no-op, exactly like
   the trader's store). OnModuleInit/OnModuleDestroy setInterval (cadence = a new
   MM_NAV_INTERVAL_MS, default 60000), skip when nodeEnv==='test', explicit async tick(now?)
   for tests. This is DC-3 honest: NAV is DERIVED from snapshot() at write time; the durable
   record is the time series, not a second accounting path.
4. Query endpoint GET /api/market-making/nav?hours=24[&book=SYMBOL] on MmController →
   { points: MmNavRow[] } (desk curve by default, one book if ?book=). Returns the multi-day
   track record. Mirror the controller's existing JSON-with-bigint-as-string shape.
5. Wiring in market-making.module.ts: provide MmNavRepository (needs DbService — OPTIONAL, like
   the trader factory) + MmNavCron (needs ConfigService + MmPortfolioTrader + the repo). When
   MM_PERSIST is off OR no DbService, the cron must be a safe no-op so no-DB runs + every existing
   test pass unchanged (the trader's pattern is the template). Add MM_NAV_INTERVAL_MS to
   app-config (interface + factory + .env.example) under marketMaking.
6. Tests (offline-first): MmNavCron.tick maps a fake snapshot → the right desk + per-book rows
   (unit, fake repo + fake trader, no DB); the repository round-trip (describeIfDb, DB-gated,
   auto-skips with no Postgres); the endpoint shape. Keep them green with MM_PERSIST off by default.
7. Docs: flip docs/TELEMETRY_REQUIREMENTS.md §8 NAV criterion ⏳→✅ and §7 P3 → done; ROADMAP
   "Active — persistence" P3/durable-NAV → done; add the /api/market-making/nav curl +
   MM_NAV_INTERVAL_MS to docs/CHEATSHEET.md + .env.example; a SESSION_HISTORY entry.

VERIFY (offline) the acceptance criterion that the persisted desk NAV equals
meridian_desk_nav_units to the unit: a unit test that builds a snapshot, runs the cron tick
against an in-memory fake repo, and asserts the desk row's equity_units == BigInt(snapshot
.equityUnits) (the same number the telemetry collector sets on the gauge).

DEFINITION OF DONE: a migration creating an append-only mm_nav time series with app-role
SELECT+INSERT grants; a cron that writes desk + per-book equity each interval under MM_PERSIST
(no-op otherwise); GET /api/market-making/nav returns the curve; the persisted desk NAV matches
the ledger/gauge to the unit; with MM_PERSIST=false the full suite passes unchanged; tsc + jest
green; each phase committed on master with a Co-Authored-By trailer; a SESSION_HISTORY/ROADMAP
note records what shipped. Then push one well-named feature branch + open a PR (per CLAUDE.md §0).

CONSTRAINTS / CONVENTIONS: paper-only; honesty about the numbers is the whole game; modular
monolith (CLAUDE.md §6) — NAV is derived from snapshot() at write time, the table is the durable
record, never a parallel accounting path; swap-seam discipline (§7) — Postgres vs no-op, gated by
MM_PERSIST + DbService presence, safe default off; process.env only in app-config.factory.ts (§6);
append-only table with SELECT,INSERT grants only (the stat_arb_nav / treasury_movements posture);
`npm run start:dev` exits 144 in this sandbox, so VERIFY via `npx tsc --noEmit` + `npx jest` (hand
any live multi-hour curve run to me). Proceed autonomously to the end of the session.
```

---

## Why this goal (context for me, not part of the prompt)

It's the highest-value **self-contained, offline-verifiable, no-hand-off** piece left and the
explicit P3 stretch deferred from the telemetry-P1 session. It turns the live-only
`meridian_desk_nav_units` gauge into the *actual research deliverable* — a durable, queryable,
multi-day desk-NAV + per-book equity curve that survives restart — closing the last ⏳ acceptance
criterion in TELEMETRY_REQUIREMENTS §8 and tying telemetry to the restart-safe-books work. There's
a proven pattern to mirror (`stat_arb_nav` + `StatArbNavCron` + `StatArbRepository`), so it's a
clean engineering build with a sharp definition of done.

After P3, the natural follow-ups: stat-arb live persistence (extend restart-safe to stat-arb
books), telemetry P2 (structured JSON logs) + a starter Grafana dashboard, then the long live
capture+sweep (a hand-off, not active session work) and the capital allocator + agentic layer.
```
