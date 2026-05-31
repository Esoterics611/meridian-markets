# Market Making — automated quoting books

Meridian now runs **automated market-making (MM) books next to the stat-arb
portfolio**. Where stat-arb hunts for a rare mean-reverting spread and crosses
to take it, an MM book *posts a bid and an ask* on one instrument, earns the
spread on passive fills, and steers its (involuntary) inventory back toward flat.
This is the engine's answer to the profitability problem in
[STRATEGY_PROFITABILITY_NEXT_STEPS.md](STRATEGY_PROFITABILITY_NEXT_STEPS.md):
fees dominate a thin per-trade stat-arb edge, but a maker book earns the spread
*and the rebate* on hundreds of fills a day.

The strategies implement the [Market-Making course](../courses/market-making/)
directly: **Avellaneda-Stoikov** inventory-aware quoting (reservation price +
inventory skew), the **GLFT** steady-state variant, and a **Symmetric** baseline.

## What's in the box

| Layer | File | What it is |
|---|---|---|
| Quoters | `src/market-making/quote/` | `SymmetricQuoter`, `AvellanedaStoikovQuoter`, `GlftQuoter` — all `IQuoter`, the MM analogue of stat-arb's `IStrategy`. |
| Inventory | `src/market-making/inventory/inventory-book.ts` | Average-cost inventory + realised/unrealised/fees accounting (shared by backtest + live). |
| Risk | `src/market-making/risk/` | `CompositeRiskGate` (Allow/Deny/**Pause**) + `VpinEstimator` (toxic-flow signal). |
| Backtest | `src/market-making/backtest/` | `MmBacktestRunner` (bar-driven, runnable today) + `PnlAttributor` (4-component) + `SimpleQueueModel` (the honest queue-aware scaffold). |
| Registry | `src/market-making/registry/mm-strategy-registry.ts` | Catalogue of deployable quoters — mirrors `StrategyRegistry`. |
| Markets | `src/market-making/markets/mm-market-presets.ts` | Stablecoin / FX / crypto-major instrument sets. |
| Live | `src/market-making/live/` | `MmBook` (one instrument) + `MmPortfolioTrader` (N books, one control plane). |
| API | `src/market-making/mm.controller.ts` | `/api/market-making/*` control plane. |

Every quoter runs **unchanged** in both the backtest and the live book — the same
swap seam the rest of the engine is built around. MM books use the **same real
Binance public feed** as stat-arb; no new data adapter is required.

### The four-component P&L

An MM book's net P&L splits into **spread captured − adverse selection −
inventory carry − fees** (course §6.5). Net alone hides the difference between
earning a clean spread and being adversely selected for almost as much; the
attribution is the only honest read on whether a quoter has edge. The backtest
reports all four; the live book reports spread/fees/inventory/equity per book.

## Fees & profitability discipline (both engines)

Fees are charged on **every** fill and folded into net P&L in both engines, and —
more importantly — into the **entry decision**, so the desk doesn't take trades
fees would eat (the "fee drag dominates a thin per-trade edge" problem):

- **MM:** every fill pays `MM_MAKER_FEE_BPS` (signed; `-1` = the Binance maker
  *rebate*, i.e. revenue). The `InventoryBook` reports net = realised − fees +
  unrealised. The quoter also has a **fee-aware floor**: it never quotes a
  half-spread below the maker round-trip break-even (a no-op under a rebate, a
  guard under a cost). A flatten crosses the spread and pays the 5 bps taker fee.
- **Stat-arb:** `MockTradingVenue` / `PaperVenue` charge 5 bps taker per fill and
  the backtest subtracts all four legs from gross. The OU/Bertram strategy widens
  its band by `txCostFraction`; the **z-score pairs strategies now carry a
  fee-aware entry gate** (`signal/fee-gate.ts`) — they only open when the expected
  reversion `(|z|−exitZ)·σ_spread` clears `minEdgeMultiple ×` the 4-leg
  round-trip fee. The registry turns this on by default (5 bps, 1.5× safety).

A useful consequence: a **stablecoin peg spread is sub-fee for a taker**, so the
fee gate correctly steers it *away* from stat-arb and *toward* a maker MM book,
which earns the rebate instead of paying the taker fee. The two engines are
complementary by construction — stat-arb takes only the spreads with real edge;
MM earns the thin, high-frequency spreads that only a maker can profit from.

## Honesty note on the backtest

The bar backtest fills a quote **the instant the bar's range touches its price**
(`fill-model.ts`). That assumes front-of-queue, no queue penalty, so it is an
**upper bound on fills**, not a promise (course §1.6 / §6.8 — the single most
common MM-backtest pathology). The honest correction is queue-aware LOB replay
(`SimpleQueueModel` is implemented and tested); it needs an L2 order-book tape
the engine doesn't ingest yet. Read every bar-backtest fill rate as a ceiling.

---

## How to run it — step by step

### 0. Prerequisites
Node 20, repo deps installed (`npm install`). MM touches **no database**, so you
do **not** need Postgres for any of the steps below.

### 1. Fastest proof — the real-data smoke (no server, no DB)
Backfills real stablecoin bars, backtests all three quoters with 4-component
P&L, and drives one live `MmBook` tick. Best first run:

```bash
npx ts-node -r tsconfig-paths/register scripts/smoke-mm-stablecoin.ts
# override the instruments / history:
SMOKE_MM_SYMBOLS=FDUSD,USDC,TUSD SMOKE_MM_BARS=400 \
  npx ts-node -r tsconfig-paths/register scripts/smoke-mm-stablecoin.ts
```

You'll see a per-quoter table (fills, fill-rate, spread, fees, adverse selection,
net P&L) and a live book line (`mid / bid / ask / inventory / equity`).

### 2. Run the tests
```bash
npx jest src/market-making        # the MM suite (49 tests)
npx jest                          # the whole engine (665 tests)
```

### 3. Run a live MM book inside the app, alongside stat-arb
Boot the engine against real Binance public data (paper mode — no real money,
no account, no key):

```bash
FEED_SOURCE=binance EXECUTION_MODE=paper MOCK_TRADING_ENABLED=false \
  npm run start:dev
```

Then drive the MM control plane (port 3100). The endpoints mirror the stat-arb
live controller, so the desk runs both the same way:

```bash
# the deployable quoter catalogue
curl localhost:3100/api/market-making/strategies

# the instrument presets (stablecoin-peg, fx-via-stables, crypto-majors-mm)
curl localhost:3100/api/market-making/markets

# launch ONE book: AS quoter on FDUSD, 100k USDC
curl -XPOST localhost:3100/api/market-making/launch \
  -H 'content-type: application/json' \
  -d '{"symbol":"FDUSD","strategyId":"mm-avellaneda-stoikov","capitalUsdc":100000}'

# launch an entire preset as one-book-per-instrument
curl -XPOST localhost:3100/api/market-making/launch-preset \
  -H 'content-type: application/json' \
  -d '{"presetId":"stablecoin-peg","strategyId":"mm-glft","capitalUsdcPerBook":50000}'

# read every book: quotes, inventory, 4-part P&L
curl localhost:3100/api/market-making/snapshot

# step once (or let the poll loop run), flatten, remove, stop
curl -XPOST localhost:3100/api/market-making/tick
curl -XPOST localhost:3100/api/market-making/flatten
curl -XPOST localhost:3100/api/market-making/remove  -d '{"symbol":"FDUSD"}' -H 'content-type: application/json'
curl -XPOST localhost:3100/api/market-making/stop
```

Meanwhile the stat-arb desk is still on `/api/stat-arb/live/*` — the two run
concurrently, on different asset classes, in one process.

> If `npm run start:dev` won't stay up in your environment, use the smoke
> (step 1) — it exercises the identical code path without the HTTP server.

### 4. Tune a book
All defaults live in `.env` (`MM_*`, see `.env.example`) and can be overridden
per launch via the `params` field (`{ "gamma": 0.01, "kappa": 1.5 }`). Start
with the **stablecoin-peg** preset: pegged ≈1.0 means low inventory risk, the
cleanest home for inventory-aware quoting. The `crypto-majors-mm` preset is there
to A/B the same quoter on a high-vol class and watch inventory risk dominate.

## Configuration (`MM_*` in `.env`)

| Var | Default | Meaning |
|---|---|---|
| `MM_STRATEGY_ID` | `mm-avellaneda-stoikov` | Default quoter (`mm-symmetric` \| `mm-avellaneda-stoikov` \| `mm-glft`). |
| `MM_SYMBOL` | `FDUSD` | Default instrument. |
| `MM_QUOTE_SIZE_UNITS` | `1000000000` | Asset units quoted per side (1000 units). |
| `MM_CAPITAL_UNITS` | `100000000000` | Per-book capital (100k USDC). |
| `MM_GAMMA` / `MM_KAPPA` | `0.0025` / `2` | AS risk aversion / arrival decay. |
| `MM_MIN_HALF_SPREAD_BPS` / `MM_MAX_HALF_SPREAD_BPS` | `1` / `200` | Quote half-spread rails (bps of mid). |
| `MM_MAX_INVENTORY_LOTS` | `8` | Inventory cap in lots (one lot = one quote size). |
| `MM_MAKER_FEE_BPS` | `-1` | Signed maker fee; negative = rebate (revenue). |
| `MM_MAX_DRAWDOWN_PCT` | `10` | Drawdown kill: deny quoting below this NAV drawdown. |
