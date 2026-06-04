# Meridian Markets — Roadmap

> **Living doc.** The single place to see where the system is, what's done, and what's parked vs. active. Updated as priorities shift. For the chronological build log see [SESSION_HISTORY.md](SESSION_HISTORY.md) + [QUANT_JOURNAL.md](QUANT_JOURNAL.md); for the honest research verdicts see [RESEARCH_FINDINGS.md](RESEARCH_FINDINGS.md).

## Mission (current)

Meridian is a **persistent paper-trading system for systematic-strategy research** — and the precursor to an **AI-agent-run quant trading group**. It runs multiple strategies concurrently on real market data, minimises drawdown, conserves equity, and — as of the 2026-06-04 re-scope — **survives restart like a real company's books** (P&L, positions, NAV all durable). It is **paper-only** until the agent group is ready; real capital and real-venue routing stay parked. Honesty about the numbers is the whole point.

This supersedes the earlier "paper-trading *demo*" framing: the deliverable is now a real, restart-safe, multi-hour/multi-day research system.

---

## Done

### P0 — the validation gates (keep the numbers honest)
| Gate | What it added | Status |
|---|---|---|
| **P0.1** | sim-fidelity: half-spread + linear market impact (λ·notional/ADV) — *flipped the rankings* | ✅ |
| **P0.2** | walk-forward on real history; β re-fit per train window (Engle-Granger) | ✅ |
| **P0.3** | multiple-testing: deflated Sharpe / PSR + purged k-fold (purge + embargo) | ✅ |
| **P0.4** | short-borrow carry in the cost model (equities) | ✅ |
| **P0.5** | coverage block + the **survivorship gate** (caps survivor-only reads to UPPER-BOUND) | ✅ |

### The build arc
- **Engine** (S1–18): signal/risk/backtest/execution libraries → real Binance data spine → live paper loop → multi-asset, multi-currency portfolio.
- **MM desk** (S19–22): Symmetric/AS/GLFT quoters, inventory book, VPIN + risk gate, MM backtest + 4-component P&L attribution, fees in the *entry* decision, OOS gate + desk roles.
- **The pivot** (S23): cointegration cliff kills crypto stat-arb → MM becomes the live earner.
- **Equities diversifier** (S24–26): Alpaca adapters → OOS gate + scanner on equities → Yahoo daily research console.
- **Mission reframe + survivorship** (S27).
- **Discovery frontier** (S28–35): GeckoTerminal DEX → DEX books quote live → σ-normalization → Hyperliquid wired → L2 queue-aware fills → per-pool γ/κ tuning + venue fees + notional sizing → HL = default MM venue.
- **2026-06-04 session**: trades/WS aggressor feed → funding carry full-stack (sourced → priced → backtest accrual → live-book accrual) → P&L-accounting + research-findings + cheatsheet docs → **restart-safe books (in progress)**.
- **Backend telemetry P1**: `src/telemetry/` — config-gated `ITelemetry` swap seam + dependency-free Prometheus registry, `GET /metrics` + `GET /health[/ready]`, desk/feed/persist metrics pulled from `snapshot()` + the instrumented tick loop. Off by default. 143 suites / 942 tests.
- **Backend telemetry P3** (durable NAV): append-only `mm_nav` per-interval series (desk + per-book equity) written by `MmNavCron` from `snapshot()`, `GET /api/market-making/nav`, gated by `MM_PERSIST`. The multi-day track record, restart-safe; persisted desk NAV == the `meridian_desk_nav_units` gauge to the unit. 146 suites / 962 tests.

### Research verdicts ([RESEARCH_FINDINGS.md](RESEARCH_FINDINGS.md))
Crypto stat-arb *killed* (cointegration cliff) · equities ~0.06 Sharpe *survivorship-bound* · funding carry *real but modest* · FX-stable basis *sub-fee → route to maker* · options VRP *validated, in reserve* · MM on HL *structurally positive at ≤0bps maker*.

---

## Active — persistence (the 2026-06-04 re-scope)

Make the system restart-safe and multi-hour-robust. Phased:

- **Phase 1 ✅** — lossless `serialize()`/`restore()` of `InventoryBook` + `MmBook` (ledger + all P&L accumulators), unit-tested.
- **Phase 2 ✅** — `mm_book_state` migration (mutable checkpoint, soft-close, app-role grants) + `MmStateRepository` + `IMmStateStore` (Postgres / Null), config-selected.
- **Phase 3 ✅** — `MmPortfolioTrader` rehydrates OPEN books on boot (`OnApplicationBootstrap`) + checkpoints every tick + soft-closes on remove; `OnApplicationShutdown` hook flattens (when `MM_FLATTEN_ON_SHUTDOWN`) then checkpoints; `app.enableShutdownHooks()`; `MM_PERSIST` flag. **Default off ⇒ no-DB runs + tests unchanged** (911 tests green). MM books now survive restart with P&L, positions, and config intact.
- **Durable NAV / equity-curve history ✅** — append-only `mm_nav` per-interval series (desk + per-book) written by `MmNavCron` from `snapshot()` each `MM_NAV_INTERVAL_MS`, queryable at `GET /api/market-making/nav` — the multi-day research output, restart-safe (gated by `MM_PERSIST`). Persisted desk NAV matches the `meridian_desk_nav_units` gauge to the unit. ([TELEMETRY_REQUIREMENTS.md](TELEMETRY_REQUIREMENTS.md) P3.)
- **Next** — extend the same restart-safety to **stat-arb live books** (in-memory today).

### Backend telemetry / observability ([TELEMETRY_REQUIREMENTS.md](TELEMETRY_REQUIREMENTS.md))
A system meant to run unattended for hours/days must be **observable** — operational health (process, tick loop, feeds, DB), financial health (equity, drawdown, fills, risk verdicts), data-quality (feed staleness, WS state), and persistence health. Four pillars (metrics / structured logs / traces / health endpoints) behind a config-gated swap seam (no-op default), exporting to Prometheus + OpenTelemetry. Phased: **P1 ✅ shipped** — `ITelemetry` seam (Null default + dependency-free Prometheus registry) at `GET /metrics` + `GET /health[/ready]`, `TELEMETRY_ENABLED` (default off ⇒ no-op). Operational + feed (poll/staleness) + desk/financial (mapped from `snapshot()` on scrape — equity/PnL/fees/funding/inventory/maxDD/fills/risk-verdict/NAV) + persistence metrics; tick count/duration/**overrun** + uniform alert hook; readiness = DB (under `MM_PERSIST`) + tick freshness + feed staleness (`src/telemetry/`, 6 specs). **P3 ✅ shipped** — append-only `mm_nav` (desk + per-book equity per interval) written by `MmNavCron` from `snapshot()`, `GET /api/market-making/nav`, gated by `MM_PERSIST` (`src/market-making/persistence/mm-nav.*`); persisted desk NAV == the `meridian_desk_nav_units` gauge to the unit. → **P2** structured logs → **P4** traces + uniform alerting + `ws_connected`/`feed_gaps` + a starter Grafana dashboard.

---

## Parked → re-evaluate now (mission shift to a system + agent group)

| Item | Why now | Call |
|---|---|---|
| **Restart-safe books** | the new requirement | ✅ un-parking (Active above) |
| **Graceful shutdown / multi-hour robustness** | unattended multi-hour runs need shutdown hooks, reconnect/error resilience, funding refresh | do now (with persistence) |
| **Stat-arb live persistence** | "everything survives" — stat-arb books are in-memory today | do now (after MM) |
| **Durable NAV / track-record history** | the research *output* is multi-day equity curves | ✅ done (append-only `mm_nav` + `MmNavCron` + `/api/market-making/nav`, Telemetry P3) |
| **Capital allocator across books/agents** | an agent *group* needs per-agent/strategy capital allocation | next big piece |
| **Cross-venue funding capture** (long spot / short HL perp) | HL funding is wired; this is the deployable delta-neutral form | research → live |
| **The agentic layer** ([AGENTIC_HEDGE_FUND_DESIGN.md](AGENTIC_HEDGE_FUND_DESIGN.md)) | "each strategy manned by a quant agent" is now the headline goal | the destination |

## Stays parked (genuinely future)

- **Real-venue adapter + real capital** — paper-only until the agent group is ready.
- **Real maker/limit order routing** — paper simulates fills; not needed until a real venue.
- **Venue breadth + deeper fidelity** — dYdX / Drift / more perp-DEX CLOBs, L2-over-WS (vs 60s REST polls), Johansen multivariate cointegration, options as a live book. Research breadth, after the system foundation is solid.

---

## Immediate path

Finish persistence end-to-end (phases 2–3), extend to stat-arb books + durable NAV, then take up the **capital allocator** and the **agentic layer** — the two pieces that turn a restart-safe multi-strategy system into an agent-run quant group. The P0 gates + queue-aware fills + venue fees + survivorship gate remain the live honesty discipline throughout.
