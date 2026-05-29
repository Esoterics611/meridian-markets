# Paper trading — running the engine on real market data

This is real paper trading: **real** Binance public market data + simulated fills.
No API key, no account, no business sign-off. The same code path runs live trading
later — only the injected venue changes — so paper results predict live behaviour.

## Run it

```bash
# Postgres up + migrated (see meridian-start), then:
FEED_SOURCE=binance \
EXECUTION_MODE=paper \
LIVE_AUTOSTART=true \
LIVE_PAIR_A=BTC LIVE_PAIR_B=ETH \
LIVE_POLL_INTERVAL_MS=15000 \
npm run start:dev
```

The loop pulls the latest **closed** 1-minute bar for each leg, runs the pairs
strategy, and routes orders to `PaperVenue` (fills pegged to the live Binance
ticker, taker fee modelled). It marks the open position to market every bar and
persists each closed round-trip to `stat_arb_trades`.

> The strategy needs `LIVE_Z_LOOKBACK + 1` bars (default 21) before it computes a
> z-score, so expect ~20 minutes of warm-up on 1m bars before the first possible
> entry. Use a smaller `LIVE_Z_LOOKBACK` or a faster `FEED_INTERVAL` to iterate.

## Drive it from a terminal

```bash
curl -s localhost:3100/api/stat-arb/live/snapshot | jq    # book: z, regime, PnL, position
curl -sX POST localhost:3100/api/stat-arb/live/start | jq # start the loop
curl -sX POST localhost:3100/api/stat-arb/live/stop  | jq # halt
curl -sX POST localhost:3100/api/stat-arb/live/tick  | jq # single-step one bar (debug)
```

`GET /snapshot` is also what the web dashboard reads — the dashboard is just one
consumer of the same JSON. The engine is headless; the terminal is the control
plane.

## Tunables (all env-driven, see `.env.example`)

| Var | Meaning | Default |
|---|---|---|
| `FEED_SOURCE` | `binance` (real public data) or `mock` | `mock` |
| `FEED_QUOTE` / `FEED_INTERVAL` | quote asset / kline interval | `USDT` / `1m` |
| `LIVE_PAIR_A` / `LIVE_PAIR_B` | the pair | `BTC` / `ETH` |
| `LIVE_BETA` | hedge ratio | `1` |
| `LIVE_Z_LOOKBACK` | rolling z-score window | `20` |
| `LIVE_ENTRY_Z` / `LIVE_EXIT_Z` | entry / exit z thresholds | `2` / `0.5` |
| `LIVE_NOTIONAL_UNITS` | per-leg notional (6-dec USDC units) | `1000000000` (1000 USDC) |
| `LIVE_POLL_INTERVAL_MS` | loop cadence | `15000` |
| `LIVE_AUTOSTART` | start the loop on boot | `false` |

## What's simulated vs real

- **Real:** prices, bars, the spread/z-score/cointegration math, the strategy
  decisions, fee modelling, PnL accounting, persistence.
- **Simulated:** the fill. `PaperVenue` assumes you fill the full notional at the
  current ticker price (no partial fills, no queue position, no slippage beyond
  the modelled taker fee). The slippage model and exec algos exist separately
  and are not yet in the live loop — that's the main paper-vs-live gap to close.

## Going to a real venue later (separate, deliberate)

`canary`/`live` modes require a real `ITradingVenue` adapter and
`LIVE_TRADING_ARMED=true`. That arm switch is an engineering gate ("the adapter
is wired and a testnet round-trip passed"), enforced by `ExecutionModeBootGuard`.
Flipping real money on is a human decision taken outside the code.
