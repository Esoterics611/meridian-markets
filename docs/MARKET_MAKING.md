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

## Frontier — discovery: DEX / decentralized markets (the MM growth direction)

> **This is where the mission says the edge actually grows** (CLAUDE.md §1): the magic
> is in **discovering new markets to make markets in — especially DEX / decentralized /
> anonymous venues.** The market-making engine is venue-agnostic by design (the quoter,
> inventory book, and risk gate don't care where the prints come from), so widening the
> *universe* is the highest-leverage move, not tuning the quoter.

Why decentralized markets are the right frontier *for this engine specifically*:

- **The binding deploy condition is a ≤0 bps maker venue** (§1.5 / Journal #6, #23): on
  centralized retail fees (+1 bps maker) the structural edge is eaten. DEXes have a
  *different* fee/reward structure — LP fees accrue **to** the maker, and many chains/AMMs
  or CLOB DEXes offer maker rebates or zero maker fees — which is exactly the regime where
  the book's structural P&L (spread − adverse selection) survives.
- **Under-watched = wider spreads.** Decentralized and long-tail venues are less
  arbitraged, so the spread the quoter earns is structurally wider — more edge per fill,
  the opposite of the over-crowded major CEX pairs.
- **Discovery compounds.** Every new source wired through the `IReferenceBarSource` seam is
  permanently in the scan universe and tradeable on the live loop (desk/README "Discovery
  compounds"). The universe grows monotonically with no new services.

How it plugs in (no new architecture — the seams already exist, CLAUDE.md §7):

- **Data — SHIPPED (S28):** `GeckoTerminalClient` behind `IReferenceBarSource` — free, no-key
  DEX OHLCV across 100+ chains, registered in `buildReferenceSources` + the scanner. This is the
  **Market Data Researcher** role ([desk/ROLE_market_data_researcher.md](../desk/ROLE_market_data_researcher.md)).
- **Markets — SHIPPED (S29):** the `dex-eth-bluechip` preset (`source:'geckoterminal'`) is a
  `mm-market-preset`; `MmMarketPreset.source` / `MmBookSpec.source` carry the routing, and the
  `MmScreener` is source-aware so DEX pools rank on the "where should we quote" board.
- **Execution (paper) — SHIPPED (S29):** a `source` book is fed by a `ReferenceBarFeed` and filled
  by the same paper fill-model at real DEX prices — no on-chain execution adapter needed for the
  paper demo, which is the whole scope. Launch it:
  ```bash
  curl -XPOST localhost:3100/api/market-making/launch-preset \
    -H 'content-type: application/json' \
    -d '{"presetId":"dex-eth-bluechip","strategyId":"mm-glft","capitalUsdcPerBook":50000}'
  ```
  (A real on-chain venue adapter would be the `live`-posture seam, and that is parked.)

**Honesty caveat:** DEX prints are noisier (MEV, thin pools, sandwiching, gas), so the
adverse-selection term (and the queue/fill model) is *less* favourable than a clean CEX
tape — the survivorship/cost discipline applies here too. Wider spread is not free money;
it is compensation for exactly these hazards. **First live-replay reads (Journal #16) bear
this out:** a naive fixed-spread book on volatile WETH/USDC was net-negative (adverse > spread),
and the low-vol USDC/USDT peg was near-flat (maxDD 0.01% at $1M) but not yet positive at
fill-on-touch without a maker rebate — the book still needs a **≤0 bps maker venue** + per-pool
tuning + queue-aware fills to net positive (§1.5 / Journal #23).

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

### 1.5 The long-running session — MM for hours (`scripts/mm-paper-session.ts`)

The "show me MM running for hours, stable profit, large lots, equity conserved"
harness. It drives the **same live `MmBook`** and registry the control plane runs
— no server, no DB — at **desk scale** ($50k/quote, $1M/book, 8-lot inventory cap)
and reports an **hourly equity curve** plus a **fee sweep**: net at −1 bps (VIP
maker rebate), **0 bps (structural = spread − adverse)**, and +1 bps (retail maker
cost). Conservation is judged on the **structural** curve, never on the rebate.

```bash
# replay 24h of REAL Binance 1m history bar-by-bar (deterministic, runs anywhere):
npx ts-node -r tsconfig-paths/register scripts/mm-paper-session.ts
MM_SESSION_HOURS=6 MM_SESSION_STRATEGY=mm-glft \
  npx ts-node -r tsconfig-paths/register scripts/mm-paper-session.ts

# the literal "running for hours" — live poll on your own machine:
MM_SESSION_MODE=live MM_SESSION_HOURS=8 \
  npx ts-node -r tsconfig-paths/register scripts/mm-paper-session.ts
```

A representative 24h replay (GLFT, FDUSD/USDC/TUSD): **structural net positive and
monotone across every 2h bucket, desk max drawdown ~0.001%** at $400k max inventory
— large lots, equity conserved. **But at a +1 bps retail maker cost the book
loses**, so the deploy condition is a **≤0 bps maker venue**; and fills are
fill-on-touch (an upper bound — see the honesty note above). Env knobs:
`MM_SESSION_{MODE,SYMBOLS,STRATEGY,QUOTE_UNITS,CAPITAL_UNITS,MAX_LOTS,HOURS,MAKER_BPS,POLL_MS}`.

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
