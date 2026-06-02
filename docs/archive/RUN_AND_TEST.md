# Run & Test — Meridian Markets

This doc walks every step of standing the service up locally and then exercising the four dashboard personas (Trader / Risk / Investor / Research) end-to-end. Companion to [STAT_ARB_DESK_ROADMAP.md](./STAT_ARB_DESK_ROADMAP.md). Setup section is verbose by design — no prior knowledge of TypeORM, Nest, or the two-role Postgres pattern assumed.

---

## 1. Mental model — read this first

There are **two Postgres roles** by design:

| Role | What it does | What it can't do |
|---|---|---|
| `meridian_markets` | Privileged. Runs migrations: `CREATE TABLE`, `GRANT`, `CREATE EXTENSION`. | Nothing. It's the admin role. |
| `meridian_markets_app` | Runtime. The NestJS service uses this. Has `SELECT, INSERT` on every append-only ledger table; `SELECT, INSERT, UPDATE` on cache tables. | **`UPDATE` or `DELETE` on any movement ledger.** Enforced at the Postgres role level, not just by code. |

That second role's lack-of-privilege is the load-bearing audit guarantee. Even if a bug or attacker wrote `DELETE FROM treasury_movements`, Postgres refuses. Asserted by `src/database/append-only.int-spec.ts` on every CI run.

Two roles → two connection strings in `.env`:

```
DATABASE_URL       = postgresql://meridian_markets:.....         # migration CLI
DATABASE_URL_APP   = postgresql://meridian_markets_app:.....     # the running service
```

---

## 2. Local setup — first time only

### 2.1 Confirm Postgres is reachable

```bash
ss -tnl | grep -E '543[23]'
```

Expect to see Postgres listening on port `5432` (native install) or `5433` (docker compose default — Lira-Bridge owns 5432 in that arrangement). Whichever you have, `.env` must match it.

If `.env` and your live Postgres disagree, the symptom is:

```
Error: connect ECONNREFUSED 127.0.0.1:5433
```

Fix it once and forget about it:

```bash
# Edit both DATABASE_URL lines to use the right port.
sed -i 's/localhost:5433/localhost:5432/g' .env    # if Postgres is on 5432
# or
docker compose up -d postgres                       # if you want to use 5433
```

### 2.2 Create the two roles + database (one-time)

Run as your local Postgres superuser (usually `postgres`):

```bash
sudo -u postgres psql <<'SQL'
CREATE ROLE meridian_markets
  WITH LOGIN PASSWORD 'meridian_markets' CREATEROLE;

CREATE ROLE meridian_markets_app
  WITH LOGIN PASSWORD 'meridian_markets_app';

CREATE DATABASE meridian_markets OWNER meridian_markets;
SQL
```

Verify:

```bash
PGPASSWORD=meridian_markets psql -h localhost -p 5432 \
  -U meridian_markets -d meridian_markets -c '\du'
```

You should see both roles listed.

### 2.3 Install + migrate + start

```bash
cd /home/nexus/code/meridian-markets

npm install              # first time only

npm run migration:run    # applies every migration in migrations/, in order
```

What `migration:run` actually does, migration by migration:

| File | Tables it creates | Why |
|---|---|---|
| `1715000000000-Initial.ts` | `treasury_movements`, `treasury_positions` | Phase 0 — yield ledger |
| `1716000000000-AddHedgeTables.ts` | `hedge_movements`, `hedge_positions` | Phase 1 — FX hedge ledger |
| `1717000000000-AddStatArbTables.ts` | `stat_arb_trades`, `stat_arb_nav` | Session 9 — stat-arb persistence |
| `1718000000000-AddMarketDataTables.ts` | `market_bars`, `funding_rates`, `data_gaps` | Session 11 — market-data ingest (tries `CREATE EXTENSION timescaledb` first, falls back to plain Postgres) |

Every migration `GRANT`s `SELECT, INSERT` on its append-only tables to `meridian_markets_app`. None grant `UPDATE` or `DELETE` on movement ledgers — that's the invariant.

Check what's applied at any time:

```bash
PGPASSWORD=meridian_markets psql -h localhost -p 5432 \
  -U meridian_markets -d meridian_markets \
  -c "SELECT name FROM typeorm_migrations ORDER BY id;"
```

Then start the service:

```bash
npm run start:dev
```

It binds to **`:3100`**. Wait for `Nest application successfully started`.

### 2.4 Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `ECONNREFUSED 127.0.0.1:5433` | `.env` and live Postgres disagree on port | §2.1 |
| `password authentication failed for user "meridian_markets"` | Role doesn't exist | §2.2 |
| `permission denied for sequence hedge_movements_id_seq` (hedge integration tests only) | Pre-existing migration bug — sequence grants missing | Not blocking; predates current work |
| `relation "stat_arb_trades" does not exist` | Migration 1717 not applied | `npm run migration:run` |
| `relation "market_bars" does not exist` | Migration 1718 not applied | `npm run migration:run` |
| Dashboard "PENDING" everywhere | No backtest run yet | Click **Run Demo** or `curl -X POST .../demo/reset` |
| Browser shows huge scrolling charts | Cached old HTML | Hard-refresh (Ctrl-Shift-R) |

---

## 3. Test paths — every persona, every flow

The dashboard lives at `http://localhost:3100/demo` with four hash-routed personas. Below is what each one shows, what to click, and what API call you can `curl` to verify the data behind the UI.

### 3.1 Trader desk — `/demo#trader`

> Who uses this: the human running the strategy live. Wants instant feedback on regime, edge, and where capital is deployed.

**Header controls (visible on every persona):**

- **Scenario dropdown** — `calm / trending / volatile / decoupled`. Reshapes the synthetic feed and re-runs the backtest. Each scenario stresses a different code path; *decoupled* drives p-value high and exercises the p-value gate.
- **Run Demo** button — `POST /api/stat-arb/demo/reset?scenario=<sc>`. Idempotent — safe to spam.
- **Kill switch** — client-side flag. Sets the page-wide red banner, flips the Risk view's "Manual kill switch" chip to ARMED. Doesn't reach the server (that's by design — the kill is a UI affordance to gate trader actions).

**What renders on this page:**

| Element | Source | Meaning |
|---|---|---|
| **Strategy card** — pair, z-score, regime (LONG/SHORT/FLAT), open P&L, trade count | `GET /api/stat-arb/demo/status` | The current model state. z should oscillate; regime should flip; trades should accumulate. |
| **Live β · refit** | snapshot.refits[last] | Sliding cointegration's most recent β, plus the bar index where it was fit. Session 7. |
| **Half-life (bars)** | snapshot.refits[last] | OU mean-reversion half-life. `n/a` when residual is non-stationary. |
| **Live spread tape** | snapshot.spreadSeries (last 60 bars) | z-score sparkline with entry threshold lines. |
| **Drawdown vs 5% gate gauge** | snapshot.metrics + equityCurve | Drawdown bar + sparkline. Pauses-new-entries threshold at 5%. |
| **Backtest Metrics card** | snapshot.metrics | Sharpe, win rate, max DD, trade count. |
| **Spread z-score chart** (240px) | snapshot.spreadSeries (full) | Big line chart with entry/exit threshold guides. |
| **Recent Trades (last 10)** | snapshot.recentTrades | Per-trade rows: side, entry/exit z, hold bars, P&L. |
| **System Posture** | static | Phase 3 / no real venue / KYB-gated copy. |

**Smoke test:**

```bash
# Pre-warm under every scenario.
for s in calm trending volatile decoupled; do
  echo "--- $s ---"
  curl -s -X POST "http://localhost:3100/api/stat-arb/demo/reset?scenario=$s" \
    | jq '{trades: .trades | length, sharpe: .metrics.sharpeRatio, dd: .metrics.maxDrawdownPct}'
done

# Confirm refit history exists.
curl -s 'http://localhost:3100/api/stat-arb/demo/refits' \
  | jq '{count: .refits | length, latest: .refits[-1]}'
```

In the browser: change scenarios in the header; watch β, half-life, and the spread chart re-shape. The "Trades" count should go from a single digit (calm) to higher counts (volatile).

### 3.2 Risk & Compliance desk — `/demo#risk`

> Who uses this: the risk officer / compliance lead. Wants to see every gate that's armed, every gate that's fired, and the cryptographic-ledger proof of append-only.

**What renders on this page:**

| Element | Source | Meaning |
|---|---|---|
| **Drawdown Gate card** | snapshot.metrics.maxDrawdownPct | Current DD %, fill bar against 5% gate, sparkline. Chip flips OPEN → WARN → PAUSED. |
| **Cointegration Health card** | snapshot.refits[last].pValue | Live ADF p-value from the sliding-β refit. Chip flips OK → WATCH → DECOUPLED at 0.05 / 0.10. |
| **Venue Cap card** | snapshot.blockedEntries + riskEvents | Count of OPEN orders the engine blocked; chip flips OK → GATING → TRIPPED. |
| **Exposure card** | riskEvents (kind starting with EXPOSURE_*) | Count of gross/net/per-pair gate fires; sparkline of cumulative fires. |
| **Circuit Breakers & Kill-Switches** | static + snapshot.killed | Manual kill switch chip, hedge breaker, yield cron, dormant real venues. |
| **Gate Event Log** | derived from allTrades + riskEvents + gateEvents | Chronological feed: OPEN / CLOSE / DD / GATE (P_VALUE_BLOCK) / RISK (DRAWDOWN / VENUE_CAP / EXPOSURE_*). |
| **Append-only Ledger Proof** | static table | Per-table SELECT/INSERT/UPDATE/DELETE grant status + CHECK constraints. Asserted by `append-only.int-spec.ts`. |
| **KYB & External Counterparty Status** | static | Ondo / Hyperliquid / Binance / Lira-Bridge KYB state per phase. |

**Smoke test:**

```bash
# Risk events + blocked entries (Sessions 7 + 8 wiring).
curl -s 'http://localhost:3100/api/stat-arb/demo/status' \
  | jq '{
      blockedEntries,
      pValueGateEvents: [.gateEvents[] | select(.kind == "P_VALUE_BLOCK")] | length,
      riskEvents: [.riskEvents[] | {kind, reason}]
    }'

# Append-only invariants (these only run when Postgres is reachable).
npx jest src/database/append-only.int-spec.ts
```

In the browser: switch to `volatile` or `decoupled`, watch the Cointegration card flip to WATCH/DECOUPLED, watch the Gate Event Log accumulate `GATE · P_VALUE_BLOCK` entries.

### 3.3 Investor desk — `/demo#investor`

> Who uses this: an LP / investor reading the track record. Wants headline performance metrics with the right disclaimers and no operational noise.

**What renders on this page:**

| Element | Source | Meaning |
|---|---|---|
| **Hypothetical Track-Record P&L** | snapshot.metrics.totalPnlUnits | Big USDC P&L number against the $1M notional reference. |
| **Return / Calmar metric cards** | computed from metrics | Period return %, Calmar ratio. |
| **Sharpe / Max DD cards** | snapshot.metrics | Headline risk-adjusted numbers. |
| **Trades / Win rate cards** | snapshot.metrics | Strategy throughput. |
| **Hypothetical NAV chart** (240px) | snapshot.equityCurve | NAV starting at $1.00 — actual cumulative P&L from the BacktestRunner. |
| **Underwater curve** (200px) | derived from NAV | Drawdown from running peak. |
| **Phase Gate Timeline** | static | Phase 0 done → Phase 1 done → Phase 3 (current) → Phase 2 legal → Phase 4 fund. |
| **Investor Disclosures** | static | "No customer capital in this system" + "not an offering" + "Phase 4 gates customer onboarding". |

**Smoke test:** the headline numbers should be deterministic for a given scenario. Run `reset?scenario=calm` twice and confirm the P&L and Sharpe are byte-identical.

### 3.4 Research desk — `/demo#research` (new in Session 12)

> Who uses this: a quant researcher / portfolio manager validating that the strategy isn't overfit. Wants out-of-sample evidence and a sense of the sampling distribution.

**Important behaviour:** the research endpoints run multiple backtests, so they're **fetched on demand** when you click into the tab (and once per page load — refresh the page to refetch).

**What renders on this page:**

| Element | Source | Meaning |
|---|---|---|
| **Walk-forward Sharpe (avg test)** | `GET /api/stat-arb/research/walk-forward` | Mean Sharpe across out-of-sample test windows + share of windows with positive Sharpe. |
| **Sweep best Sharpe** | `GET /api/stat-arb/research/sweep` | Top cell of `entryZ × exitZ` grid + the params that achieved it. |
| **Monte Carlo prob-positive** | `GET /api/stat-arb/research/monte-carlo` | Bootstrap-resampled P(final P&L > 0) + median final P&L. |
| **Walk-forward table** | same | Per-window train vs test Sharpe, DD, Calmar, trade count. The test column is the honest one. |
| **Parameter sweep heatmap** | same | 4×3 grid (`entryZ ∈ {1.0, 1.2, 1.5, 2.0} × exitZ ∈ {0.0, 0.3, 0.5}`) coloured by Sharpe. Hover for tooltip with trades + DD. |
| **Monte Carlo fan chart** (240px) | same | p5 / p50 / p95 cumulative-P&L curves from 200 bootstrap replications, deterministic seed. |

**Smoke test:**

```bash
# Walk-forward — train 80 / test 40 over a 360-bar synthetic feed.
curl -s 'http://localhost:3100/api/stat-arb/research/walk-forward' \
  | jq '{avgTestSharpe, positiveWindowShare, windowCount: (.windows | length), firstWindow: .windows[0]}'

# Parameter sweep — 12 cells, ranked by Sharpe desc.
curl -s 'http://localhost:3100/api/stat-arb/research/sweep' \
  | jq '{cells: (.cells | length), top: .cells[0], worst: .cells[-1]}'

# Monte Carlo — 200 reps, default seed (42), demo-bar-count feed.
curl -s 'http://localhost:3100/api/stat-arb/research/monte-carlo?reps=200&seed=42' \
  | jq '{summary, curveLength: (.p50 | length)}'
```

In the browser: switch to `#research`. First load takes ~3-5 seconds (running multiple backtests in parallel). The heatmap should show a colour gradient (red = low Sharpe, green = high Sharpe). The fan chart should show three lines that widen out from bar 0 → trade N.

---

## 4. Useful curl commands cheat-sheet

```bash
# Phase 0 — treasury
curl -s -H 'x-meridian-client-key: dev-meridian-client-key-change-me' \
     'http://localhost:3100/api/treasury/position'
curl -s -H 'x-meridian-client-key: dev-meridian-client-key-change-me' \
     'http://localhost:3100/api/treasury/yield-earned'

# Phase 3 — stat-arb demo
curl -s -X POST 'http://localhost:3100/api/stat-arb/demo/reset?scenario=volatile' | jq .metrics
curl -s 'http://localhost:3100/api/stat-arb/demo/status'   | jq '.regime, .currentZ'
curl -s 'http://localhost:3100/api/stat-arb/demo/history'  | jq '.series | length'
curl -s 'http://localhost:3100/api/stat-arb/demo/refits'   | jq '.refits | length'

# Phase 3 — research desk (Session 12)
curl -s 'http://localhost:3100/api/stat-arb/research/walk-forward'             | jq '.avgTestSharpe'
curl -s 'http://localhost:3100/api/stat-arb/research/sweep'                    | jq '.cells[0]'
curl -s 'http://localhost:3100/api/stat-arb/research/monte-carlo?reps=200'     | jq '.summary'
```

---

## 5. Full test suite

```bash
# Unit specs only (no DB needed) — should always be green.
npx jest --silent

# Integration specs (require Postgres + applied migrations).
npx jest src/database/append-only.int-spec.ts
npx jest src/treasury/treasury.service.int-spec.ts
npx jest src/hedge/hedge.service.int-spec.ts   # KNOWN BAD — pre-existing sequence-perm bug

# Type-check.
npx tsc --noEmit
```

Expect **279+ unit specs green** as of Session 11; Session 12 adds another ~46. The single `hedge.service.int-spec.ts` failure is a known, pre-existing sequence-grant bug from Phase 1 — not in any current session's scope.

---

## 6. Where to read the code

Every persona's data path:

```
View → fetch /api/... → Controller → DemoService / ResearchController →
  BacktestRunner → PairsStrategy + RiskEngine → MockTradingVenue →
  back through serialise* → JSON → render*() → DOM
```

- HTML + JS:    `src/stat-arb/demo/public/index.html`
- Demo API:     `src/stat-arb/demo/demo.controller.ts`
- Demo runner:  `src/stat-arb/demo/demo.service.ts`
- Backtest:     `src/stat-arb/backtest/{backtest-runner,pairs-strategy,synthetic-feed}.ts`
- Signal lib:   `src/stat-arb/signal/{cointegration,sliding-cointegration,ou,z-score,spread}.ts`
- Risk gates:   `src/stat-arb/risk/{drawdown,venue-cap,exposure-caps,correlation-cap,kelly,risk-engine}.ts`
- Research:     `src/stat-arb/research/{walk-forward,parameter-sweep,monte-carlo,look-ahead,research.controller}.ts`
- Persistence:  `src/stat-arb/persistence/{stat-arb.repository,nav.cron}.ts`
- Market data:  `src/market-data/{symbol,market-data.repository}.ts`, `src/market-data/{ingest,replay}/`

When something looks wrong in the UI, the fastest path is to `curl` the corresponding API and inspect the JSON — every render function on the dashboard is a one-to-one mapping of fields, no fudging.
