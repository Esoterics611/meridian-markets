# Meridian Markets — Command Cheatsheet

Every way to drive the engine: terminal commands, backend run modes, and the
`/demo` UI flow. Sourced from [README](../README.md),
[HEADLESS_OPERATIONS.md](./HEADLESS_OPERATIONS.md),
[PAPER_TRADING.md](./PAPER_TRADING.md), [MARKET_MAKING.md](./MARKET_MAKING.md),
[UI_USER_STORIES.md](./UI_USER_STORIES.md), [CLAUDE.md](../CLAUDE.md), and
`package.json`. Server listens on **`:3100`**; Postgres on **`:5433`**.

> Paper-only demo (CLAUDE.md §1). `paper` mode = real market data + simulated
> fills, no API key, no real money. `canary`/`live` are parked engineering seams.

---

## 1. Terminal commands

### 1a. One-time setup
```bash
npm install
echo 5784 | sudo -S docker compose up -d postgres   # Postgres 16 on :5433
cp .env.example .env
npm run migration:run                                # apply DB migrations (idempotent)
```

### 1b. npm scripts (`package.json`)
| Command | What it does |
|---|---|
| `npm run start:dev` | Nest in watch mode on `:3100` (the dev run path) |
| `npm run start` | Nest, no watch |
| `npm run start:prod` | run the built `dist/src/main` |
| `npm run build` | `nest build` → `dist/` |
| `npm test` | full Jest suite (unit + int; int-specs auto-skip w/o DB) |
| `npm run test:watch` | Jest watch |
| `npm run mq -- <cmd>` | the `mq` quant-terminal CLI (note the `--`) |
| `npm run migration:run` | apply migrations |
| `npm run migration:revert` | roll back the last migration |

### 1c. Test / typecheck / DB lifecycle
```bash
npx tsc --noEmit                  # fast typecheck, no emit (the green check)
npx jest <path>                   # one suite, e.g. npx jest src/market-making
MERIDIAN_DB_TESTS=off npm test    # skip the DB-backed int-specs explicitly

# Postgres (sudo password 5784)
echo 5784 | sudo -S docker compose up -d postgres
sudo docker inspect --format='{{.State.Health.Status}}' meridian-markets-postgres-1
echo 5784 | sudo -S docker compose down
```

### 1d. `mq` — the quant-terminal CLI
Wraps the HTTP control plane. Every command takes `--json`. Needs the server up
on `:3100` (`MQ_HOST` overrides) — **except** `mq session`, which boots its own
context.
```bash
npm run mq -- help

# Research
npm run mq -- presets
npm run mq -- strategies
npm run mq -- backfill <preset> [--hours 72]
npm run mq -- discover <preset> [--hours 72]

# Backtest
npm run mq -- backtest <A> <B> [--strategy id] [--hours 72] [--beta n]
npm run mq -- sweep <A> <B> [--hours 72] [--beta n]     # all strategies, ranked by Sharpe

# Deploy (live paper)
npm run mq -- arm <A> <B> [--strategy id] [--capital 100000] [--beta n]
npm run mq -- stop | tick | flatten | kill
npm run mq -- book add <A> <B> [<A2> <B2> …] [--strategy id] [--capital n]
npm run mq -- book start | stop | flatten | remove <PAIR>

# Monitor
npm run mq -- status        # single book
npm run mq -- book          # all books
npm run mq -- trades [--venue paper] [--limit 50]

# Runbook (no server needed)
npm run mq -- session [--preset crypto-majors] [--hours 24] [--capital 100000]
```
Strategy ids: `pairs-zscore`, `pairs-ewma`, `ou-bertram`, `ou-bertram-fast`.
Presets: run `npm run mq -- presets` (crypto-majors, layer-1, defi, …).

### 1e. Headless scripts
`ts-node`; boot their own Nest context, so they need **Postgres + Binance public
REST** but **not** a running server.
```bash
# Full stat-arb runbook: catalogue → backfill → discover → backtest all →
# live-loop round-trips → arm the winner. Proves the loop ENTERS trades.
QS_PRESET=crypto-majors QS_HOURS=24 QS_CAPITAL=100000 \
  npx ts-node -r tsconfig-paths/register scripts/quant-session.ts

# In-process live smoke vs real Binance (no HTTP listen)
FEED_SOURCE=binance EXECUTION_MODE=paper MOCK_TRADING_ENABLED=false \
  npx ts-node -r tsconfig-paths/register scripts/smoke-live-multi-asset.ts

# Market-making smoke (no DB): backfills stablecoins, backtests all 3 quoters,
# drives one live tick
npx ts-node -r tsconfig-paths/register scripts/smoke-mm-stablecoin.ts
SMOKE_MM_SYMBOLS=FDUSD,USDC,TUSD SMOKE_MM_BARS=400 \
  npx ts-node -r tsconfig-paths/register scripts/smoke-mm-stablecoin.ts

# MM "running for hours" session: hourly equity curve + fee sweep, desk scale
npx ts-node -r tsconfig-paths/register scripts/mm-paper-session.ts
MM_SESSION_HOURS=6 MM_SESSION_STRATEGY=mm-glft \
  npx ts-node -r tsconfig-paths/register scripts/mm-paper-session.ts
MM_SESSION_MODE=live MM_SESSION_HOURS=8 \
  npx ts-node -r tsconfig-paths/register scripts/mm-paper-session.ts
MM_SESSION_SOURCE=geckoterminal \
  npx ts-node -r tsconfig-paths/register scripts/mm-paper-session.ts   # MM on a DEX preset

# Reference data sources (Pyth / DefiLlama / Bit2C / Gecko / Hyperliquid) — no server, no DB
npx ts-node -r tsconfig-paths/register scripts/smoke-reference-sources.ts
```
Research / thesis scripts (also `ts-node`, same shape):
```bash
scripts/quant-research.ts             # asset-class × strategy × entry-z × interval sweep
scripts/cointegration-stability.ts    # cointegration-cliff thesis (STAB_SOURCE=alpaca|yahoo)
scripts/oos-candidates.ts             # real-history OOS + deflated-Sharpe gate (OOS_SOURCE=…, OOS_BASKET=true)
scripts/funding-carry-research.ts     # funding-rate carry research
scripts/fx-basis-research.ts          # FX basis research
scripts/vol-carry-research.ts         # vol-carry research
```

### 1f. Raw HTTP surface (curl — server must be up)
Full enumerated list in [HEADLESS_OPERATIONS.md §5](./HEADLESS_OPERATIONS.md). Highlights:
```bash
# Market data (real Binance history)
curl localhost:3100/api/market-data/presets
curl -XPOST localhost:3100/api/market-data/backfill-preset \
  -H 'content-type: application/json' -d '{"presetId":"crypto-majors","lookbackHours":72}'
curl 'localhost:3100/api/market-data/universe?presetId=crypto-majors&hours=72'
curl -XPOST localhost:3100/api/market-data/backtest -H 'content-type: application/json' \
  -d '{"symbolA":"ETH","symbolB":"BTC","strategyId":"ou-bertram","lookbackHours":72,"beta":1.07}'
curl -XPOST localhost:3100/api/market-data/walk-forward ...   # real-history OOS gate
curl localhost:3100/api/market-data/reference                 # wired reference sources readout

# Stat-arb live control plane (paper loop)
curl localhost:3100/api/stat-arb/live/snapshot      # single book: z, regime, PnL, position
curl localhost:3100/api/stat-arb/live/portfolio     # all books
curl localhost:3100/api/stat-arb/live/trades        # persisted blotter (stat_arb_trades)
curl localhost:3100/api/stat-arb/live/strategies
curl -XPOST localhost:3100/api/stat-arb/live/start|stop|tick|flatten|kill
curl -XPOST localhost:3100/api/stat-arb/live/portfolio/launch \
  -H 'content-type: application/json' \
  -d '{"symbolA":"ETH","symbolB":"BTC","strategyId":"ou-bertram","beta":18.0,"capitalUsdc":50000}'

# Market-making control plane
curl localhost:3100/api/market-making/strategies|markets|snapshot
curl -XPOST localhost:3100/api/market-making/launch -H 'content-type: application/json' \
  -d '{"symbol":"FDUSD","strategyId":"mm-avellaneda-stoikov","capitalUsdc":100000}'
curl -XPOST localhost:3100/api/market-making/launch-preset -H 'content-type: application/json' \
  -d '{"presetId":"stablecoin-peg","strategyId":"mm-glft","capitalUsdcPerBook":50000}'
curl -XPOST localhost:3100/api/market-making/tick|flatten|stop
curl -XPOST localhost:3100/api/market-making/remove -H 'content-type: application/json' -d '{"symbol":"FDUSD"}'
```

---

## 2. Run the backend in different modes

Selected by env (`EXECUTION_MODE` + `FEED_SOURCE`) — engineering switches, no business gate.

**Mock** — synthetic feed + venue; offline, deterministic (defaults):
```bash
npm run start:dev      # FEED_SOURCE=mock EXECUTION_MODE=mock by default
```

**Paper** — the mode the demo runs in (real Binance data, simulated fills, no key).
Also runs the MM books on `/api/market-making/*` in the same process:
```bash
FEED_SOURCE=binance EXECUTION_MODE=paper MOCK_TRADING_ENABLED=false \
  LIVE_AUTOSTART=false npm run start:dev          # → http://localhost:3100/demo
```

**Paper, autostart a specific pair:**
```bash
FEED_SOURCE=binance EXECUTION_MODE=paper LIVE_AUTOSTART=true \
  LIVE_PAIR_A=BTC LIVE_PAIR_B=ETH LIVE_POLL_INTERVAL_MS=15000 npm run start:dev
```

**Equities paper** (needs an Alpaca paper key):
```bash
ALPACA_KEY_ID=… ALPACA_SECRET=… \
  FEED_SOURCE=alpaca EXECUTION_MODE=paper MOCK_TRADING_ENABLED=false npm run start:dev
```

**Canary / live** (real venue) — parked / out of scope, but the seam exists:
```bash
EXECUTION_MODE=canary|live LIVE_TRADING_ARMED=true ... npm run start:dev
```
Requires a wired real-venue adapter; `ExecutionModeBootGuard` blocks boot without the arm switch.

| Posture | Env | What it is |
|---|---|---|
| **mock** | `FEED_SOURCE=mock EXECUTION_MODE=mock` (defaults) | synthetic feed + venue; offline, deterministic |
| **paper** | `FEED_SOURCE=binance EXECUTION_MODE=paper MOCK_TRADING_ENABLED=false` | real data + `PaperVenue` (simulated fills) |
| **canary/live** | `EXECUTION_MODE=canary\|live LIVE_TRADING_ARMED=true` | routes to a real venue (parked) |

Key tunables (full list in `.env.example`): `PORT=3100`, `FEED_SOURCE`,
`FEED_QUOTE`/`FEED_INTERVAL`, `LIVE_PAIR_A/B`, `LIVE_BETA`, `LIVE_Z_LOOKBACK`,
`LIVE_ENTRY_Z`/`LIVE_EXIT_Z`, `LIVE_NOTIONAL_UNITS`, `LIVE_POLL_INTERVAL_MS`,
`LIVE_AUTOSTART`; MM: `MM_STRATEGY_ID`, `MM_SYMBOL`, `MM_QUOTE_SIZE_UNITS`,
`MM_GAMMA`/`MM_KAPPA`, `MM_MAKER_FEE_BPS`, `MM_MAX_DRAWDOWN_PCT`.

---

## 3. The UI — step by step (`/demo`)

Start the server (paper mode), then open **http://localhost:3100/demo**:
```bash
FEED_SOURCE=binance EXECUTION_MODE=paper MOCK_TRADING_ENABLED=false \
  LIVE_AUTOSTART=false npm run start:dev
```
`/demo` is a thin read-only view over the same `GET /snapshot` JSON the CLI uses.
Panels top→bottom: **Fund overview · Launch a station · Live position · Strategy
signal (chart) · Strategy catalogue · Live books · Discovered pairs + Backtest ·
Trade history**, with a top strip (Asset class / Market set / Strategy / Lookback
/ Backfill / Capital / Start-Stop).

### Headline flow — deploy several strategies and watch trades
1. **Get data in.** Top strip → **Market set** = *Crypto — Large Cap* → **Lookback**
   = 72 → **⤓ Backfill live history**. Real Binance bars load; **Discovered pairs**
   fills (β, p-value, half-life, regime chips).
   *Equities path:* flip the **Asset class** toggle to *Equities · Yahoo daily* —
   free, no-key daily history, no backfill needed.
2. **Launch a station** (panel 2): class → **Leg A** (`ETH`) / **Leg B** (`BTC`) →
   **Strategy** (*Pairs — rolling z-score*) → edit the **Strategy params** row
   (entry/exit z, lookback, EWMA λ, OU window, tx-cost) → **β** auto-fills from
   discovery → set **Capital (USDC)** → **Launch**.
3. **Add more books.** Repeat step 2 with different markets/strategies (e.g.
   `SOL/AVAX` + *OU — Bertram*, `LTC/BCH` + *Pairs — EWMA*). Each becomes a card in
   **Live books**. *Shortcut:* in **Discovered pairs** set **N** (1–12), mix = *one
   of each strategy*, **▶ Trade top N** to launch many at once (additive).
4. **Research before committing (optional):**
   - **Discovered pairs → backtest** a row → **Backtest** panel (trades / Sharpe /
     PnL / win-rate / max-DD).
   - **Strategy signal** panel plots the **z-score** with ±entry/exit bands and
     ▲▼/× trade markers (toggle to **price** for candles). Click **▸** on a
     Live-books card to focus that book's signal.
   - **⊹ Scan all source data** (Research) sweeps every asset class at once, ranked
     net-of-fees, grouped by class — trade straight from a row.
5. **Monitor the desk:**
   - **Fund overview** → equity, capital, net/realised/unrealised P&L, drawdown,
     exposure-by-class chips, book/open-position counts, equity sparkline.
   - **Live books** → per-card z, β, bands, regime, position, capital, equity,
     realised/unrealised, bars seen, **last bar Xs** (STALE chip if >180s), z &
     equity sparklines (4s poll).
   - **Header** → feed / venue badges, live/paused, UTC clock, heartbeat.
6. **See the trades:**
   - **Trade history — persisted** → closed round-trips (time, pair, side,
     entry/exit z, PnL) from `stat_arb_trades`; spans every book, survives restart.
   - **Live position → Recent fills** → the single book's in-memory fills.
   - ⚠️ A trade only *closes* when the spread mean-reverts past the exit band — on
     1-minute bars expect minutes-to-hours for round-trips; entries can be
     near-immediate (book warms from ~240 klines).
7. **Risk & control:**
   - **■ HALT ALL** (Fund overview) → stops the single book + every station.
   - **⏸ Stop all** (Live books) → stops the whole portfolio.
   - Top strip **▶ Start / ⏸ Stop**, **Set capital** for the single book.
   - **Alerts** surface `STALE FEED`, `RISK GATE`, `DRAWDOWN` breaches.

### Honest UI gaps (`UI_USER_STORIES.md §G`)
- **Flatten / force-close one position** — ❌ not a button yet (Kill/Stop halt *new*
  entries only). Top gap.
- **Stop/remove a single station** — ❌ only "Stop all" / "HALT ALL"; re-launching
  the same pair replaces it.
- **Change a running station's capital/params in place** — ⚠️ only by re-launching
  (restarts the book).
- **Research tools (walk-forward / sweep / Monte-Carlo)** — endpoints exist
  (`/api/stat-arb/research/*`) but aren't all surfaced in `/demo`.
- **Streaming** — 4s REST polling today; SSE/WebSocket is the planned upgrade.

---

> **Accuracy note:** this cheatsheet reflects the markdown docs, some of which are
> dated (HEADLESS_OPERATIONS.md "as of 2026-05-31"). Newer surfaces in the CLAUDE.md
> session log (Hyperliquid `hl-perps`, DEX presets, `/api/market-making/screen`) may
> not appear in every doc's endpoint table. Verify routes against the controllers if
> you need the definitive live list.
