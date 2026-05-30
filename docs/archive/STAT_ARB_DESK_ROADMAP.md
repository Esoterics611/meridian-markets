# Stat-Arb Desk — Roadmap and Per-Session Prompts

> **Purpose.** This doc is the master map of what a real stat-arb desk needs, what we have today, and the detailed prompts to ship the rest session by session. Each session block below is **self-contained** — copy it verbatim into the next Opus session.
>
> **Where this fits.** Phase 3 of [PHASED_PLAN.md](../PHASED_PLAN.md) is the stat-arb scaffold. This doc breaks the remainder of Phase 3 + Phase 4 (3(c)(7) fund readiness) into atomic sessions, with optional sessions queued behind feature gates.
>
> **Working note.** Sessions 7–9 correspond to Blocks A/B/C from [`prompts/PHASE_3_SESSION_6_PROMPT.md`](../prompts/PHASE_3_SESSION_6_PROMPT.md) — restated here with extra context. Sessions 10–18 are net new.

---

## 0. What a stat-arb desk actually needs (the 10-layer map)

Each layer is independently testable, has a single owner, and either exists today (✓), is queued (●), or is future-gated (○).

| # | Layer | What it owns | Status |
|---|---|---|---|
| 1 | **Universe / market-data** | Multi-venue ingest, normalised symbols, bar/tick storage, gap detection, replay engine, reference data | ○ Session 11 |
| 2 | **Signal / research** | Pair discovery, cointegration screening, OU fit, regime detection, signal decay tracking | ✓ scaffold (Session 5) · ● refit + universe expansion (S7, S16) |
| 3 | **Risk** | Position sizing, gates (DD / p-value / venue cap / exposure / correlation), VaR/ES, stress, slippage model | ● Session 8 |
| 4 | **Execution** | Order router, exec algos (TWAP/VWAP/POV/iceberg), slippage attribution, idempotency, kill-switch | ● Sessions 13, 14 |
| 5 | **Capital / accounting** | NAV cron, fee accrual, P&L attribution, cash mgmt, multi-strategy budget | ● Session 9 (NAV/trades), S10 (multi-strategy budget) |
| 6 | **Operations** | Daily reports, reconciliation cron, alerts (Slack/PagerDuty), latency mon | ● Session 15 |
| 7 | **Research / data-science** | Jupyter scaffold, walk-forward, parameter sweep, Monte Carlo, OOS validation | ● Session 12 |
| 8 | **Compliance / audit** | Append-only ledger ✓, trade audit, regulatory hooks, best-ex attestation, 3(c)(7) checks | ✓ ledger · ○ rest gated on Phase 2 legal formation |
| 9 | **UI / dashboards** | Trader / Risk / Investor / Research / Ops / Exec desks | ✓ three personas (Session 6 UI track) · ● Research + Ops + Exec desks |
| 10 | **Infrastructure** | Multi-venue API clients (Binance, Hyperliquid, Bybit, OKX, Drift), secrets/vault, feature flags, canary mode | ✓ secrets · ● rest behind KYB gate |

**Hard invariants that survive every session:**

- Phase 2 (legal formation) and Phase 4 (3(c)(7) fund) gates are not engineering decisions. Don't ship anything that touches real money or real venues until those close. Mock-default per CLAUDE.md §7.
- **One repo, one DB, one ordered migration history.** Modular monolith. CLAUDE.md §6 binding.
- **`process.env` only in `src/config/app-config.factory.ts`.** No exceptions.
- **Append-only invariant.** Any new movement-like table grants `SELECT, INSERT` only to `meridian_markets_app`. Extend `src/database/append-only.int-spec.ts` whenever a new table lands.
- **No cross-imports with Lira-Bridge.** HTTP-only via `ITreasuryClient`.

---

## 1. What we shipped in Session 6 (UI track)

Before the session-by-session prompts, document of-record on what just landed so Session 7 starts from a known state.

### 1.1 Server-side changes
- `src/stat-arb/demo/demo.service.ts`
  - `DemoScenario = 'calm' | 'trending' | 'volatile' | 'decoupled'` exported.
  - `runFreshBacktest(scenario?)` accepts a scenario; in-place price perturbation for `trending` / `decoupled` so existing synthetic-feed specs stay deterministic.
  - `DemoSnapshot` now exposes `allTrades`, `equityCurve` (`bigint[]` of cumulative realised P&L per bar), and `scenario`.
- `src/stat-arb/demo/demo.controller.ts`
  - `GET /api/stat-arb/demo/run?scenario=…`, `POST /api/stat-arb/demo/reset?scenario=…`.
  - `ApiSnapshot` carries `scenario`, `allTrades`, `equityCurve` (string-serialised bigints).
- `src/stat-arb/demo/demo.controller.spec.ts` mock updated to satisfy the new interface. **5/5 demo specs pass; `npx tsc --noEmit` clean.**

### 1.2 UI changes (`src/stat-arb/demo/public/index.html`)
- **Three personas** as hash-routed tabs: `#trader`, `#risk`, `#investor`.
- **Scenario selector** + **kill-switch** in the header. Kill switch paints a banner across the whole app and flips the Risk-view "Manual kill switch" chip to `ARMED`.
- **Trader view:** added **live spread tape** (last-60-bars sparkline inside the strategy card) + drawdown sparkline on the gauge card. Existing spread chart and trade tape preserved.
- **Risk view:** three gate cards (Drawdown / Cointegration / Venue cap) each with their own sparkline + chip; **Gate Event Log** built from `allTrades` + drawdown breaches; full kill-switch / circuit-breaker / KYB / append-only-ledger panels.
- **Investor view:** **real cumulative NAV chart** from the server's `equityCurve` (not the linear synthesis from the first cut); **underwater drawdown chart**; Calmar + Return cards.

### 1.3 Verify it locally (smoke checklist)

```bash
# 1. Postgres native on :5432 — create role + database once.
sudo -u postgres psql <<'SQL'
CREATE ROLE meridian_markets WITH LOGIN PASSWORD 'meridian_markets' CREATEROLE;
CREATE DATABASE meridian_markets OWNER meridian_markets;
SQL

# 2. .env overrides .env.example's :5433 → :5432.
cat > .env <<'ENV'
NODE_ENV=development
PORT=3100
DATABASE_URL=postgresql://meridian_markets:meridian_markets@localhost:5432/meridian_markets
DATABASE_URL_APP=postgresql://meridian_markets_app:meridian_markets_app@localhost:5432/meridian_markets
MOCK_YIELD_ENABLED=true
MERIDIAN_CLIENT_KEY=dev-secret-not-for-prod
ENV

# 3. Migrate + run.
npm install && npm run migration:run && npm run start:dev

# 4. Pre-warm and visit each persona.
curl -s -X POST 'http://localhost:3100/api/stat-arb/demo/reset?scenario=volatile' | jq '.metrics'
# Open: http://localhost:3100/demo#trader  /  #risk  /  #investor
# Try each scenario in the header dropdown — NAV curve and DD sparklines should re-shape.
```

---

## 2. Session prompts (drop into the next Opus session verbatim)

### Session 7 — Sliding-β refit + live shadow-feed seam (Block A from S6 prompt, expanded)

> **Read first:** [docs/STAT_ARB_DESK_ROADMAP.md §0, §1.2](./STAT_ARB_DESK_ROADMAP.md), [`prompts/PHASE_3_SESSION_6_PROMPT.md` §2.A](../prompts/PHASE_3_SESSION_6_PROMPT.md), [CLAUDE.md §6, §7](../CLAUDE.md).

**Hard rails:** modular monolith; no real venues; `process.env` only in factory; append-only for any new persisted table.

**Scope (~40 net-new specs, ~600 LOC):**

1. **`src/stat-arb/signal/sliding-cointegration.ts`**
   ```typescript
   export interface SlidingCointegrationResult {
     beta: number; pValue: number; halfLifeBars: number; fittedAtIndex: number;
   }
   export function slidingCointegration(
     logA: number[], logB: number[], windowBars: number, refitEveryBars: number,
   ): SlidingCointegrationResult[];
   ```
   Reuse `cointegrationTest` from Session 5 — do **not** duplicate ADF logic. Cache last refit result for cheap reads from the strategy.

2. **`src/stat-arb/backtest/pairs-strategy.ts` extension**
   - New constructor option: `betaRefit?: { enabled: boolean; windowBars: number; everyBars: number }`.
   - When enabled, re-fit every `everyBars`. Cache `{ beta, pValue, halfLifeBars }` on the strategy for the dashboard.
   - **p-value gate:** refuse new entries when cached `pValue > 0.10` — emit a `GateEvent` (see Session 8 — for now just log).

3. **`src/stat-arb/feed/` — live feed seam (mock-default):**
   - `live-feed.interface.ts` → `IBarFeed { nextBar(symbol: string): Promise<Bar | null> }`.
   - `mock-bar-feed.ts` wraps `generateSyntheticFeed` with streaming semantics.
   - `real-ccxt-feed.ts` dormant; throws `BarFeedNotConfiguredError`.
   - `LIVE_FEED` injection token registered in `StatArbModule` with the mock-default factory (mirror `TRADING_VENUE` factory pattern).

4. **Dashboard touch (`index.html`):**
   - On the Risk view, replace the synthetic p-value sparkline with real `pValue` history (poll a new `GET /api/stat-arb/demo/refits` returning the array of `SlidingCointegrationResult`).
   - Trader view: add a small β / half-life inline next to the pair label.

5. **Specs:** `sliding-cointegration.spec.ts` (8), `pairs-strategy.spec.ts` net-new (6), `mock-bar-feed.spec.ts` (5), `real-ccxt-feed.spec.ts` (3), demo refits endpoint (2).

**Done when:** `npx tsc --noEmit` clean; `npx jest` green (~190 total); β panel updates as the scenario changes; one commit on `master`.

---

### Session 8 — Risk module: Kelly + drawdown gate + venue cap + exposure caps

> **Read first:** [§0, §1.2](#) above; [`prompts/PHASE_3_SESSION_6_PROMPT.md` §2.B](../prompts/PHASE_3_SESSION_6_PROMPT.md).

**Hard rails:** all gates must be **pure functions of metrics + config**. No I/O. Wire them into `BacktestRunner` through an injected `IRiskEngine`.

**Scope (~50 specs, ~700 LOC):**

1. **`src/stat-arb/risk/kelly.ts`**
   - `kellyFraction(edge, variance): number` (Kelly per-trade fraction).
   - `halfKellyNotional(capital, edge, variance, vol): bigint` — the production size, half-Kelly default.
   - Tests: scale-invariance, zero-edge → zero, negative-edge → zero, large-vol shrinks size.

2. **`src/stat-arb/risk/drawdown-gate.ts`**
   - `DrawdownGate.check(metrics): GateDecision = { allow: boolean; reason?: string }`.
   - Same shape as `HedgeCircuitBreaker`.

3. **`src/stat-arb/risk/venue-cap.ts`**
   - Per-venue notional cap; trips on breach. Cache live notional from venue + position tracker.

4. **`src/stat-arb/risk/exposure-caps.ts`**
   - Gross exposure cap, net exposure cap, single-pair cap, single-side cap.

5. **`src/stat-arb/risk/correlation-cap.ts`**
   - Rolling pair-correlation cap across open positions (prevents accidentally doubling up on the same factor).

6. **`src/stat-arb/risk/risk-engine.ts`** — composes all of the above:
   ```typescript
   interface IRiskEngine {
     preTradeCheck(order: DesiredOrder, state: RiskState): GateDecision;
     sizeOrder(intent: OrderIntent, state: RiskState): bigint;
     evaluatePostTrade(state: RiskState): GateEvent[];
   }
   ```

7. **`BacktestRunner` integration:** inject `IRiskEngine`; emit `gateEvents` on `BacktestResult`. Skip entries when any gate denies — keep counters.

8. **Dashboard:** Risk-view gate cards display **live** chip + sparkline from real `gateEvents`. Add a fourth card: **Exposure** (gross / net bars). Wire the Event Log to real `gateEvents` instead of inferred.

9. **Specs:** kelly (8), drawdown (5), venue-cap (5), exposure (8), correlation (6), risk-engine integration (10), backtest with gates (5), demo serialisation (3).

**Done when:** tsc clean; jest green; Risk view's four gate cards render real chip + sparkline from `gateEvents`; one commit.

---

### Session 9 — Persistence: `stat_arb_trades` + `stat_arb_nav` + NAV cron

> **Read first:** [§0, §1.2](#) above; [`prompts/PHASE_3_SESSION_6_PROMPT.md` §2.C](../prompts/PHASE_3_SESSION_6_PROMPT.md); CLAUDE.md §3 (append-only invariants).

**Hard rails:** new tables get `SELECT, INSERT` only to `meridian_markets_app` (NO `UPDATE`/`DELETE`). Extend `src/database/append-only.int-spec.ts` — non-negotiable.

**Scope (~30 specs, ~500 LOC):**

1. **`migrations/1717000000000-StatArbTrades.ts`**
   - `stat_arb_trades`: `id`, `venue`, `symbol_a`, `symbol_b`, `side`, `entry_z`, `exit_z`, `entry_price_a_micros`, `entry_price_b_micros`, `exit_price_a_micros`, `exit_price_b_micros`, `pnl_units`, `fees_units`, `opened_at`, `closed_at`, `idempotency_key`. UNIQUE `(venue, idempotency_key)`. CHECK `notional_units > 0`.
   - `stat_arb_nav`: `id`, `as_of`, `nav_units`, `open_position_count`. UNIQUE `(as_of::date)`. CHECK `nav_units >= 0`.
   - GRANT `SELECT, INSERT` on both to `meridian_markets_app`.

2. **`src/stat-arb/persistence/stat-arb.repository.ts`** — raw-SQL repo mirroring `treasury.service.ts`. Methods: `insertTrade`, `insertNav`, `recentTrades(limit)`, `navHistory(fromDate)`.

3. **`BacktestRunner` integration:** optional injected repo; when present, persists each closed trade. Keeps in-memory mode usable for the demo.

4. **`src/database/append-only.int-spec.ts`** — add 4 specs: insert ok, `UPDATE` denied, `DELETE` denied, CHECK constraint fires.

5. **`src/stat-arb/persistence/nav.cron.ts`** — `@Cron` at 00:05 UTC, computes NAV from trades + open positions, inserts a row. Same `setInterval` pattern as `YieldSyncCron` / `HedgeMonitorCron`. Idempotent per-day via the UNIQUE index.

6. **Dashboard:** Investor view reads NAV from `/api/stat-arb/nav?from=…&to=…` (new endpoint) instead of deriving in JS. Risk view's Append-only Ledger Proof flips both new rows to `SELECT, INSERT` + tick mark.

7. **Specs:** repo unit (6), repo int (4), nav cron (5), append-only invariants (4), backtest persistence integration (4), nav endpoint (4), demo regression (3).

**Done when:** migration applies cleanly on a fresh DB; append-only specs green; NAV cron persisted overnight; one commit.

---

### Session 10 — Multi-strategy router + funding-carry + capital budget

> **Read first:** [§0](#0-what-a-stat-arb-desk-actually-needs-the-10-layer-map); the existing `PairsStrategy` and `IStrategy` interface; [courses/stat-arb/](../courses/stat-arb/).

**Why now:** the desk runs N strategies in parallel, sharing one capital pool. The router decides who gets what. Funding-carry is the easiest second strategy because it consumes a different signal (perp funding rate) but the same execution path.

**Scope (~70 specs, ~900 LOC):**

1. **`src/stat-arb/strategies/strategy-registry.ts`** — registry interface; each strategy declares `id`, `capitalRequest()`, `onBar()`.

2. **`src/stat-arb/strategies/funding-carry.ts`**
   - Reads perp funding rate (mock provider, dormant CCXT real-provider).
   - Long perp + short spot when funding < 0; reverse when > 0.
   - Half-life-driven exit (funding regime flip).

3. **`src/stat-arb/strategies/basis-arb.ts`** (stretch)
   - Spot vs perp basis; converges at funding settlement.

4. **`src/stat-arb/capital/budget-allocator.ts`**
   - Strategies declare requested notional + estimated Sharpe.
   - Allocator computes per-strategy capital via mean-variance with constraints.
   - Tested against a fixed scenario fixture.

5. **`src/stat-arb/funding/` provider seam:**
   - `funding-rate.interface.ts` + mock + dormant real.

6. **Dashboard:** new top-level **Strategies** card on Trader view: per-strategy P&L, capital allocation %, regime chip. Investor view shows per-strategy attribution.

7. **Specs:** registry (5), funding-carry signal (10), funding-carry strategy (10), basis-arb (10 — stretch), allocator (15), router integration (10), funding-rate providers (10).

**Done when:** two strategies run concurrently in one backtest with shared capital; per-strategy P&L attributable; one commit.

---

### Session 11 — Market-data ingest: TimescaleDB + normalised symbols + replay

> **Read first:** [§0 layer 1](#0-what-a-stat-arb-desk-actually-needs-the-10-layer-map). This unlocks every later session — backtests against real history, not synthetic.

**Hard rails:** TimescaleDB is a Postgres extension, **same DB instance** as Meridian Markets. No separate cluster — that violates the modular monolith. Add the extension via migration.

**Scope (~50 specs, ~800 LOC):**

1. **`migrations/1718000000000-MarketData.ts`**
   - `CREATE EXTENSION IF NOT EXISTS timescaledb;`
   - `market_bars`: `venue`, `symbol`, `ts`, `open_micros`, `high_micros`, `low_micros`, `close_micros`, `volume_micros`. Hypertable on `ts`.
   - `funding_rates`: `venue`, `symbol`, `ts`, `rate_micros`. Hypertable.
   - Continuous aggregates: 1m → 5m → 1h.
   - GRANT `SELECT, INSERT` to `meridian_markets_app`. UPDATE/DELETE denied.

2. **`src/market-data/symbol.ts`** — `NormalisedSymbol` (e.g. `BTC-USDT.spot.binance` → `{ base: 'BTC', quote: 'USDT', kind: 'spot', venue: 'binance' }`).

3. **`src/market-data/ingest/` — mock-default:**
   - `bar-ingest.interface.ts` → `nextBatch()`.
   - `mock-bar-ingest.ts` — replays a CSV fixture.
   - `ccxt-bar-ingest.ts` dormant.
   - Gap detection: if `ts(n) - ts(n-1) > expected`, write a `data_gaps` row.

4. **`src/market-data/replay/replay-engine.ts`**
   - Streams historical bars from `market_bars` for backtest determinism.

5. **Dashboard:** **Data Quality** card on the Risk view — last bar age per symbol, gap count last 24h.

6. **Specs:** symbol parsing (8), ingest interface (10), gap detection (6), replay engine (10), continuous aggregate refresh (4), Hypertable migration (4), data-quality endpoint (4), append-only invariants (4).

**Done when:** TimescaleDB extension live in dev; one mock fixture replays through a backtest; gap-detection writes rows; one commit.

---

### Session 12 — Walk-forward + parameter sweep + Monte Carlo

> **Read first:** [§0 layer 7](#0-what-a-stat-arb-desk-actually-needs-the-10-layer-map). Needs Session 11 (real-history backtest) to be load-bearing.

**Scope (~60 specs, ~900 LOC):**

1. **`src/stat-arb/research/walk-forward.ts`** — train on window W, test on holdout H, slide, repeat. Yields a `WalkForwardReport` with per-window Sharpe + Calmar.
2. **`src/stat-arb/research/parameter-sweep.ts`** — grid search over strategy params. Parallelised via `Promise.all` (single-process for now).
3. **`src/stat-arb/research/monte-carlo.ts`** — bootstrap returns to derive P&L distribution. Outputs 5th/50th/95th percentile curves.
4. **`src/stat-arb/research/look-ahead.ts`** — guard that asserts no future bar is read inside a strategy callback. Property-based test fixture.
5. **Dashboard:** new persona — **Research desk** (4th tab). Tabular walk-forward results, parameter-sweep heatmap, Monte Carlo fan chart.
6. **Specs:** walk-forward (15), sweep (15), MC (10), look-ahead guard (10), research endpoint (5), regression on existing backtest (5).

**Done when:** a parameter sweep over `entryZ ∈ {1.0, 1.2, 1.5, 2.0}` × `exitZ ∈ {0.0, 0.3, 0.5}` runs to completion; heatmap renders on the Research desk; one commit.

---

### Session 13 — Execution: order router + slippage model + exec algos

> **Read first:** [§0 layer 4](#0-what-a-stat-arb-desk-actually-needs-the-10-layer-map). Needs Session 11 (order-book depth in `market_bars`).

**Scope (~70 specs, ~1100 LOC):**

1. **`src/execution/order-router.ts`** — given a `DesiredOrder` and N venues, picks the venue + size split that minimises modelled slippage. Pluggable cost model.
2. **`src/execution/slippage-model.ts`** — Kyle-lambda-ish: linear price impact in size / ADV. Calibrated from real fills (later) or volume proxy (now).
3. **`src/execution/algos/twap.ts`**, **`vwap.ts`**, **`pov.ts`**, **`iceberg.ts`** — each implements `IExecAlgo { sliceOrder(parent, marketState): ChildOrder[] }`.
4. **`src/execution/exec-event.ts`** — child order → fill → reconcile.
5. **Risk integration:** every `IExecAlgo` consults `IRiskEngine.preTradeCheck` for each child slice (so a fast-firing TWAP can't bypass venue cap).
6. **Dashboard:** **Exec desk** (5th tab). Live child-order stream, fill quality, theory-vs-realised slippage attribution.
7. **Specs:** router (12), slippage model (8), TWAP (10), VWAP (10), POV (10), iceberg (8), slippage attribution (8), risk-integration (8).

**Done when:** a parent order routes across two mock venues with measurable slippage; exec desk renders; one commit.

---

### Session 14 — Paper-trading mode + canary rollout

> **Read first:** [§0 layer 10](#0-what-a-stat-arb-desk-actually-needs-the-10-layer-map); CLAUDE.md §7 (mock-default).

**Scope (~40 specs, ~600 LOC):**

1. **`src/execution/paper-venue.ts`** — `RealBinanceVenue`-shaped class that *consumes* live market data but writes orders to `paper_orders` instead of hitting the API. KYB-independent.
2. **`src/execution/canary-router.ts`** — splits a parent order: X% via paper, (1-X)% via real once KYB closes. Default X=100%.
3. **`src/execution/reconciliation.cron.ts`** — every 60s, compare internal book vs venue book (paper or real); emit alerts on drift.
4. **Feature flag:** `EXECUTION_MODE=mock|paper|canary|live`; only `mock` (default) and `paper` ship; canary/live blocked behind a startup assertion that the relevant KYB has closed.
5. **Specs:** paper venue (15), canary router (10), reconciliation cron (10), feature-flag boot guard (5).

**Done when:** flipping `EXECUTION_MODE=paper` against a TimescaleDB replay writes paper orders that reconcile; one commit.

---

### Session 15 — Ops: daily report + alerts + reconciliation

> **Read first:** [§0 layer 6](#0-what-a-stat-arb-desk-actually-needs-the-10-layer-map). Needs Sessions 9 (NAV), 11 (data), 14 (paper).

**Scope (~40 specs, ~600 LOC):**

1. **`src/ops/daily-report.ts`** — renders `DailyReport` (NAV, top winners/losers, gate fires, exec quality) as HTML email + Slack-compatible markdown.
2. **`src/ops/daily-report.cron.ts`** — runs at 06:00 UTC; idempotent per day.
3. **`src/ops/alerts/` — sink abstractions:**
   - `IAlertSink` → `slack-sink.ts` (webhook), `pagerduty-sink.ts`, `email-sink.ts`, all dormant by default + KYB-style env-flag gated.
   - Alert rules: drawdown breach, venue outage, data gap > N min, fill drift, kill-switch armed.
4. **Dashboard:** **Ops desk** (6th tab). Recent alerts, reconciliation status, cron health.
5. **Specs:** report rendering (10), report cron (5), alert rules (15), sink abstractions (10).

**Done when:** dry-run daily report renders to console; alert rules fire on injected scenarios; one commit.

---

### Session 16 — Universe expansion + pair discovery + regime detection

> **Read first:** [§0 layer 2](#0-what-a-stat-arb-desk-actually-needs-the-10-layer-map); courses/stat-arb/ (the math reference). Needs Session 11 (history).

**Scope (~60 specs, ~900 LOC):**

1. **`src/stat-arb/discovery/pair-discovery.ts`** — given a symbol universe, score every pair on cointegration p-value + OU half-life + average daily volume. Output: ranked list with diagnostic columns.
2. **`src/stat-arb/discovery/clustering.ts`** — hierarchical clustering by correlation; prevents discovery picking dozens of near-duplicate pairs.
3. **`src/stat-arb/regime/regime-detector.ts`** — volatility regime classifier (low/normal/high) + trend regime + decoupling alarm (cointegration p-value rolling > 0.10).
4. **`src/stat-arb/discovery/signal-decay.ts`** — tracks per-pair Sharpe rolling window; flags pairs whose alpha decayed.
5. **Dashboard:** Research-desk addition — **Universe** card: top-20 ranked pairs, with one-click "promote to live" (logs intent, doesn't actually flip; KYB gates).
6. **Specs:** pair discovery (15), clustering (10), regime detection (15), decay tracking (10), promote-intent endpoint (5), regression (5).

**Done when:** discovery surfaces a ranked pair list from a TimescaleDB replay window; Research-desk universe card renders; one commit.

---

### Session 17 — Capital structure: fee accrual + high-water mark + tax lots

> **Read first:** Phase 4 gate criteria in PHASED_PLAN.md. **This session is gated on legal-formation Phase 2 closing.** Don't start until the entity exists and there's a real fund document.

**Scope (~50 specs, ~700 LOC):** management-fee accrual cron, performance-fee with HWM, fee-class abstraction (founders / standard), tax-lot tracking (FIFO/LIFO/HIFO), 3(c)(7) eligibility checks. Investor desk gains a per-LP NAV view.

**Done when:** an LP-class fixture rolls through 12 months of mock returns, fees accrue against the right base, HWM resets correctly; one commit.

---

### Session 18 — Real venue activation: Binance + Hyperliquid (KYB-gated)

> **Read first:** CLAUDE.md §7; PHASED_PLAN.md Phase 3 live criteria. **Gated on Sessions 13+14 shipped and KYB closed at both venues.**

**Scope (~50 specs, ~700 LOC):** real CCXT adapters with rate-limit handling, signed-request testing harness against testnet, key rotation via `ISecretProvider`, startup assertions that refuse to boot in `live` mode without KYB env-flag set, mandatory reconciliation cron in `live` mode.

**Done when:** testnet round-trip works; live-mode boot assertions pass on a configured fixture; one commit. Real-money flip remains a separate written approval, **not** an engineering step.

---

## 3. Cross-cutting backlog (slot into any session where it fits)

- **Backtest determinism CI gate.** A spec that runs the demo backtest twice with identical inputs and asserts byte-identical `BacktestResult`. Add to `src/stat-arb/backtest/backtest.spec.ts` — small, high-value, fits in any session.
- **Latency / wall-clock instrumentation.** Hook into NestJS interceptor; report p50/p95/p99 of each endpoint to a metrics sink. Lands cleanly inside Session 15.
- **Course/dashboard cross-link.** Each Risk-view chip should deep-link to the relevant chapter in `courses/stat-arb/`. Tiny CSS+href change.
- **Vendor Chart.js.** Drop the `cdn.jsdelivr.net` dependency before any prod demo. Copy the UMD bundle into `src/stat-arb/demo/public/vendor/` and update the script tag. Five-minute task.
- **API key rotation runbook.** As part of Session 18, write `docs/RUNBOOK_KEY_ROTATION.md` capturing how to rotate `MERIDIAN_CLIENT_KEY`, exchange keys, and database passwords without downtime.
- **Strategy-promotion ladder.** Codify the path `discovery → paper → canary → live` as a single `PromotionDecision` row with audit trail. Lands in Session 16 or as a follow-up.

---

## 4. Session ordering — recommended path

```
Session 7  (β refit)         ─┐
Session 8  (risk module)     ─┼─ ship Phase 3 production-shape signal+risk
Session 9  (persistence)     ─┘
Session 10 (multi-strategy)  ─┐
Session 11 (TimescaleDB)     ─┼─ desk capability: real history + real strategies
Session 12 (research)        ─┘
Session 13 (exec)            ─┐
Session 14 (paper/canary)    ─┼─ execution maturity, still no real money
Session 15 (ops)             ─┘
Session 16 (universe)        ─── alpha breadth
─── PHASE 2 LEGAL FORMATION GATE ───
Session 17 (fees/HWM/LP NAV) ─── needs entity to exist
─── KYB GATE (Binance + Hyperliquid) ───
Session 18 (real venues)     ─── still not real money — Phase 4 gate is separate
─── PHASE 4 FUND GATE ───   ─── first customer capital allowed
```

You can swap 10↔11 if synthetic-feed multi-strategy is more useful than a single strategy on real history. Everything from Session 13 onward becomes substantially easier with Session 11 done.

---

## 5. What this doc deliberately does NOT do

- **Decide the legal entity, fund structure, or fee terms.** Those are external; this doc only references the gates.
- **Re-litigate modular monolith.** Settled — CLAUDE.md §6.
- **Spec a UI framework.** Static HTML + Chart.js gets us through Phase 3 and arguably Phase 4 demo-day. A move to a real framework (Svelte / Next / Remix) is a single net-new session whenever it becomes load-bearing — **not before**.
- **Plan Lira-Bridge-side work.** That repo has its own roadmap; the only coupling is the `ITreasuryClient` HTTP contract in `docs/INTEGRATION_WITH_LIRA_BRIDGE.md`.

---

*Roadmap drafted Session 6 (UI track). Update this doc whenever a session ships — keep the §0 status column truthful.*
