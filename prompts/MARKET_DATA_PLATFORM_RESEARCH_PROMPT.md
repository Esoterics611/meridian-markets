# Research prompt — local "Bloomberg-terminal-grade" market-data platform (its own repo)

> Paste into a **Claude chat (claude.ai) with web search / research enabled**. The deliverable
> is a **detailed implementation plan**, NOT code — I will build it in Claude Code afterwards,
> in a **brand-new, separate repository** (it is NOT part of any existing trading-engine repo;
> the trading engine will consume this platform over a network API/contract).

---

You are a principal-level market-data infrastructure architect. I want to build a **locally-run, self-hosted market-data platform** that replicates the *useful* functionality of a Bloomberg Terminal at hedge-fund quality, using **free or near-free** data sources, with a **terminal-app (TUI) interface** (I'm happy for it to be terminal-first — I think that's how serious systems are actually operated). Real-time, global, multi-asset. It must be its **own repository** and expose a clean API so other systems (e.g. a stat-arb engine) can consume it.

Do deep web research, then produce a **comprehensive, build-ready implementation plan**. Show your reasoning and trade-offs — I want to see the analysis, not just conclusions.

## Part 1 — Data-source research (the core of this task)

Survey **free / freemium / open** real-time and historical data sources across asset classes. For **each** source, give a structured row:

- Asset class & instruments covered (crypto spot/perp, US + intl equities, ETFs, FX, rates/treasuries, futures, options, indices, macro/econ, fundamentals, news, on-chain).
- Access: REST / WebSocket / FIX / bulk download; auth (none / free key / OAuth).
- **Real-time vs delayed** (and the delay), update frequency, latency.
- **Historical depth** and granularity (tick / 1m / EOD).
- **Rate limits** (req/min, WS connection/subscription caps, message caps).
- **Licensing / ToS reality**: may I store it locally, redistribute internally, display it, use it commercially? Flag anything that prohibits caching/redistribution.
- Reliability / community / longevity signal.

Cover at least: **Crypto** — Binance, Bybit, OKX, Coinbase, Kraken, Hyperliquid, Deribit (public WS+REST, no key). **Equities/ETFs** — Alpaca (free), IEX Cloud, Polygon.io free tier, Finnhub, Tiingo, Twelve Data, Alpha Vantage, Yahoo Finance / `yfinance`, Stooq, EOD Historical Data. **FX** — exchange-rate APIs, OANDA, Polygon FX, TrueFX. **Macro/econ** — FRED, ECB SDW, World Bank, BIS, Eurostat, Treasury.gov. **Fundamentals** — SEC EDGAR (10-K/Q, full-text), Financial Modeling Prep, SimFin. **News/sentiment** — RSS, GDELT, Finnhub news, Reddit/X (note ToS). **On-chain** — public RPCs, blockchain explorers, The Graph, DefiLlama.

Then give a **recommended source matrix**: per asset class, the primary + fallback source, with the rationale (coverage × cost × license × latency). Explicitly flag the legal landmines (which feeds forbid local storage/redistribution) and how to stay compliant for **personal/internal research** use.

## Part 2 — "Bloomberg terminal" functional decomposition

Break the Bloomberg Terminal into the functions worth replicating, and mark each: replicable-with-free-data / partial / not-feasible. At minimum: real-time quotes & depth; multi-pane charting (intraday + historical, indicators); cross-asset watchlists; news feed + filtering; fundamentals & filings; economic calendar & macro series; screeners; alerting; historical analytics / backtest data; a **command/keyboard-driven UX** (Bloomberg's `<TICKER> <GO>`, function mnemonics like `GP`, `DES`, `FA`, `ECO`, `N`). Propose a **command grammar** for a TUI equivalent.

## Part 3 — Architecture (local-first, hedge-fund quality)

Design the system and justify each choice:

- **Ingestion layer:** per-source adapters (WS subscribe + REST backfill), normalization to a canonical schema, a symbology/reference-data service (cross-source symbol mapping), gap detection + backfill, reconnection/heartbeat.
- **Storage:** evaluate **TimescaleDB vs QuestDB vs ClickHouse vs DuckDB + Parquet** for ticks/bars at scale, plus a reference-data store and a hot cache. Recommend one with reasoning (write throughput, query latency, footprint on a single workstation, ops burden).
- **Real-time bus:** Redis Streams / NATS / Kafka / in-process — for fan-out to the TUI and to API consumers. Recommend for a single-node local deploy.
- **Query/compute layer:** rollups/continuous aggregates, resampling, a small analytics API (returns, vol, correlation, spread).
- **Service API:** how external systems (e.g. a stat-arb engine) subscribe — WebSocket + REST + maybe gRPC. Define the **contract** (it's a separate repo).
- **TUI layer:** compare **Textual/Rich (Python), Bubble Tea (Go), Ratatui (Rust)**; terminal charting (`plotext`, sparklines) and an optional web view reusing TradingView `lightweight-charts`. Recommend a stack and say why. Multi-pane/multi-monitor layout, keyboard-first.
- **Language/runtime:** recommend (Python for breadth of data libs? Go/Rust for the hot path? a hybrid — Rust/Go ingestion + Python analytics?). Justify against latency, ecosystem, and solo-dev velocity.

## Part 4 — Deliverable: the build plan

Produce a plan I can hand to Claude Code:

1. **Repo name + structure** (directory tree), separate-repo boundaries, and the consumer contract.
2. **Tech-stack decision table** with the chosen option + the runner-up + why.
3. **Prioritized data-source adapter list** (build order; crypto-public first since it needs no keys).
4. **Canonical data schema** (instruments, bars, ticks, quotes, news, fundamentals, macro).
5. **Phased milestones** — e.g. M0 single crypto WS → local store → TUI quote board; M1 multi-source + symbology + charts; M2 news/macro/fundamentals + screeners; M3 alerting + the API contract + analytics. Each milestone: scope, acceptance test, rough effort.
6. **Risk register:** data-license risks, rate-limit/ban risks, single-node scaling limits, and mitigations.
7. **"Definition of done" for a v1** that genuinely feels like a usable terminal.

Be specific, opinionated, and quantitative (cite limits/latencies you find). Where you're uncertain, say so and propose how to verify. Optimize the plan for a **single capable developer using Claude Code**, building incrementally, starting with **zero-cost, no-auth crypto data** and expanding outward.
