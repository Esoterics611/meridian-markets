# Statistical Arbitrage — Plan & Research

> **Scope:** Phase 3 prop desk (per [PHASED_PLAN.md](../PHASED_PLAN.md)). **Own capital only. No customer money, no advisory surface.** Stat-arb sits inside Phase 3 alongside the three strategies already listed there (cross-venue spot arb, funding-rate carry, spot/futures basis).
>
> **Status:** planning doc — no code written yet. All external repo URLs are **`unverified`** in this draft (network access was unavailable when this was written); next session must spot-check each before committing to it as a reference.

---

## 1. Why stat arb fits the Phase 3 envelope

Statistical arbitrage is the canonical "build infrastructure that earns Phase 4 the right to exist" strategy. It's not an edge — the strategies are taught in textbooks — but it generates the artifacts the fund cannot fake: audited daily NAV, multi-strategy attribution, drawdown discipline. PHASED_PLAN.md §Phase 3 already commits to a 12-month audited track record as the Phase-4 gate; stat-arb is the cheapest book of strategies that produces that record.

Regulatorily it's clean for the same reason the rest of Phase 3 is clean: own capital, no advice, no third-party AUM. The instant we publish strategy results or solicit investors, we cross the line into Phase 4 (or trip §203(m)). So the build is private until Phase 2 formation closes.

What stat-arb adds beyond the three strategies PHASED_PLAN.md already enumerates: (a) **pairs trading / cointegration** — exploits temporary spread divergence between two correlated assets, works on every venue with two-tradable-asset pairs, the canonical "first quant strategy" because the infra it forces you to build (cointegration tests, half-life estimation, z-score gating, position-sizing under mean reversion) is the same infra everything else needs; (b) **OU mean-reversion** — a more general form of pairs trading on a single synthesized spread, gives you a parameterised entry/exit policy instead of static z-thresholds; (c) **kelly-shrunk portfolio construction** — the layer that turns three uncorrelated strategies into one book with better Sharpe than any of them alone. Cross-venue spot arb and funding-carry are already in scope; we don't duplicate them here.

The honest framing: stat-arb is **table stakes for the prop desk**, not a moat. Skipping it means launching Phase 4 with one or two strategies; including it means launching with five or six, with measured cross-correlation. Investors discount the former to zero.

---

## 2. Strategy taxonomy

### 2.1 Pairs trading (cointegration)

**Idea.** Two assets `A` and `B` are *cointegrated* if there exists a hedge ratio `β` such that the spread `S_t = log(A_t) − β · log(B_t)` is stationary (mean-reverting) even though `A_t` and `B_t` themselves are not. When `S_t` drifts above its long-run mean by more than `k · σ`, short `A`/long `β·B`; reverse when it drifts below. Close when it reverts to the mean.

**Math sketch (Engle-Granger two-step).**
1. Regress `log(A_t) = α + β · log(B_t) + ε_t`; β is the hedge ratio.
2. Run an Augmented Dickey-Fuller test on the residuals `ε_t`. Reject the unit-root null (p < 0.05 typical) ⇒ cointegrated.
3. Estimate `θ` (mean-reversion speed) and `σ` of the residual process; **half-life** = `ln(2) / θ`. If half-life > your holding-horizon tolerance, drop the pair.

For multi-asset baskets use **Johansen's test** instead — it finds *all* cointegrating vectors simultaneously rather than testing one direction at a time.

**When it works.** Same-sector equities, BTC/ETH on different venues, ETH/staked-ETH (always cointegrated by construction), stablecoin pairs (USDC/USDT), index vs ETF.

**When it breaks.** Regime change (one asset gets a structural catalyst — token unlock, listing, regulatory event). The cointegration relationship is *empirical*, not causal; re-test the relationship daily and pull positions when it weakens.

**Code shape.** Pure function `cointegrationTest(seriesA: number[], seriesB: number[]): { beta: number; pValue: number; halfLifeBars: number }` in `signal/`. Tested with golden vectors from a known reference implementation. No I/O.

### 2.2 OU mean-reversion

**Idea.** Generalises pairs trading. Fit the spread to an Ornstein-Uhlenbeck process `dX_t = θ(μ − X_t)dt + σ dW_t`. Given `θ, μ, σ`, the **Bertram (2010)** result gives optimal entry/exit thresholds that maximise expected return per unit time subject to a fixed transaction cost.

**Math sketch.** OLS regression of `ΔX_t` on `X_t` recovers `θ` (slope) and `μ` (intercept / slope). Plug into Bertram's closed-form to get entry threshold `a` and exit threshold `b` — both expressed in units of `σ` above/below `μ`.

**When it works.** Any spread that *passes* the cointegration test from §2.1 — OU is the "what to do once you've found one" companion to "is there one."

**When it breaks.** `θ` is non-stationary (the speed of mean reversion itself changes). Detect by rolling-window re-estimation and tripping a kill switch when `θ` drops below a floor.

**Code shape.** `ouFit(spread: number[]): { theta: number; mu: number; sigma: number }`; `bertramThresholds(theta, mu, sigma, txCost): { entry: number; exit: number }`. Same `signal/` layer.

### 2.3 Cross-venue spot arb

Already in [PHASED_PLAN.md §Phase 3](../PHASED_PLAN.md). Not duplicated here. Stat-arb borrows its **execution router** and **fee model** from this strategy's infra — both need to exist to backtest pairs trading honestly.

### 2.4 Funding-rate carry / basis trade

Already in [PHASED_PLAN.md §Phase 3](../PHASED_PLAN.md). Not duplicated. Note: funding-rate signals overlap with the FX-hedge module's funding telemetry (Phase 1 `IHedgeVenue.fetchHealth()` reports `lastFundingBps`); future versions of the strategy library can consume the same data stream.

### 2.5 Index / basket arb (likely defer)

Less applicable to crypto — there are few liquid index products vs constituents (ETH-staking indices, DeFi indices, but most are illiquid). One paragraph for completeness; do not build until there's a specific opportunity. Mention only because the same Johansen-test machinery serves it.

---

## 3. Reference repositories

All entries below are **`unverified`** — drawn from the author's training knowledge. **Next session must spot-check via WebFetch before relying on any specific path.**

| Repo | License (recall) | What to copy | What NOT to copy |
|---|---|---|---|
| `hudson-and-thames/mlfinlab` *(unverified)* | BSD-3 (recall) | Cointegration tests, fractional differentiation, purged k-fold CV (Marcos López de Prado, *Advances in Financial Machine Learning*) | Pandas-heavy; reshape to columnar TS structures, do not literal-port |
| `hudson-and-thames/arbitragelab` *(unverified — may now require commercial license)* | Mixed (recall — verify) | Engle-Granger, Johansen, Bertram-optimal thresholds, copula pairs | Same Pandas issue; licensing may have changed — verify before depending |
| `quantopian/zipline` *(unverified — archived after Quantopian shut down)* | Apache-2 (recall) | Event-driven backtester loop structure; `BarData` / `Algorithm` separation | Equity-only data model; minute bars only; don't port the data layer |
| `quantopian/research_public` *(unverified — archived)* | Apache-2 (recall) | Notebook-style strategy templates that map cleanly to "one strategy = one file" | Notebook format itself — we want versioned TS files |
| `robcarver17/pysystemtrade` *(unverified)* | GPL-3 (recall — **GPL is a problem for proprietary code; read for ideas, do not copy line-for-line**) | Position-sizing and risk-overlay structure; the "stages" composition pattern | License: GPL contaminates derivatives; read-only |
| `jesse-ai/jesse` *(unverified)* | MIT (recall) — closest reference in our language family, though Python not TS | Strategy lifecycle hooks; live/backtest unified API | Python type system; reshape with strict TS types |
| `freqtrade/freqtrade` *(unverified)* | GPL-3 (recall — same license issue) | Hyperopt loop; strategy/backtest separation | License; specific exchange adapters (we'll build our own atop CCXT or direct WS) |
| `nautilustrader/nautilus_trader` *(unverified)* | LGPL-3 (recall) | Modern event-driven architecture; Rust core for hot path; venue abstraction | LGPL is workable but constrains; treat as architectural reference, not dependency |
| `tradytics/eiten` *(unverified)* | GPL-3 (recall) | Portfolio optimization (Eigen, Maximum Sharpe, Kelly) | License; small-cap niche |
| QuantConnect Lean *(unverified)* | Apache-2 (recall) | C# event-driven engine; well-documented backtest/live parity | C#-isms; we don't run on .NET |

**Top 3 code-shape lessons (independent of any specific repo):**
1. **Backtest loop and live loop run the same strategy code.** The only difference is the source of `Bar` events and the destination of `Order` events. If your strategy reads from a `DataFeed` and writes to an `ExecutionRouter` interface, the two loops differ only in which concrete implementation is wired in. Anything else is the bug factory that has killed every in-house quant platform.
2. **Strategy = pure function of (state, new bar) → (next state, orders).** Side-effect-free strategies are testable with golden vectors. The moment your strategy touches the DB or the clock directly, it stops being testable, and untestable strategies blow up in production.
3. **Signal/strategy/execution are three separate layers, and they must compose.** Signals are pure-math: `(prices) → number`. Strategies turn signals into orders: `(signals, portfolio) → orders`. Execution turns orders into fills: `(orders, venue) → fills`. The combinatorial advantage — one signal feeds many strategies, one strategy targets many venues — only pays off if the layers are actually decoupled.

---

## 4. Code architecture for Meridian Markets

Slots into the existing modular monolith (per [CLAUDE.md §6](../CLAUDE.md)). One repo, one DB, one ordered migration history — no microservices, no polyrepo, no shared types with Lira-Bridge.

Proposed module layout:

```
src/stat-arb/
  signal/                       Pure functions. No I/O. Heaviest tested layer.
    cointegration.ts            Engle-Granger + ADF
    johansen.ts                 Multi-asset cointegration
    ou.ts                       OU fit + Bertram thresholds
    half-life.ts                Mean-reversion half-life from AR(1) coefficient
    z-score.ts                  Rolling z, EWMA z
    *.spec.ts                   Golden-vector specs per file

  strategy/                     Compose signals → entry/exit decisions.
    pairs-trading.strategy.ts   One file per strategy.
    ou-reversion.strategy.ts
    funding-carry.strategy.ts   Phase-3 third strategy from PHASED_PLAN.md
    strategy.interface.ts       IStrategy: onBar(bar, ctx) → orders
    *.spec.ts                   Strategy tests use synthetic bars (no real data)

  execution/                    Venue abstraction. Mirrors IHedgeVenue / IYieldProvider.
    trading-venue.interface.ts  ITradingVenue + ORDER types
    mock-trading-venue.ts       Default. Deterministic fills.
    real-binance-venue.ts       Dormant until KYB / API keys provisioned.
    execution.module.ts         Factory selects mock vs real

  backtest/                     Replay loop. Same strategy code as live.
    bar-feed.interface.ts       IBarFeed: yields BarEvent in time order
    historical-bar-feed.ts      Reads from Parquet or columnar store
    backtest-runner.ts          The loop; wires feed → strategy → mock venue
    pnl-attributor.ts           Per-strategy P&L decomposition
    backtest.spec.ts            End-to-end specs with synthetic data

  risk/                         Position sizing, drawdown gate, venue cap.
    kelly.ts                    Fractional Kelly with shrinkage
    drawdown-gate.ts            Kills trading on N% peak-to-trough
    venue-cap.ts                Per-venue exposure ceiling
    risk.module.ts

  nav/                          Daily NAV calc + audited reporting.
    nav.service.ts              Crystallises daily NAV from positions + cash
    nav-report.ts               Emits the report shape an auditor expects
    nav.cron.ts                 Runs at UTC close
    nav.int-spec.ts             DB-gated like treasury.int-spec
```

**Boundaries.**

- `signal/` depends on nothing. Math only. Bigint where prices are bigint (matching the codebase's USDC-units / micros conventions), `number` arrays only where library math is unavoidable — and at the boundary, conversion is explicit.
- `strategy/` depends on `signal/`. Receives bars and portfolio state; emits *desired* positions. Never calls the venue directly.
- `execution/` depends on nothing inside stat-arb. Same swap-seam shape as `IHedgeVenue` and `IYieldProvider`: interface + mock-default + dormant real.
- `backtest/` wires the three layers together for historical replay. Live mode wires them identically; only `IBarFeed` swaps.
- `risk/` is consulted by `backtest-runner` and the live runner before any order leaves the system. Drawdown gate is the canonical kill switch.
- `nav/` is the only layer that touches the DB outside of tests. Reads positions, writes daily NAV snapshots — append-only by the same convention as `treasury_movements`.

**No HTTP surface.** Stat-arb is first-party only. There is no `/api/strategy/*` controller. Operator interaction is via CLI scripts under `scripts/` (not yet created) or — if/when Phase 4 lands — a separately-permissioned admin UI that is **not** part of this service.

---

## 5. Data layer

**Market data ingest.** Three options:
1. **CCXT** (Node binding exists, `ccxt` on npm) — covers most CEXs, normalises symbols and timestamps. Slightly stale on WS protocol changes. **Recommended for v1.**
2. **Direct exchange WebSockets** — lower latency, full feature set, but one adapter per exchange. Build later if specific strategies are latency-sensitive (none of the §2 strategies are).
3. **Third-party aggregator** (Kaiko, Tardis) — paid; reliable historical bars. Worth it for backtest data; not for live.

`jesse-ai/jesse` *(unverified)* uses ccxt for live and a vendored historical pipeline for backtests — sensible split.

**Feature / signal store.** Three serious options:
1. **Postgres 16 + TimescaleDB extension** — already running Postgres 16 for treasury; adding TimescaleDB is one extension install. Hypertables make time-series queries fast. **Recommended.**
2. **DuckDB columnar** — embedded, no server, blazing-fast analytical queries. Good for backtest data; awkward for live writes from a Node service.
3. **Parquet files on disk** — simplest historical store; pair with DuckDB for queries. Useless for live signals.

Recommend **TimescaleDB hypertable for live + recent history, Parquet snapshots for >90-day archive**, with DuckDB as the optional analytical query path. All three coexist without conflict.

**Append-only invariant ([CLAUDE.md §3](../CLAUDE.md)).** If we add a `prop_movements` table for executed trades, it must mirror `treasury_movements`: `meridian_markets_app` role gets `SELECT, INSERT` only, `chk_amount_signed_nonzero` CHECK enforces non-zero, `(venue, idempotency_key)` UNIQUE for replay safety. Same regression oracle (the privilege test in `database/append-only.int-spec.ts`) extends to it.

---

## 6. Backtest framework

**Event-driven vs vectorized.** Vectorized backtests are fast and lie. They look ahead, they assume infinite liquidity, they collapse fills into single bars. **Event-driven.** Same strategy code runs in live and backtest; if the backtest results don't predict live, the loop is the wrong shape.

**Walk-forward validation.** Naïve k-fold cross-validation on time-series data leaks future information into the past via overlapping windows. Marcos López de Prado's **purged k-fold CV** (described in *Advances in Financial Machine Learning*, implemented in `mlfinlab` *(unverified)*) drops samples within an embargo window around each test fold. Port the algorithm, not the Pandas implementation.

**Slippage & fees.** Three models, in increasing realism:
1. **Constant taker fee + zero slippage** — useless except for first-pass sanity.
2. **Constant taker fee + linear slippage in trade-size/ADV** — adequate for low-frequency strategies.
3. **Order-book reconstruction** — replay the actual book at each timestamp, walk it for each fill. Required for cross-venue spot arb and anything sub-minute. Expensive in data.

Start with (2). Upgrade to (3) only when a specific strategy's backtest diverges from live.

---

## 7. Risk framework

**Per-strategy.** Fractional Kelly (`f* = (μ − r_f) / σ²`, then take `0.25 · f*`) — shrunk because the strategy's true μ is always lower than the backtest's estimated μ.

**Per-venue.** Hard cap on notional per venue: never more than `min($X, Y% of venue daily volume)`. Y typically 1–2%. Hyperliquid > Drift > GMX > others per [PHASED_PLAN.md §Phase 1](../PHASED_PLAN.md) — same ordering applies here, weighted by venue solvency.

**Portfolio-level.** Cross-strategy VaR (95% / 99%, historical and parametric, take the worse). Recompute daily.

**Circuit breakers** (mirror [PHASED_PLAN.md §Phase 1](../PHASED_PLAN.md)'s list):
- **Drawdown gate** — kill all trading if portfolio drops N% peak-to-trough intraday (default N=5%, configurable per strategy).
- **Data staleness gate** — pause strategies whose feed has been silent for >M seconds (default M=30s for live, 0 in backtest).
- **Venue health gate** — `IHedgeVenue.fetchHealth()` pattern: each venue exposes `healthy: boolean + lastFundingBps`; if unhealthy or funding spikes >K bps in N minutes, close positions on that venue and pause new orders.
- **Cointegration-decay gate** — daily re-test of each pair's cointegration; if p-value > 0.10 for two consecutive days, close the pair regardless of P&L.

---

## 8. Phased build-out

Each step lists its prerequisites, deliverable, and the test bar.

**Step 1 — `signal/` library.** ~1 session.
- Prereq: nothing.
- Deliverable: cointegration test (Engle-Granger), Johansen, OU fit, Bertram thresholds, half-life, rolling/EWMA z-score. Pure functions. Bigint inputs accepted where prices are bigint; floats internal where unavoidable, with explicit boundary conversion.
- Test bar: ~20 specs across files, all golden-vector based against known reference outputs (e.g. a textbook example pair with published cointegration p-value).

**Step 2 — `backtest/` event loop with one strategy.** ~1 session.
- Prereq: Step 1 + `MockTradingVenue` stub (interface + deterministic fills).
- Deliverable: `BacktestRunner` runs a cointegrated-pair strategy on synthetic bars and produces a P&L attribution. Same `IStrategy.onBar` shape that the future live runner will use.
- Test bar: ~10 specs covering deterministic replay, fee/slippage accounting, idempotent re-run.

**Step 3 — `execution/` venue abstraction.** ~1 session.
- Prereq: Steps 1–2.
- Deliverable: `ITradingVenue` interface, `MockTradingVenue` default, `RealBinanceVenue` dormant stub (matches `RealHyperliquidHedgeVenue` posture — throws `TradingVenueNotConfiguredError` until KYB completes). Wired into `ExecutionModule` factory by `MOCK_TRADING_ENABLED`.
- Test bar: ~12 specs total (8 mock, 4 dormant-real).

**Step 4 — `risk/` + `nav/`.** ~1 session.
- Prereq: Steps 1–3.
- Deliverable: Kelly + drawdown gate + venue cap; daily NAV calc with DB persistence (new `prop_movements` and `prop_nav_snapshots` tables in a new migration). NAV migration must extend the append-only privilege oracle.
- Test bar: Kelly + drawdown unit-tested (~8 specs); NAV uses `describeIfDb` like treasury int specs (~6 DB-gated specs).

**Step 5 — first live shadow run with $0.** ~1 session.
- Prereq: Steps 1–4.
- Deliverable: a `LiveRunner` that consumes a real CCXT feed, runs the strategy, and *logs* the orders it would have submitted without actually placing them. Compare to backtest expectations on the same time window.
- Test bar: smoke-test only; this is operations, not unit-tested code.

**Step 6 — first live small-capital deployment.** **GATED behind [PHASED_PLAN.md §Phase 2](../PHASED_PLAN.md) legal formation per cross-phase dependency #1.** Do not flip until legal formation closes; opinion letters confirm own-capital trading is unregulated in the team's jurisdictions; venue KYB completes.

---

## 9. Open questions for the next session

- **TS dataframe library — danfo.js vs nodejs-polars vs roll our own minimal columnar?** Pandas-equivalent ergonomics would let us literal-port more reference code, at the cost of a heavy dependency. Recommend a thin in-repo `Series<T>` + `Frame` shim instead — three or four operations (rolling window, regression, ADF residual) are all we actually need.
- **Statistical primitives library — `simple-statistics`, `mathjs`, `ml-matrix`, or implement from scratch?** ADF and Johansen need matrix decompositions; building from scratch costs ~1 session and avoids a dependency that will bitrot.
- **TimescaleDB vs vanilla Postgres time-series?** TimescaleDB is significantly faster for the queries we'll run but is a server-extension dependency. Verify it's available in the deploy target before committing.
- **Backtest data source.** Free historical OHLCV exists on most CEXs (Binance public API). Tick data is paid (Kaiko, Tardis, Polygon). Decide tick vs minute-bar fidelity per-strategy; pairs trading is fine on minute bars, basis trade probably needs tick.
- **Should funding-carry live under `stat-arb/` or get its own module?** It's listed in PHASED_PLAN.md §Phase 3 as a separate strategy and consumes the same venue-health stream as Phase 1's `IHedgeVenue`. Argument for separate module: cleaner boundaries. Argument for inside `stat-arb/`: shares risk and NAV infra. **Recommend inside `stat-arb/` with the venue-health subscription as the seam.**
- **Audited NAV — which auditor, when?** PHASED_PLAN.md §Phase 3 says "audited daily NAV from day one." Need an auditor relationship before Step 4 ships. Business-track, not engineering.

---

## 10. Cross-references

- [PHASED_PLAN.md](../PHASED_PLAN.md) — overall phasing; Phase 3 envelope
- [CLAUDE.md](../CLAUDE.md) — modular-monolith binding, append-only invariant, mock-default discipline
- [SESSION_HISTORY.md](./SESSION_HISTORY.md) — what's actually built so far
- [INTEGRATION_WITH_LIRA_BRIDGE.md](./INTEGRATION_WITH_LIRA_BRIDGE.md) — only sanctioned coupling with Lira-Bridge; stat-arb has no such coupling
