# Phase 3 Session 6 — Verify the demo, then start the β-refit + risk module

> **Read first:** [docs/SESSION_HISTORY.md §Session 5](../docs/SESSION_HISTORY.md), [PHASED_PLAN.md §Phase 3](../PHASED_PLAN.md), and the existing [prompts/PHASE_3_DEMO_PROMPT.md](PHASE_3_DEMO_PROMPT.md) which scoped Session 5. Session 5 shipped the signal library, backtest runner, and demo dashboard but did **not** visually verify the running app. This session opens with that verification, then advances Phase 3 by one step.
>
> Current repo state (master, no uncommitted changes): 24 test suites, 150 tests green; `npx tsc --noEmit` clean. New code lives under `src/stat-arb/`.

---

## 0. Hard rails (do not violate)

- **Phase 2 legal formation still not done.** No real exchange connections. Mock-default. `RealBinanceVenue` stays dormant.
- **Modular monolith. One repo, one DB.** No new microservice. Per [CLAUDE.md §6](../CLAUDE.md).
- **`process.env` only in `src/config/app-config.factory.ts`.** No exceptions.
- **Append-only invariant for any new movement table.** If you add `stat_arb_trades` or `stat_arb_nav` this session, grant `SELECT, INSERT` only to `meridian_markets_app` and extend `src/database/append-only.int-spec.ts`.
- **No "do all the things" scope creep.** Pick exactly one of the work blocks below for this session. The others stay queued.

---

## 1. Mandatory first step — verify the Session 5 demo

Session 5 did not run the dashboard in a browser. Do this before anything else:

1. `npm run start:dev` (Postgres on :5433 must be up; otherwise the hedge module's DB-dependent code logs at boot but doesn't fail-fast — verify).
2. `curl -s http://localhost:3100/api/stat-arb/demo/run | jq '.metrics'` — expect a non-zero `totalTrades`, finite `sharpeRatio`, populated `maxDrawdownPct`.
3. Open `http://localhost:3100/demo` in a browser. Expect:
   - Header "Meridian Markets — Strategy Demo" + green "Mock Mode" badge.
   - Strategy card showing `BTC / ETH`, a numeric z-score, a regime chip.
   - Drawdown gauge with a populated horizontal bar.
   - Spread chart with a teal z-score line, red `±entry` dashes at ±1.2, grey `±exit` dashes at ±0.3.
   - Trade table with the last 10 closed trades.
4. Click **Run Demo**. Confirm the chart and trade table update without a page reload.

**If any of those don't work, fix before doing any new work.** Likely failure modes and their fixes:

- `index.html` not found at runtime → `nest-cli.json` asset glob didn't fire under `nest start`. Already handled in `demo-page.controller.ts` with three candidate paths (dist, src, `__dirname`); if all three miss, hardcode the right one and add a startup log.
- `Chart.js` CDN blocked offline → swap to a vendored copy in `public/vendor/`.
- `/api/stat-arb/demo/*` returns 404 → confirm `StatArbModule` is imported in `AppModule` and `DemoController` is in its `controllers` array.
- `/demo` returns 404 → confirm `DemoPageController` is in `StatArbModule`'s `controllers` array.

**Output of the verification step:** a one-paragraph note in the commit message saying "demo verified end-to-end in browser" with a screenshot path (or a brief text description of what was on screen).

---

## 2. Then pick ONE of these work blocks

### Block A — Sliding-window β refit + the live shadow-feed seam (Recommended)

This is Phase 3 Step 2 from PHASED_PLAN.md. It's the natural next step after the demo; it makes the strategy production-shaped without shipping any real venue connection.

**Scope (~40 net-new specs, ~600 lines):**

1. **`src/stat-arb/signal/sliding-cointegration.ts`** — new module:
   ```typescript
   export interface SlidingCointegrationResult {
     beta: number;
     pValue: number;
     halfLifeBars: number;
     fittedAtIndex: number;
   }
   export function slidingCointegration(
     logA: number[], logB: number[], windowBars: number, refitEveryBars: number
   ): SlidingCointegrationResult[]
   ```
   Re-fits Engle-Granger on each `refitEveryBars`-step sliding window. Returns one result per refit point with the bar index where it was fitted. Reuse `cointegrationTest` from Session 5; do not duplicate ADF logic.

2. **`src/stat-arb/backtest/pairs-strategy.ts`** — extend `PairsStrategy`:
   - New constructor option: `betaRefit: { enabled: boolean; windowBars: number; everyBars: number }`.
   - When enabled, re-fit β every `everyBars` using the trailing `windowBars` of history. Cache the latest β + `pValue` + `halfLifeBars` on the strategy for introspection by the dashboard.
   - Refuse to enter a new position if the cached `pValue > 0.10` — the pair is no longer cointegrated; sit on cash.

3. **`src/stat-arb/feed/` — live feed seam (mock-default):**
   - `live-feed.interface.ts` — `IBarFeed { nextBar(symbol: string): Promise<Bar | null> }`.
   - `mock-bar-feed.ts` — wraps `generateSyntheticFeed` so the dashboard can be driven by a streaming feed instead of a finite array.
   - `real-ccxt-feed.ts` — dormant stub. Throws `BarFeedNotConfiguredError`. Same posture as `RealBinanceVenue`.
   - `LIVE_FEED` symbol, registered in `StatArbModule` with the mock-default factory.

4. **Dashboard update:** add a small panel showing current β, current p-value, current half-life. Highlight in red when p-value > 0.10.

5. **Specs:**
   - `sliding-cointegration.spec.ts` (~8 specs) — golden vectors for refit cadence, β drift across windows, p-value rejection of decoupled pairs.
   - `pairs-strategy.spec.ts` net-new (~6 specs) — refit cadence, p-value gate, β cache update.
   - `mock-bar-feed.spec.ts` (~5 specs) — streaming semantics, end-of-feed behaviour.
   - `real-ccxt-feed.spec.ts` (~3 specs) — dormant stub throws on every method.

**Done when:** `npx tsc --noEmit` clean; `npx jest` green (190+ total); the dashboard's β panel updates as the demo runs; `git log -1` shows one coherent commit.

### Block B — Risk module: Kelly sizing + drawdown gate + venue cap

Phase 3 Step 3. Smaller surface than Block A; useful if Block A feels too big for one session.

**Scope (~25 net-new specs, ~350 lines):**

1. **`src/stat-arb/risk/kelly.ts`** — Kelly fraction calculator. Inputs: estimated edge (mean per-trade P&L / std), capital. Outputs: notional cap. Test: scale-invariance, zero-edge → zero fraction, half-Kelly variant.
2. **`src/stat-arb/risk/drawdown-gate.ts`** — `DrawdownGate.check(metrics): GateDecision`. Throws / returns PAUSE if `metrics.maxDrawdownPct > config.maxDrawdownPct`. Same shape as `HedgeCircuitBreaker`.
3. **`src/stat-arb/risk/venue-cap.ts`** — per-venue notional cap (concentration risk). Throws on breach.
4. **Wire into `BacktestRunner`:** pause new entries when any of the three gates fires. Add a `gateEvents` array to `BacktestResult` showing when and why.
5. **Specs:** kelly (6), drawdown-gate (5), venue-cap (5), backtest integration (4), demo controller surface for `gateEvents` (5).
6. **Dashboard:** add a "Gates" panel showing each gate's current status (green = open, red = paused) with the reason.

**Done when:** tsc clean; jest green; dashboard's gate panel renders three gate chips; one coherent commit.

### Block C — `stat_arb_trades` + `stat_arb_nav` persistence

Phase 3 Step 4. Adds the append-only persistence layer the demo currently lacks.

**Scope (~30 net-new specs, ~500 lines):**

1. New migration `migrations/1717000000000-StatArbTrades.ts`:
   - `stat_arb_trades` table: id, venue, symbol_a, symbol_b, side, entry_z, exit_z, entry_price_a_micros, entry_price_b_micros, exit_price_a_micros, exit_price_b_micros, pnl_units, fees_units, opened_at, closed_at, idempotency_key. UNIQUE `(venue, idempotency_key)`.
   - `stat_arb_nav` table: id, as_of, nav_units, open_position_count. Daily snapshot; UNIQUE on `(as_of::date)`.
   - Grant `SELECT, INSERT` on both to `meridian_markets_app`. CHECK constraints (positive notional where applicable; non-null PnL on closed trades).
2. **`src/stat-arb/persistence/stat-arb.repository.ts`** — TypeORM raw-SQL repository, same shape as `treasury.service.ts`.
3. **`BacktestRunner`** writes each closed trade through the repository when given an injected one (optional — keeps the demo's in-memory mode usable).
4. **`src/database/append-only.int-spec.ts`** — add 4 specs: `stat_arb_trades` append-only; `stat_arb_nav` append-only; CHECK constraints fire on bad input.
5. New `NavCron` — once per day at 00:05 UTC, computes NAV and inserts a row. Same `setInterval` pattern as `YieldSyncCron` / `HedgeMonitorCron`.

**Done when:** migration applies cleanly on a fresh DB; append-only specs green; one coherent commit.

---

## 3. Out of scope (deferred again)

- Funding-carry strategy and cross-venue spot-arb strategy (Phase 3 Step 5).
- Real Binance API integration (KYB gate).
- TimescaleDB / market-data ingest pipeline.
- NAV calculation against real-money capital (Phase 4 gate).
- Any change to the existing treasury or hedge modules.
- Adding `@nestjs/serve-static` — current `DemoPageController` works fine; swap only if a real asset pipeline is needed.

---

## 4. Suggested order of operations

1. (~10 min) Verify demo per §1. Commit a tiny "verified demo" doc note if anything had to be fixed.
2. (~5 min) `TaskList` to capture the chosen block's sub-tasks.
3. (~rest of session) Implement, test, commit, push.

---

## 5. Done when

1. §1 verification passes.
2. The chosen block from §2 is shipped: code + specs + dashboard touch where applicable.
3. `npx tsc --noEmit` clean.
4. `npx jest` green (target counts above).
5. `docs/SESSION_HISTORY.md` has a Session 6 entry with: what was verified, which block was picked, what shipped, architectural notes, open follow-ups.
6. One coherent commit on `master` (or two — one for the verify-doc note, one for the block). `Co-Authored-By` trailer on each.

---

## 6. Cross-references

- [docs/SESSION_HISTORY.md §Session 5](../docs/SESSION_HISTORY.md) — full surface from this session.
- [PHASED_PLAN.md §Phase 3](../PHASED_PLAN.md) — step list and gating criteria.
- [CLAUDE.md §6, §7](../CLAUDE.md) — modular monolith + mock-default discipline (binding).
- [courses/stat-arb/](../courses/stat-arb/) — math reference for cointegration, OU, Bertram thresholds.
