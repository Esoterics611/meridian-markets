# Headless Operations — every way to drive Meridian from a terminal

The engine is **headless and control-plane-first**: the `/demo` web page is just
one read-only consumer of `GET /snapshot`. Everything the UI does, and a lot it
doesn't, you can do from a terminal. This is the complete catalogue, as of
2026-05-31.

Three layers, in order of how you'll reach for them:
1. **`mq`** — the ergonomic CLI over the control plane ([§2](#2-mq--the-quant-terminal)). Use this first.
2. **Headless scripts** — full runbooks that boot their own context ([§3](#3-headless-scripts)).
3. **Raw HTTP** — every endpoint, curl-able, for anything `mq` doesn't wrap ([§5](#5-full-http-surface-curl)).

Companion specs: [QUANT_TERMINAL_SPEC.md](./QUANT_TERMINAL_SPEC.md),
[UI_REWRITE_SPEC.md](./UI_REWRITE_SPEC.md), [AGENTIC_HEDGE_FUND_DESIGN.md](./AGENTIC_HEDGE_FUND_DESIGN.md),
[PAPER_TRADING.md](./PAPER_TRADING.md).

---

## 1. Prerequisites & run recipes

```bash
# Postgres 16 on :5433 (sudo on this box; password 5784), then migrations
echo 5784 | sudo -S docker compose up -d postgres
npm run migration:run

# Server in PAPER mode — real Binance public data + simulated fills, no key
FEED_SOURCE=binance EXECUTION_MODE=paper MOCK_TRADING_ENABLED=false \
  LIVE_AUTOSTART=false npm run start:dev          # listens on :3100
```

Execution postures (engineering switches, no business gate — see CLAUDE.md §1/§7):

| Posture | Env | What it is |
|---|---|---|
| **mock** | `FEED_SOURCE=mock EXECUTION_MODE=mock` (defaults) | synthetic feed + synthetic venue; offline, deterministic; tests/demo |
| **paper** | `FEED_SOURCE=binance EXECUTION_MODE=paper MOCK_TRADING_ENABLED=false` | **real** Binance data + `PaperVenue` (simulated fills). Real paper trading. |
| **canary/live** | `EXECUTION_MODE=canary\|live LIVE_TRADING_ARMED=true` | routes to a real venue. Arm only once an adapter is wired + testnet passes. |

Key env vars (full list in `.env.example`): `PORT=3100`, `FEED_SOURCE`,
`EXECUTION_MODE`, `MOCK_TRADING_ENABLED`, `LIVE_AUTOSTART`, `LIVE_PAIR_A/B`,
`LIVE_BETA`, `LIVE_POLL_INTERVAL_MS`, `LIVE_TRADING_ARMED`, `MERIDIAN_CLIENT_KEY`.

---

## 2. `mq` — the quant terminal

A scriptable CLI over the HTTP control plane (`bin/mq.ts`). One command per desk
action. Talks to `http://localhost:3100`; `MQ_HOST` overrides. **Every command
takes `--json`** for machine output (so an agent can parse it).

```bash
npm run mq -- <command> [args] [--flags]    # note the `--` before args
npm run mq -- help                           # full usage
```

### Research
| Command | Wraps | Notes |
|---|---|---|
| `mq presets` | `GET /api/market-data/presets` | asset-class market sets |
| `mq strategies` | `GET /api/stat-arb/live/strategies` | deployable catalogue |
| `mq backfill <preset> [--hours 72]` | `POST /api/market-data/backfill-preset` | pull real Binance history into `market_bars` |
| `mq discover <preset> [--hours 72]` | `GET /api/market-data/universe` | cointegrated pairs over stored bars |

### Backtest
| Command | Wraps | Notes |
|---|---|---|
| `mq backtest <A> <B> [--strategy id] [--hours 72] [--beta n]` | `POST /api/market-data/backtest` | one strategy on real stored bars |
| `mq sweep <A> <B> [--hours 72] [--beta n]` | loops `/backtest` per strategy | every live-capable strategy, ranked by Sharpe, names the winner |

### Deploy (live paper)
| Command | Wraps |
|---|---|
| `mq arm <A> <B> [--strategy id] [--capital 100000] [--beta n]` | `POST /configure` + `/start` |
| `mq stop` / `mq tick` / `mq flatten` / `mq kill` | `POST /stop` `/tick` `/flatten` `/kill` |
| `mq book add <A> <B> [<A2> <B2> …] [--strategy id] [--capital n]` | `POST /portfolio` |
| `mq book start` / `stop` / `flatten` / `remove <PAIR>` | `POST /portfolio/{start,stop,flatten,remove}` |

### Monitor
| Command | Wraps |
|---|---|
| `mq status` | `GET /api/stat-arb/live/snapshot` (single book) |
| `mq book` | `GET /api/stat-arb/live/portfolio` (all books) |
| `mq trades [--venue paper] [--limit 50]` | `GET /api/stat-arb/live/trades` (persisted blotter) |

### Runbook
| Command | Wraps |
|---|---|
| `mq session [--preset crypto-majors] [--hours 24] [--capital 100000]` | `scripts/quant-session.ts` (boots its own context — no server needed) |

**Strategy ids:** `pairs-zscore`, `pairs-ewma`, `ou-bertram`, `ou-bertram-fast`.
**Presets:** run `mq presets` (crypto-majors, layer-1, defi, eth-ecosystem, …).

> Not yet built (see QUANT_TERMINAL_SPEC §5): `mq watch` (TUI), `mq fund` (needs
> `/fund` read-model), `mq validate` (promotion gate).

---

## 3. Headless scripts

Run with ts-node; they boot their own Nest context, so they need **Postgres + the
Binance public REST**, but **not** a running server.

```bash
# Full runbook: catalogue → backfill → discover → backtest ALL strategies →
# drive each through the REAL LivePaperTrader over replayed real bars → report
# round-trips → arm the winner. Proves the live loop ENTERS trades.
QS_PRESET=crypto-majors QS_HOURS=24 QS_CAPITAL=100000 \
  npx ts-node -r tsconfig-paths/register scripts/quant-session.ts
#   (or simply: npm run mq -- session --preset crypto-majors --hours 24)

# In-process live smoke against real Binance (no HTTP listen — runs where the
# watch server is killed by the sandbox). End-to-end multi-asset path.
FEED_SOURCE=binance EXECUTION_MODE=paper MOCK_TRADING_ENABLED=false \
  npx ts-node -r tsconfig-paths/register scripts/smoke-live-multi-asset.ts
```

---

## 4. Build · test · DB

```bash
npm run build              # nest build → dist/
npm test                   # jest — full suite (unit + int-spec; int auto-skips w/o DB)
npx jest <path>            # one suite,  e.g. npx jest src/cli/mq-lib.spec.ts
npx tsc --noEmit           # typecheck only (no emit) — the fast green check
npm run migration:run      # apply migrations (idempotent)
npm run migration:revert   # roll back the last migration

# Postgres lifecycle (sudo; password 5784)
echo 5784 | sudo -S docker compose up -d postgres
sudo docker inspect --format='{{.State.Health.Status}}' meridian-markets-postgres-1
echo 5784 | sudo -S docker compose down
```

---

## 5. Full HTTP surface (curl)

Base `http://localhost:3100`. JSON in/out. BIGINT `*_units` are 6-decimal USDC
integers, serialised as strings.

### 5.1 Market data — `/api/market-data` (real Binance history)
```bash
curl localhost:3100/api/market-data/presets
curl -XPOST localhost:3100/api/market-data/backfill \
  -H 'content-type: application/json' \
  -d '{"symbols":["BTC","ETH"],"interval":"1m","lookbackHours":24}'
curl -XPOST localhost:3100/api/market-data/backfill-preset \
  -H 'content-type: application/json' -d '{"presetId":"crypto-majors","lookbackHours":72}'
curl 'localhost:3100/api/market-data/bars?symbol=BTC&hours=24'
curl 'localhost:3100/api/market-data/universe?presetId=crypto-majors&hours=72'
curl 'localhost:3100/api/market-data/candles?symbol=ETH&hours=24'
# The Strategy-Chart signal: per-bar z + entry/exit bands + trade markers
curl 'localhost:3100/api/market-data/signal-series?symbolA=ETH&symbolB=BTC&strategyId=ou-bertram&beta=18&hours=72'
curl -XPOST localhost:3100/api/market-data/backtest -H 'content-type: application/json' \
  -d '{"symbolA":"ETH","symbolB":"BTC","strategyId":"ou-bertram","lookbackHours":72,"beta":1.07}'
```

### 5.2 Live control plane — `/api/stat-arb/live` (paper loop; mostly via `mq`)
```bash
curl localhost:3100/api/stat-arb/live/strategies
curl localhost:3100/api/stat-arb/live/snapshot            # single book
curl localhost:3100/api/stat-arb/live/portfolio           # all books
curl 'localhost:3100/api/stat-arb/live/trades?venue=paper&limit=50'   # persisted blotter
curl -XPOST localhost:3100/api/stat-arb/live/configure -H 'content-type: application/json' \
  -d '{"symbolA":"ETH","symbolB":"BTC","beta":1.07,"strategyId":"ou-bertram","startingCapitalUsdc":100000}'
curl -XPOST localhost:3100/api/stat-arb/live/start
curl -XPOST localhost:3100/api/stat-arb/live/stop
curl -XPOST localhost:3100/api/stat-arb/live/tick         # single-step one iteration
curl -XPOST localhost:3100/api/stat-arb/live/flatten      # force-close the open position
curl -XPOST localhost:3100/api/stat-arb/live/kill         # desk-wide: halt single + portfolio
# Multi-currency portfolio
curl -XPOST localhost:3100/api/stat-arb/live/portfolio -H 'content-type: application/json' \
  -d '{"pairs":[{"symbolA":"ETH","symbolB":"BTC"},{"symbolA":"SOL","symbolB":"AVAX"}],"capitalUsdc":90000,"strategyId":"pairs-zscore"}'
curl -XPOST localhost:3100/api/stat-arb/live/portfolio/launch -H 'content-type: application/json' \
  -d '{"symbolA":"ETH","symbolB":"BTC","strategyId":"ou-bertram","capitalUsdc":50000}'  # additive, auto-starts
curl -XPOST localhost:3100/api/stat-arb/live/portfolio/start
curl -XPOST localhost:3100/api/stat-arb/live/portfolio/stop
curl -XPOST localhost:3100/api/stat-arb/live/portfolio/tick
curl -XPOST localhost:3100/api/stat-arb/live/portfolio/flatten
curl -XPOST localhost:3100/api/stat-arb/live/portfolio/remove -H 'content-type: application/json' -d '{"pair":"ETH/BTC"}'
```

### 5.3 Research (synthetic feed) — `/api/stat-arb/research`
```bash
curl 'localhost:3100/api/stat-arb/research/walk-forward?train=80&test=40&bars=360'
curl localhost:3100/api/stat-arb/research/sweep            # parameter sweep (entryZ × exitZ), ranked
curl 'localhost:3100/api/stat-arb/research/monte-carlo?reps=200&seed=42'
# Discovery / promotion log (also under /research)
curl localhost:3100/api/stat-arb/research/universe
curl -XPOST localhost:3100/api/stat-arb/research/universe/promote -H 'content-type: application/json' \
  -d '{"symbolA":"ETH","symbolB":"BTC","note":"looks cointegrated"}'
curl localhost:3100/api/stat-arb/research/universe/promotions
```

### 5.4 Synthetic demo backtest — `/api/stat-arb/demo`
```bash
curl 'localhost:3100/api/stat-arb/demo/run?scenario=calm'   # scenarios: calm|trending|volatile|decoupled
curl localhost:3100/api/stat-arb/demo/status
curl localhost:3100/api/stat-arb/demo/history               # z-score spread series
curl localhost:3100/api/stat-arb/demo/refits                # sliding cointegration refit points
curl 'localhost:3100/api/stat-arb/demo/candles?symbol=a'    # a|b
curl -XPOST 'localhost:3100/api/stat-arb/demo/reset?scenario=volatile'  # default scenario: calm
```

### 5.5 Execution-algo demo — `/api/stat-arb/exec`
```bash
curl -XPOST 'localhost:3100/api/stat-arb/exec/run?algo=twap&notional=1000000000&side=BUY'  # algo: twap|vwap|pov|iceberg · side: BUY|SELL
curl 'localhost:3100/api/stat-arb/exec/recent?limit=25'
curl -XPOST localhost:3100/api/stat-arb/exec/reset
```

### 5.6 Treasury — `/api/treasury` (guarded by `x-meridian-client-key`)
The sole sanctioned coupling with Lira-Bridge (see INTEGRATION_WITH_LIRA_BRIDGE.md).
```bash
K='x-meridian-client-key: dev-meridian-client-key-change-me'
curl localhost:3100/api/treasury/position      -H "$K"
curl localhost:3100/api/treasury/yield-earned  -H "$K"
curl -XPOST localhost:3100/api/treasury/deposit  -H "$K" -H 'content-type: application/json' \
  -d '{"amount_usdc_units":"1000000","idempotency_key":"dep-1"}'
curl -XPOST localhost:3100/api/treasury/withdraw -H "$K" -H 'content-type: application/json' \
  -d '{"amount_usdc_units":"500000","idempotency_key":"wd-1"}'
```

### 5.7 Root
```bash
curl localhost:3100/            # app root (health/hello)
curl localhost:3100/demo        # the read-only Fund Cockpit page (HTML)
```

---

## 6. What's NOT yet headless (gaps)

These are named in the specs but not built — listed so the catalogue is honest:
- `GET /api/stat-arb/fund`, `GET /api/stat-arb/books`, `GET /api/stat-arb/alerts`
  (server-side consolidated read-models — aggregate is client-side today; UI spec §5).
- `mq watch` TUI, `mq fund`, `mq validate` (QUANT_TERMINAL_SPEC §5 P1/P2).
- SSE/WebSocket stream — the feed is REST-poll today (UI spec §4).
