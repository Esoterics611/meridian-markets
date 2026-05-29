# 9. Testing the lessons in Meridian Markets

> **What this chapter is.** Every prior chapter teaches a *method*. This one is the
> lab: how to run each method against **real Binance data** inside the
> `meridian-markets` engine that ships in this repo. Nothing here is synthetic —
> the engine pulls live public Binance bars, discovers pairs on them, backtests on
> real history, and paper-trades the live feed. No API key, no account, no money.
>
> The engine is the product; the web `/demo` is one read-only view over it. Every
> lesson below is drivable from a terminal so you can script it.

## 9.1 One-time setup

```bash
# from the repo root
cp .env.example .env                      # once; gitignored
echo "5784" | sudo -S docker compose up -d postgres   # Postgres 16 on :5433
npm run migration:run                     # creates market_bars, stat_arb_trades, …
```

Run the engine in **live paper mode** — real Binance public data into a paper
venue that simulates fills at the live price:

```bash
FEED_SOURCE=binance EXECUTION_MODE=paper MOCK_TRADING_ENABLED=false \
  LIVE_AUTOSTART=false npm run start:dev
# API on :3100, live console at http://localhost:3100/demo
```

`FEED_SOURCE=binance` selects the real `IBarFeed`; `EXECUTION_MODE=paper` selects
`PaperVenue`. These are **engineering switches**, not a business gate — paper
trading needs nothing. `live`/`canary` additionally require `LIVE_TRADING_ARMED=true`
(see [§7](07-production.md)).

!!! note "Offline = mock; live = binance"
    The unit tests (`npm test`, 550+ specs) run fully offline against synthetic
    feeds and a mock venue — that is the test seam, and it is the *only* place mock
    data lives. The moment you set `FEED_SOURCE=binance` the running engine uses
    only real data.

## 9.2 The lesson → engine map

| Chapter | Lesson | Where it lives | How to exercise it |
|---|---|---|---|
| §2 Cointegration | Engle-Granger, half-life, z-score | `signal/cointegration.ts`, `signal/ou.ts`, `signal/z-score.ts` | `npm test -- cointegration ou z-score`; live: §9.4 discovery |
| §2.8 Universe | Filter infinite pairs → tractable book | `discovery/{pair-discovery,clustering}.ts` | `GET /api/market-data/universe?presetId=…` (§9.4) |
| §3 OU | Bertram thresholds, OU fit diagnostics | `signal/ou.ts`, `regime/regime-detector.ts` | `npm test -- ou regime` |
| §4 Execution | Venue abstraction, slippage, TWAP/VWAP | `execution/`, `stat-arb/historical-replay-venue.ts` | `GET /api/stat-arb/exec/run?algo=twap&…` |
| §5 Risk | Drawdown, exposure, venue caps, Kelly | `risk/*` + `RiskEngine` | `npm test -- risk`; live gates fire in `/live/snapshot` |
| §6 Backtesting | Event-driven, walk-forward, sweep, MC | `backtest/`, `research/*` | §9.5 (real-data backtest) + §9.6 (research) |
| §7 Production | Shadow phase, paper→live parity | `execution/live-paper-trader.ts` | §9.7 (live paper loop) |
| §8 More strategies | Cross-sectional baskets, funding carry | `discovery/clustering.ts`, `funding_rates` table | §9.4 (baskets); funding carry = skeleton, see §8.4 |

## 9.3 Pick a market — multi-asset presets

The engine ships curated **market presets**: sets of real Binance spot symbols
grouped by asset class. List them:

```bash
curl -s localhost:3100/api/market-data/presets | jq '.presets[] | {id,label,assetClass,symbols}'
```

| Preset id | Asset class | Symbols (abbrev.) |
|---|---|---|
| `crypto-majors` | Large Cap | BTC ETH BNB SOL XRP LTC BCH ADA AVAX LINK |
| `l1-smart-contract` | Layer 1 | SOL ADA AVAX NEAR DOT ATOM APT SUI TRX ALGO |
| `defi-bluechip` | DeFi | UNI AAVE LINK MKR CRV LDO COMP SNX INJ |
| `eth-ecosystem` | ETH Beta | ETH ARB OP MATIC LDO LINK UNI |
| `payments-sov` | Cross-Asset | BTC LTC BCH XRP XLM **PAXG** (tokenised gold) |

These are the "presaved markets" you switch between in the console. Each is a
testbed for §2.8: a real, finite candidate universe.

## 9.4 §2 + §2.8 + §8 — discover pairs on real data

Backfill the preset's real Binance history into `market_bars`, then run the same
discover→cluster→regime pipeline the course teaches — on real bars:

```bash
# pull ~72h of 1m bars for every symbol in the preset
curl -s -XPOST localhost:3100/api/market-data/backfill-preset \
  -H 'content-type: application/json' \
  -d '{"presetId":"defi-bluechip","lookbackHours":72}' | jq '{symbols,totalBarsInserted}'

# discover: Engle-Granger p-value, half-life, β, clustering, regime — all real
curl -s 'localhost:3100/api/market-data/universe?presetId=defi-bluechip&hours=72' \
  | jq '.source, (.topPairs[] | {pair:(.symbolA+"/"+.symbolB), beta, pValue, halfLifeBars, regime:.regime.vol})'
```

A healthy response looks like this (values vary with the live tape):

```json
"real-binance-history"
{ "pair": "AAVE/UNI",  "beta": 1.12, "pValue": 0.018, "halfLifeBars": 14.2, "regime": "NORMAL" }
{ "pair": "CRV/COMP",  "beta": 0.78, "pValue": 0.041, "halfLifeBars": 22.7, "regime": "LOW" }
{ "pair": "MKR/AAVE",  "beta": 1.34, "pValue": 0.067, "halfLifeBars": 31.0, "regime": "NORMAL" }
```

Read it the way the course teaches: a `pValue < 0.05` is *necessary not
sufficient* (§2.2); a `halfLifeBars` in the 5–30 range is tradeable while >50 is
too slow to matter (§2.4); the `regime` chip warns you when realised vol is
elevated (§3.5 / `regime-detector.ts`).

`source` reads `real-binance-history`. This is §2.2 (cointegration test), §2.4
(half-life), §2.8 (universe filtering) and §8.2 (clustering into baskets) running
end-to-end on live data. Read [§2.8](02-cointegration.md#28-universe-construction--from-infinite-candidate-pairs-to-a-tractable-book)
alongside the output: the **multiple-testing trap** is visible here — widen the
preset and watch low-p-value pairs appear that are statistical accidents. With 10
symbols you test $\binom{10}{2}=45$ pairs; at $p<0.05$ you *expect* ~2 false
positives by pure chance, so a single "significant" pair in a 45-pair sweep is
noise until it survives the held-out window (§6.3).

## 9.5 §6 — backtest honestly on real history

Run the event-driven backtest ([§6.2](06-backtesting.md#62-event-driven-beats-vectorised))
over the **real stored bars** for a discovered pair, with the discovered β:

```bash
curl -s -XPOST localhost:3100/api/market-data/backtest \
  -H 'content-type: application/json' \
  -d '{"symbolA":"AAVE","symbolB":"UNI","beta":1.12,"lookbackHours":72,"entryZ":2,"exitZ":0.5}' \
  | jq '{pair, bars:.window.bars, source, metrics, tradeCount}'
```

The same `PairsStrategy.onBar()` the live loop runs is invoked here against a
`HistoricalReplayVenue` — the **byte-similarity argument** of §6.2 in practice.
Compare `metrics.sharpeRatio` and `metrics.maxDrawdownPct` against the chapter's
acceptance bands. Sweep `entryZ`/`exitZ` and watch the in-sample Sharpe inflate —
that's exactly the overfitting §6.5 warns about.

## 9.6 §6 — research endpoints (walk-forward, sweep, Monte Carlo)

The Research desk operationalises [§6.3](06-backtesting.md#63-purged-k-fold-cross-validation-worked-example)–§6.5:

```bash
curl -s localhost:3100/api/stat-arb/research/walk-forward | jq '.windows | length, .[0]'
curl -s localhost:3100/api/stat-arb/research/sweep        | jq '.best'
curl -s localhost:3100/api/stat-arb/research/monte-carlo  | jq '.probPositive'
```

Walk-forward = train/test split honesty; sweep = the parameter grid whose best
in-sample Sharpe you must *deflate*; Monte-Carlo = the null distribution your
strategy must beat. Read each value against §6.5's deflated-Sharpe argument.

## 9.7 §7 — paper-trade the live feed (the shadow phase)

This is [§7.1](07-production.md#71-the-shadow-phase-running-live-without-spending-money)'s
shadow phase, in code. Point the live loop at a discovered pair and arm it:

```bash
# set the desk's starting capital (makes equity/drawdown read realistically)
curl -s -XPOST localhost:3100/api/stat-arb/live/configure \
  -H 'content-type: application/json' -d '{"startingCapitalUsdc":100000}' | jq .capitalUnits

# repoint the loop at a live pair (β from discovery) and start it
curl -s -XPOST localhost:3100/api/stat-arb/live/configure \
  -H 'content-type: application/json' -d '{"symbolA":"AAVE","symbolB":"UNI","beta":1.12}' >/dev/null
curl -s -XPOST localhost:3100/api/stat-arb/live/start >/dev/null

# watch the book: z-score, regime, equity, open position, realised PnL, feed age
watch -n5 'curl -s localhost:3100/api/stat-arb/live/snapshot | jq "{running,symbolA,symbolB,lastZ,regime,equityUnits,realisedPnlUnits,openPosition}"'
```

The loop pulls aligned **closed** 1m bars for both legs, runs the strategy, routes
to `PaperVenue`, marks to market, and books realised PnL on close. Because the
feed serves only closed bars, there is no look-ahead ([§6.1](06-backtesting.md#61-why-honest-backtesting-is-hard)).
Compare the live trade frequency to the §9.5 backtest's — §7.1's acceptance band
("within ±30% of expected frequency") is the gate.

To **switch markets live**, repeat the `configure` call with a new pair (or pick
one in the console). The loop wipes its book and rebuilds the strategy with the
new β — the same engine, a different slice of the live universe.

## 9.8 Or just open the console

```
http://localhost:3100/demo
```

Pick a market set → **Backfill live history** → the discovered-pairs table fills
from real data → click **trade** to paper-trade a pair on the live feed, or
**backtest** to run it over real history. Set starting capital in the top bar.
Every number on the page is live; there is no synthetic path.

## 9.9 Honest gaps (what this repo does *not* yet test)

In the spirit of [§6](06-backtesting.md) — here is what the engine cannot yet
exercise, so you don't mistake an absence for a pass:

- **Funding-carry / basis ([§8.4](08-more-strategies.md#84-funding-carry-the-perp-basis-trade)).** The `funding_rates` table and repository exist, but there is no `FundingCarryStrategy` or funding ingest wired in. The signal is a **skeleton** — see §8.4 for the shape to build.
- **Johansen multivariate ([§2.3](02-cointegration.md#23-johansens-test-multi-variate)).** Only Engle-Granger two-step is implemented. Baskets of 3+ legs are clustered (§8.2) but not Johansen-cointegrated.
- **Purged k-fold CV ([§6.3](06-backtesting.md#63-purged-k-fold-cross-validation-worked-example)).** Walk-forward exists; the *purge + embargo* refinement is not yet a separate runner.
- **Deflated Sharpe ([§6.5](06-backtesting.md)).** The sweep reports a best in-sample Sharpe; the DSR correction is computed by hand from the sweep size, not by the endpoint.

Each gap is a concrete next exercise: implement it behind the existing
interfaces, add a `*.spec.ts`, and it becomes testable here.
