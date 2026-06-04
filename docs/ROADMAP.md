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

### Research verdicts ([RESEARCH_FINDINGS.md](RESEARCH_FINDINGS.md))
Crypto stat-arb *killed* (cointegration cliff) · equities ~0.06 Sharpe *survivorship-bound* · funding carry *real but modest* · FX-stable basis *sub-fee → route to maker* · options VRP *validated, in reserve* · MM on HL *structurally positive at ≤0bps maker*.

---

## Active — persistence (the 2026-06-04 re-scope)

Make the system restart-safe and multi-hour-robust. Phased:

- **Phase 1 ✅** — lossless `serialize()`/`restore()` of `InventoryBook` + `MmBook` (ledger + all P&L accumulators), unit-tested.
- **Phase 2 (in progress)** — `mm_book_state` migration (mutable checkpoint, soft-close, app-role grants) + `MmStateRepository` + `IMmStateStore` (Postgres / Null), config-selected.
- **Phase 3** — trader rehydrates books on boot + checkpoints each tick; `OnApplicationShutdown` hook with optional flatten (`MM_FLATTEN_ON_SHUTDOWN`); `MM_PERSIST` config flag. Default off ⇒ no-DB runs + tests unchanged.
- **Then** — extend the same to **stat-arb live books** and add **durable NAV / equity-curve history** (the multi-day research output).

---

## Parked → re-evaluate now (mission shift to a system + agent group)

| Item | Why now | Call |
|---|---|---|
| **Restart-safe books** | the new requirement | ✅ un-parking (Active above) |
| **Graceful shutdown / multi-hour robustness** | unattended multi-hour runs need shutdown hooks, reconnect/error resilience, funding refresh | do now (with persistence) |
| **Stat-arb live persistence** | "everything survives" — stat-arb books are in-memory today | do now (after MM) |
| **Durable NAV / track-record history** | the research *output* is multi-day equity curves | do now (with persistence) |
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
