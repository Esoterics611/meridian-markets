# Phase 3 Demo Prompt — Stat-Arb Signal Library + Live Web Dashboard

> **Session goal:** build the Phase 3 stat-arb signal library, a deterministic backtest runner, and a live web dashboard at `http://localhost:3100/demo` that shows the system running for test traders, markets operators, and sales associates. This is the **demo session** — everything is mock-default, no real venue or real data.
>
> **Read first:** [PHASED_PLAN.md §Phase 3](../PHASED_PLAN.md), [docs/STAT_ARB_PLAN.md](../docs/STAT_ARB_PLAN.md), [docs/SESSION_HISTORY.md](../docs/SESSION_HISTORY.md) (Sessions 1–4 are complete; do not re-create what's there).

---

## 0. Hard constraints (do not violate)

- **Phase 2 legal formation is not done.** The stat-arb module is DEMO + SCAFFOLD only — no real exchange connections, no real trading, no solicitation of investors. It is a proof-of-concept for an internal audience. Per [PHASED_PLAN.md cross-phase dependency #1](../PHASED_PLAN.md): the build stays private; no real capital deployment until Phase 2 closes.
- **Modular monolith. One repo, one DB.** No new database, no microservice. Per [CLAUDE.md §6](../CLAUDE.md).
- **Mock-default discipline.** All stat-arb execution uses `MockTradingVenue`; real exchange connections stay dormant. Per [CLAUDE.md §7](../CLAUDE.md).
- **`process.env` only in `src/config/app-config.factory.ts`.** No exceptions.
- **Append-only invariant.** Any new DB table with movement semantics (`stat_arb_trades`, `stat_arb_nav`) must grant `SELECT, INSERT` only to `meridian_markets_app`. Extend `src/database/append-only.int-spec.ts` for each.

---

## 1. Already shipped (do not re-create)

```
Phase 0: src/treasury/          — complete (51 tests)
Phase 1: src/hedge/             — complete (47 tests); migration 1716000000000
courses/stat-arb/               — full course §0–§7, Appendix A–C, Material theme
```

**No code** exists yet under `src/stat-arb/`. This session creates it from scratch.

---

## 2. Scope — what to build

### 2.1 `src/stat-arb/signal/` — pure math layer (~20 specs)

Pure functions. No I/O. No NestJS decorators. Heavily tested with golden vectors.

**`cointegration.ts`**
```typescript
export interface CointegrationResult {
  beta: number;          // hedge ratio
  pValue: number;        // ADF test p-value on residuals
  halfLifeBars: number;  // ln(2) / theta, in number of bars
}

/** Engle-Granger two-step cointegration test on log-price series. */
export function cointegrationTest(
  logA: number[],
  logB: number[],
): CointegrationResult
```
Implementation: OLS regression (use matrix normal equations — no external math library needed; write 20-line `ols()` helper), then ADF on residuals via AR(1) test. Half-life = `ln(2) / |slope_of_ar1|`.

**`ou.ts`**
```typescript
export interface OuFit { theta: number; mu: number; sigma: number }
export interface BertramThresholds { entry: number; exit: number }

/** Fit an Ornstein-Uhlenbeck process via OLS on ΔX_t = θ(μ − X_t) + ε. */
export function ouFit(spread: number[]): OuFit

/** Bertram (2010) optimal entry/exit thresholds given OU params and transaction cost. */
export function bertramThresholds(fit: OuFit, txCostFraction: number): BertramThresholds
```

**`z-score.ts`**
```typescript
/** Rolling z-score with a sliding window of `lookback` bars. */
export function rollingZScore(series: number[], lookback: number): number[]

/** EWMA z-score with decay factor `lambda`. */
export function ewmaZScore(series: number[], lambda: number): number[]
```

**`spread.ts`**
```typescript
/** Compute log-price spread: S_t = log(A_t) − beta * log(B_t). */
export function logSpread(pricesA: number[], pricesB: number[], beta: number): number[]
```

**Specs (`*.spec.ts`):**
- `cointegration.spec.ts` (~6 specs) — known golden vectors: two perfectly cointegrated series (β=1, trivially stationary residuals) must return p < 0.05; two random walks must return p > 0.05 (usually — use large N to be reliable); half-life calculation with known AR(1).
- `ou.spec.ts` (~6 specs) — ouFit on a known OU simulation recovers mu and theta within tolerance; bertramThresholds returns entry > exit (not inverted).
- `z-score.spec.ts` (~5 specs) — golden vectors for rolling and EWMA z-score; edge cases (series shorter than lookback).
- `spread.spec.ts` (~3 specs) — logSpread arithmetic; β=1 gives price ratio spread.

### 2.2 `src/stat-arb/trading-venue.interface.ts` — execution swap seam

```typescript
export const TRADING_VENUE = Symbol('TRADING_VENUE');

export type Side = 'BUY' | 'SELL';

export interface PlaceOrderRequest {
  symbol: string;
  side: Side;
  notionalUnits: bigint;   // 6-decimal USDC units
  idempotencyKey: string;
}

export interface Fill {
  orderId: string;
  symbol: string;
  side: Side;
  filledUnits: bigint;
  priceMicros: bigint;     // execution price in micros (1e6)
  feesUnits: bigint;       // taker fees paid in USDC units
  executedAt: Date;
}

export interface ITradingVenue {
  readonly venueId: string;
  placeOrder(req: PlaceOrderRequest): Promise<Fill>;
  fetchPrice(symbol: string): Promise<bigint>;  // returns current mid price in micros
}

// Errors
export class TradingVenueNotConfiguredError extends Error { ... }
```

**`mock-trading-venue.ts`** — deterministic fills. Price is a sine-wave + linear drift seeded by `symbol` and `now`. Fee = taker fee fraction × notional. Injectable clock (same pattern as `MockHedgeVenue`).

**`real-binance-venue.ts`** — dormant stub, throws `TradingVenueNotConfiguredError` on every method. Same posture as `RealHyperliquidHedgeVenue`.

**Specs:** `mock-trading-venue.spec.ts` (~6 specs), `real-binance-venue.spec.ts` (~3 specs).

### 2.3 `src/stat-arb/backtest/` — event-driven backtest runner

```
src/stat-arb/backtest/
  bar.ts               Bar interface: { timestamp, open, high, low, close, volume }
  synthetic-feed.ts    Generates N bars of correlated mock price series for two symbols
  strategy.interface.ts  IStrategy: { onBar(bar: BarContext) → DesiredPosition[] }
  pairs-strategy.ts    Implements IStrategy using cointegration + OU signal
  backtest-runner.ts   Event loop: feed → strategy → mock venue → PnL attribution
  pnl-attribution.ts   Per-trade P&L + overall metrics (Sharpe, max drawdown, win rate)
  backtest.spec.ts     (~8 specs) End-to-end: synthetic correlated series → full run
```

**`BacktestRunner.run(config)`** returns:
```typescript
export interface BacktestResult {
  trades: TradeRecord[];
  metrics: {
    totalPnlUnits: bigint;
    sharpeRatio: number;
    maxDrawdownPct: number;
    winRate: number;
    totalTrades: number;
  };
  spreadSeries: { timestamp: Date; zScore: number; position: 'LONG' | 'SHORT' | 'FLAT' }[];
}
```

**Key invariant:** the backtest loop calls `IStrategy.onBar()` in chronological order, with no lookahead. The strategy only sees bars already consumed. This is testable: run two strategies on the same feed and verify they produce the same orders.

### 2.4 `src/stat-arb/demo/` — REST API + served dashboard

This is the deliverable that makes the demo work. No front-end build tooling — a single static HTML file served from NestJS's `@ServeStatic` (or custom middleware) and a set of API endpoints the page polls.

**Controller: `demo.controller.ts`**

```
GET /api/stat-arb/demo/run
  → runs a 90-bar backtest on a deterministic BTC/ETH correlated series
  → returns BacktestResult (all bigints as strings)

GET /api/stat-arb/demo/status
  → returns: pair, current z-score, regime (LONG/SHORT/FLAT), open P&L, positions, last-updated

GET /api/stat-arb/demo/history
  → returns the spreadSeries from the most recent run (timestamp + zScore + position)

POST /api/stat-arb/demo/reset
  → clears the in-memory demo state, runs a fresh backtest
```

No DB persistence for the demo — the state is in-memory only. The demo is not a production service; it's a presentable simulation.

**Static HTML dashboard: `src/stat-arb/demo/public/index.html`**

A single HTML file (~300 lines, no build toolchain, vanilla JS + Chart.js via CDN). Served at `GET /demo`. The page:

1. **Header:** "Meridian Markets — Strategy Demo" | "Mock Mode" badge | dark background
2. **Strategy card:** pair name, current z-score (styled: red = SHORT, green = LONG, grey = FLAT), open P&L in USDC, number of open/closed trades
3. **Drawdown gauge:** horizontal bar showing current drawdown vs the 5% gate threshold
4. **Spread chart:** Chart.js line chart of z-score over the last N bars with horizontal entry/exit threshold lines drawn. Entry points marked with triangles, exit points with X's.
5. **Trade table:** last 10 closed trades with: entry/exit z-score, direction, P&L, hold bars
6. **Backtest metrics card:** Sharpe ratio, win rate, max drawdown, total trades — rendered from the last `/api/stat-arb/demo/run` result
7. **Footer:** "Phase 3 scaffold — prop desk track-record mode. No real capital." + link to the stat-arb course at `/courses/`

Polled every 5 seconds via `fetch('/api/stat-arb/demo/status')`. Fresh run triggered by a "Run Demo" button that calls `POST /api/stat-arb/demo/reset`.

**Visual design:** dark mode, monospace accent font for numbers, Meridian brand accent colour (#00d4aa — a teal matching the Material course theme). Looks like a Bloomberg terminal fragment. Does NOT need to be pixel-perfect — it needs to look professional and be readable.

**Serving:** add `@nestjs/serve-static` to serve the `public/` directory, or use NestJS middleware. The HTML file uses only CDN-hosted scripts (no npm build).

### 2.5 `src/stat-arb/stat-arb.module.ts` + `AppModule` update

```typescript
@Module({
  providers: [
    { provide: TRADING_VENUE, inject: [ConfigService], useFactory: ... },
    DemoService,        // holds the in-memory BacktestResult
  ],
  controllers: [DemoController],
})
export class StatArbModule {}
```

Register `StatArbModule` in `AppModule`.

Add to `AppConfig`:
- `statArb.mockEnabled: boolean` (default `true`)
- `statArb.demoBarCount: number` (default `90` — 90 synthetic bars per backtest)
- `statArb.demoPairA: string` (default `'BTC'`)
- `statArb.demoPairB: string` (default `'ETH'`)

Add env vars `MOCK_TRADING_ENABLED`, `DEMO_BAR_COUNT`, `DEMO_PAIR_A`, `DEMO_PAIR_B` to `.env.example`.

---

## 3. Test targets

| Suite | Type | Count |
|---|---|---|
| `signal/cointegration.spec.ts` | unit | ~6 |
| `signal/ou.spec.ts` | unit | ~6 |
| `signal/z-score.spec.ts` | unit | ~5 |
| `signal/spread.spec.ts` | unit | ~3 |
| `mock-trading-venue.spec.ts` | unit | ~6 |
| `real-binance-venue.spec.ts` | unit | ~3 |
| `backtest/backtest.spec.ts` | unit | ~8 |
| `demo/demo.controller.spec.ts` | unit | ~5 |

**Total net-new: ~42 specs.** Repo total: 140+.

All specs are pure-unit (no DB, no network). `BacktestRunner` is tested with fully synthetic data from `SyntheticFeed`. The demo controller is tested with a mocked `DemoService`.

---

## 4. Math implementation notes

### OLS (used in cointegration + OU fit)
No external library. Implement once in `signal/_math.ts`:
```typescript
/** Ordinary least squares: y = a + b * x. Returns { a, b, residuals }. */
export function ols(x: number[], y: number[]): { a: number; b: number; residuals: number[] }
```
Test: known pairs (e.g., `x=[1,2,3]`, `y=[2,4,6]` → `{a:0, b:2}`).

### ADF p-value approximation
The exact ADF critical values require numerical tables. Use the MacKinnon (1994) response-surface approximation for the Engle-Granger case (two-variable, constant + no trend). Simplified version that's good enough:

- Fit AR(1): `ΔX_t = φ * X_{t-1} + ε`
- t-statistic = `φ / se(φ)` where `se(φ) = sqrt(σ²_ε / Σ X²_{t-1})`
- p-value ≈ ADF critical value interpolation:
  - `t < -3.90` → p < 0.01
  - `t < -3.34` → p < 0.05
  - `t < -3.04` → p < 0.10
  - `t ≥ -3.04`  → p > 0.10
- This is coarse but correct-directionally for golden-vector tests.

### Bertram thresholds (simplified)
The full Bertram (2010) paper solves a transcendental equation. For the demo, use the simplified analytical approximation:
- `entry = mu ± k * sigma / sqrt(2 * theta)` where `k ≈ 1.5` (derived from typical txCost values)
- `exit = mu` (close at mean reversion)
- Better: implement the Newton-Raphson solve from Appendix A of the course — it's 15 lines.

### Synthetic correlated feed
Generate two series where `logSpread = 0.5 * sin(2π * t / 30) + 0.1 * noise`. This produces a spread that oscillates with a ~30-bar period, perfectly demonstrating entry/exit cycles in the demo.

---

## 5. Demo narrative (for the walkthrough)

When presenting to traders, operators, and sales:

1. **Open the dashboard** at `http://localhost:3100/demo`. The chart shows the BTC/ETH spread oscillating with z-score overlaid, entry and exit thresholds highlighted.
2. **Click "Run Demo"** — a fresh 90-bar backtest runs and populates the trade table. Sharpe, win rate, and max drawdown appear in the metrics card.
3. **For traders:** "This is the pairs-trading strategy. The z-score goes to +2, we short the spread. It reverts, we close. Every entry and exit visible here corresponds to real cointegration math — this is the same signal described in the course §2–§3."
4. **For operators:** "The drawdown gate is here. If we hit 5%, the system pauses. The circuit breaker and staleness checks you see in the hedge module apply here too. Same architecture, different strategy."
5. **For sales:** "The metrics panel shows Sharpe 1.8+ on the mock data. That's what the track-record session (Phase 3, 12 months of real data) would produce with real capital. The course documents every assumption."

---

## 6. Serving the dashboard

**Option A (recommended):** `@nestjs/serve-static`
```typescript
// app.module.ts
import { ServeStaticModule } from '@nestjs/serve-static';
import { join } from 'path';

ServeStaticModule.forRoot({
  rootPath: join(__dirname, '..', 'src', 'stat-arb', 'demo', 'public'),
  serveRoot: '/demo',
  serveStaticOptions: { index: 'index.html' },
}),
```
Add `@nestjs/serve-static` to package.json dependencies.

**Option B (no new dep):** Add a single NestJS controller that reads and returns the HTML file:
```typescript
@Get('/demo')
@Header('Content-Type', 'text/html')
serveDemo(@Res() res: Response): void {
  res.sendFile(join(__dirname, 'public', 'index.html'));
}
```

Both work. Option A is cleaner if a real static asset pipeline is ever needed.

---

## 7. Out of scope (deliberately deferred)

- **Real exchange connections** (Binance, Coinbase, Kraken). Stays dormant.
- **DB persistence for the demo.** The demo state lives in `DemoService` (singleton NestJS injectable, in-memory). No new migration in this session.
- **Risk module** (`kelly.ts`, `drawdown-gate.ts`, `venue-cap.ts`). The demo uses a hardcoded drawdown gate in the backtest runner. Full risk module is a later session.
- **Funding-carry and cross-venue-spot-arb strategies.** One strategy (pairs trading + OU) is enough for the demo.
- **TimescaleDB, market data ingest, CCXT.** Live data feed is Phase 3 Step 5 (shadow run).
- **NAV calculation and audited reporting.** Phase 4 gate.

---

## 8. Done when

1. `npx tsc --noEmit` clean.
2. `npx jest` green (42+ new specs, 140+ total).
3. `http://localhost:3100/demo` serves the dashboard and shows:
   - Spread chart with z-score line and threshold bands
   - Metrics card (Sharpe, win rate, drawdown, trades)
   - Trade table with last 10 closed trades
   - Drawdown gauge
4. `GET /api/stat-arb/demo/run` returns a `BacktestResult` with `totalPnlUnits`, `sharpeRatio`, `winRate`, `maxDrawdownPct` populated (non-zero).
5. Clicking "Run Demo" in the dashboard triggers a fresh backtest and updates the chart.
6. `docs/SESSION_HISTORY.md` updated with a "Session 5 — Phase 3 demo" entry.
7. One coherent commit on `master`, `Co-Authored-By` trailer.

---

## 9. Suggested libraries

All already available in Node.js 20 / the existing package.json. No new npm dependencies needed for the core signal math. For the dashboard:
- **Chart.js** via CDN `<script>` in the HTML (no install).
- **`@nestjs/serve-static`** — one line add to `package.json` if using Option A.

If a matrix library is truly needed for OLS: use `ml-matrix` (MIT, 5kb gzipped) — but the 4×4 matrix normal equations for two-variable OLS don't need it.

---

## 10. Cross-references

- [PHASED_PLAN.md §Phase 3](../PHASED_PLAN.md)
- [CLAUDE.md](../CLAUDE.md) — binding architectural constraints
- [docs/STAT_ARB_PLAN.md](../docs/STAT_ARB_PLAN.md) — detailed signal + backtest architecture
- [courses/stat-arb/](../courses/stat-arb/) — full educational backdrop for every math choice
- [docs/SESSION_HISTORY.md §Session 4](../docs/SESSION_HISTORY.md) — what was built in the prior session
