# Session 18 — Live multi-asset demo: real Binance, market presets, research→trading

> Owner-directed pivot of priorities (2026-05-29). The `/demo` was a self-contained
> **synthetic** showcase wrapped in KYB / Phase-gate / investor-disclosure theater that
> contradicts the Session-17 engine-as-product reframe. The engine underneath can already
> paper-trade real Binance data and backtest real history — but the demo never surfaced it.
> This session points the demo at **live Binance**, adds **multi-asset-class market presets**,
> wires **research (pair discovery) into the trading screens**, and lets the user **switch
> between presaved markets** on live data.

## Why (the gap)

- `DemoService.runFreshBacktest()` runs `generateSyntheticFeed()` with scenario knobs
  (calm/trending/volatile/decoupled). Fully synthetic.
- `runUniverse()` runs `generateSyntheticUniverse()`. Fully synthetic.
- `/candles` serves synthetic bars.
- The real-data spine already exists but is unwired to the UI:
  - `POST /api/market-data/backfill` → pulls real Binance klines into `market_bars`.
  - `POST /api/market-data/backtest` → backtests over real stored bars.
  - `POST/GET /api/stat-arb/live/*` → real paper loop on live Binance (BTC/ETH, single pair).
- The UI still shows "KYB & external counterparty status", "Phase Gate Timeline",
  "Investor Disclosures", "Hypothetical track-record" — all dead framing post-pivot.

## Deliverables (this session)

1. **Multi asset-class market presets** — curated sets of real Binance spot symbols grouped
   by asset class (majors, L1 alts, DeFi, etc.). Pure catalog + resolver + endpoint.
2. **Switch between presaved markets on live data** — pick a preset → backfill its symbols
   from real Binance → it becomes the active universe; the live loop can be re-pointed to any
   pair in it.
3. **Wire research into trading screens** — pair discovery / clustering / regime run over the
   preset's REAL `market_bars`; the discovered-pairs table gets "Backtest" + "Trade live"
   actions that load the pair into the Trader screen.
4. **Demo on live Binance + full backtesting** — Trader screen reads the real paper loop
   (`/live/snapshot`); backtests run on real history; candles come from `market_bars`. Strip
   the synthetic-scenario picker and the KYB/Phase/disclosure theater.

Session-10 ("multi-strategy router + funding-carry + budget allocator") is **reprioritised as
multi-asset breadth**, not the full strategy-registry/allocator build — that stays queued. The
spirit (engine runs across a universe, not one hardcoded pair) is delivered via preset/pair
switching.

## Build order

- **Backend**
  - `src/stat-arb/markets/market-presets.ts` (+spec) — asset-class-grouped Binance symbol sets.
  - `MarketDataRepository.distinctSymbols()` + `barsForSymbols()` (+spec) — multi-symbol reads.
  - Real-data discovery path: `runUniverse({ source:'real', preset })` reads `market_bars`.
  - `MarketsController` — `GET presets`, `POST backfill-preset`, `GET universe?preset=`.
  - `LivePaperTrader.reconfigure(symbolA, symbolB)` + `POST /live/configure` — repoint the loop.
- **Frontend** (`src/stat-arb/demo/public/index.html`)
  - Market-preset switcher (top bar). Trader screen reads `/live/snapshot` on real data.
  - Research/Universe table → "Backtest" / "Trade live" actions feed the Trader screen.
  - Real candles. Remove KYB/Phase/Investor-disclosure/Synthetic-scenario UI.

## Rails (unchanged)

- Modular monolith; one DB; `process.env` only in `app-config.factory.ts`.
- In-repo `market-data` is the **interim** spine; the standalone market-data platform
  (separate repo, see `MARKET_DATA_PLATFORM_RESEARCH_PROMPT.md`) replaces it later over a
  network contract. Keep the repository read seam clean.
- `tsc --noEmit` clean + `jest` green + a real-Binance smoke before commit.

## Known pre-existing issue (NOT this session)

- Uncommitted Track-B WIP (`venues/`, `real-binance-venue.ts`) has 2 red specs
  (rate-limiter time-injection). Left untouched; this session's commit is scoped to its own files.
