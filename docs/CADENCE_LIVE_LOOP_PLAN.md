# Cadence on the live loop — integration plan (C2)

**Status:** engine + driver + specs landed (this change set). The wiring into `MmBook` /
`MmPortfolioTrader` / `MarketMakingModule` is the **parent agent's** integration step — it
touches the three files this change set deliberately did **not** edit, to avoid a merge
conflict on the delicate live loop. This doc is the file-by-file spec for that step.

## Why (the profitability lever)

Naive spread MM loses to adverse selection at every spread width because of **stale quotes**
(QUANT_JOURNAL #27–#33; FAIR_VALUE_AND_THESIS_DESIGN.md §6b). The fix is two levers:

1. **Micro-price quote center** — already live in `MmBook.tick()` via `cfg.referenceMicros`
   (the F1 center). Shipped.
2. **Fast (sub-second) re-quote + a queue-aware fill model** — flipped spread-vs-adverse from
   **−$1,020 → +$133** on an 8h window, but ONLY inside the offline `LobReplayHarness`. The
   live loop still quotes off **15s closed bars** (`MM_POLL_INTERVAL_MS=15000`) with the
   **coarse bar-range fill model** (`passiveFills(bar, …)`), which is fill-on-touch (an upper
   bound) and re-quotes 600× too slowly to beat adverse selection.

This change set builds the components to bring lever (2) to the live loop:

- `src/market-making/backtest/queue-fill.ts` — the **shared** single-side FIFO fill +
  placement rule, **extracted** from `LobReplayHarness` so the offline replay and the live
  path use the **same** rule (no drift). `LobReplayHarness` now delegates to it; its specs
  pass unchanged (proof the extraction is behaviour-preserving).
- `src/market-making/live/l2-live-fill-engine.ts` — `L2LiveFillEngine`: the harness logic
  driven by **live snapshots** arriving on a fast cadence. Per `onSnapshot(tick)` it settles
  resting quotes FIFO, re-quotes off the micro-price center, marks adverse at the **re-quote
  horizon** (the fast cadence, not one bar), prices fills at the venue's real maker fee, and
  enforces a **cancel/replace latency** rail (the §6b free-lunch guard). Reuses the existing
  `InventoryBook` + `PnlAttributor` — no parallel P&L path.
- `src/market-making/live/l2-poll-driver.ts` — `L2PollDriver`: polls `IL2BookSource.l2Snapshot`
  for N symbols on a sub-second interval, parallel per symbol, best-effort, start/stop-able,
  injected-scheduler-friendly (deterministic under test). Drains an optional `ITradeStream`
  for real aggressor flow.
- `src/market-making/live/l2-fill-engine-types.ts` — the shared `LiveTick` input shape.

## The seam: an L2 fast path ALONGSIDE the bar path

The live loop today is **bar-driven**: `MmPortfolioTrader` runs one `setInterval` at
`pollIntervalMs` (15s); each tick calls every `MmBook.tick()`, which pulls the latest closed
bar and runs `passiveFills` against the bar range. That path stays **exactly as is** for
**non-L2 venues** (Binance spot, GeckoTerminal AMM, equities) — they have no depth feed, so a
queue-aware model has nothing to queue against.

For **L2-capable books (Hyperliquid — the desk's default MM venue)** we add a *second*,
faster path that replaces the bar tick for that book:

```
                          ┌─ non-L2 book (Binance/AMM/equities) ─ bar tick @ 15s  (unchanged)
MmPortfolioTrader.start() ┤
                          └─ L2 book (HL)                       ─ L2PollDriver @ MM_FAST_REQUOTE_MS
                                                                  → L2LiveFillEngine.onSnapshot()
```

The fast path is **per-L2-book**: each HL book gets its own `L2LiveFillEngine`, fed by a
shared `L2PollDriver` whose sink routes each symbol's tick to the matching engine. The bar
timer no longer ticks an L2 book (its `nextBar`/`passiveFills` path is bypassed) — the engine
owns its inventory + P&L for that book.

### Coexistence rule (one book = one fill path, never both)

A book is on **exactly one** path, decided at launch by whether its source is L2-capable
**and** the fast path is enabled:

- `source === 'hyperliquid'` **and** `MM_FAST_REQUOTE_ENABLED=true` → **fast L2 path**.
- everything else → **bar path** (today's behaviour, untouched).

Double-counting fills is the one correctness risk; the rule above is the guard — a book must
not be ticked by both the bar timer and the poll driver.

## Config flags (read ONLY in `app-config.factory.ts`)

Add to `AppConfig` (interface) + parse in `app-config.factory.ts` (the sole `process.env`
reader — CLAUDE.md §6). Everything downstream takes them as injected values.

| Flag | Default | Meaning |
|---|---|---|
| `MM_FAST_REQUOTE_ENABLED` | `false` | Master switch for the fast L2 path. Off ⇒ today's bar loop, nothing changes. |
| `MM_FAST_REQUOTE_MS` | `750` | Poll cadence for `L2PollDriver` (sub-second; 250–1000ms). |
| `MM_CANCEL_REPLACE_LATENCY_MS` | `100` | Cancel/replace round-trip the engine charges (the §6b honesty rail; 50–250ms). **Keep realistic — a 0 here is a free-lunch fantasy.** |
| `MM_FAST_MICRO_DEPTH` | `5` | Micro-price depth (levels/side) for the live F1 center. 0 ⇒ raw mid. |

These map to `AppConfig` fields (e.g. `mmFastRequoteEnabled: boolean`, `mmFastRequoteMs: number`,
`mmCancelReplaceLatencyMs: number`, `mmFastMicroDepth: number`).

## File-by-file changes the parent must make

### 1. `src/config/app-config.interface.ts` + `src/config/app-config.factory.ts`
Add the four fields above to the interface; parse them in the factory (numbers via the existing
numeric-env helper, the boolean via the existing `=== 'true'` pattern). No other file reads env.

### 2. `src/market-making/market-making.module.ts`
- Construct one shared `L2PollDriver` (or a small registry of them) using the real
  `HyperliquidClient` (already available as the `IL2BookSource` for HL books) + the real
  `REAL_POLL_SCHEDULER`, gated on `cfg.mmFastRequoteEnabled`.
- Wire the driver's `sink` to dispatch `(symbol, tick)` to the right `L2LiveFillEngine`
  (held by the matching `MmBook`, see §3). When the trader's L2 book set is empty or the flag
  is off, do not start the driver (no leaked timers).
- Pass `cfg.mmCancelReplaceLatencyMs`, `cfg.mmFastMicroDepth`, and `makerBpsFor(source)` into
  the engine config when the book factory builds an L2 book.
- Open the HL `ITradeStream` (`client.openTradeStream([...HL symbols])`) for **real** aggressor
  flow and hand it to the driver; the driver drains it per poll. (Without it the fast path is
  depth-only: it re-quotes + decays the queue but books no fills — still safe, just no edge
  read. Mirror `scripts/mm-l2-session.ts`'s `TRADES_WS` posture.)
- Start the driver in the same place the bar loop is started (the trader's `start()`), and
  stop it in `stop()` / on shutdown.

### 3. `src/market-making/live/mm-book.ts`  *(the delicate one)*
Give `MmBook` an **optional** `L2LiveFillEngine` (constructed when the book is L2-capable + the
flag is on). Two clean options for the parent to choose between:

- **(a) Composition (recommended):** `MmBook` holds an optional `fastEngine?: L2LiveFillEngine`.
  When present, the bar `tick()` becomes a no-op for fills (it may still pull a warmup bar for
  σ if desired), and a new `onL2Snapshot(tick)` method delegates to `fastEngine.onSnapshot(tick)`
  and mirrors the resulting fills into the **same** `InventoryBook` + desk-event tape the bar
  path uses (so `/api/market-making/events`, the NAV curve, and the snapshot are unchanged).
  The engine already owns an `InventoryBook`; for a single source of truth either (i) have the
  engine accept the book's existing `InventoryBook` by reference, or (ii) keep the engine's book
  and have `MmBook.snapshot()` read from `fastEngine.metrics()` when the fast path is active. (i)
  is cleaner — add an optional `inventoryBook?` to `L2LiveFillEngineConfig` so the book is shared,
  not duplicated.
- **(b) Sibling book type:** a separate `L2MmBook` that the trader holds in a parallel map. More
  isolation, but duplicates the snapshot/persistence/event plumbing — **not** recommended.

The desk-event emission (`fillEvent`/`verdictEvent`) and NAV persistence must fire on the fast
path too — route the engine's per-fill outcome through the same `this.events.emit(...)` calls
`tick()` already makes, so the Activity feed shows fast-path fills identically.

### 4. `src/market-making/live/mm-portfolio-trader.ts`
- On `start()`: start the bar timer (as today) **and** start the `L2PollDriver` if any L2 book
  exists + the flag is on. On `stop()`/shutdown: stop both.
- In the bar `tick()`: **skip** L2 books (they are driven by the poll driver, not the bar timer)
  — the coexistence rule. A simple `if (book.isFastPath()) continue;` guard.
- The poll driver's sink calls `book.onL2Snapshot(tick)` for the matching symbol; wrap it in
  the same per-book `try/catch` the bar tick uses so one book's error never sinks the loop.
- Persistence/NAV/telemetry: unchanged — they read `book.snapshot()` / `book.serializeState()`,
  which already reflect the active fill path once §3 routes the engine's P&L through the book.

## What this change set already guarantees (so the parent only has to wire)

- **No drift:** `LobReplayHarness` and `L2LiveFillEngine` both call `settleRestingOrder` /
  `placeRestingOrder` from `queue-fill.ts`. The harness's own specs pass unchanged.
- **Honest fast-requote:** the cancel/replace latency rail is unit-proven — a quote that would
  fill inside the latency window does **not** (`latencyBlockedFills > 0`, `queueFills` strictly
  lower than the zero-latency baseline). Set `MM_CANCEL_REPLACE_LATENCY_MS` realistically.
- **No parallel accounting:** the engine uses `InventoryBook` + `PnlAttributor` — the same
  P&L primitives the bar path uses. Share the `InventoryBook` (option 3a-i) for one source of
  truth.
- **No leaked timers:** `L2PollDriver.start/stop` is idempotent and releases its handle; the
  scheduler is injected (real timers in prod, fake clock in tests).
- **Money is bigint micros** end-to-end; quote-time σ/γ math is float inside the quoter only,
  rounded to micros before any fill is scored.

## THE HONEST CAVEAT (read before trusting any number)

**These unit tests prove the MECHANICS, not the edge.** They prove the queue advances, that a
fill happens iff the book trades through the resting quote, that the latency rail blocks a
free-lunch fill, that the micro-price recenters the quote, and that adverse is marked at the
fast horizon. They do **not** prove the desk makes money — that verdict only comes from an
**actual live run**: start an HL book on the fast path for hours, on real WS aggressor flow, and
read whether `spread − adverse` goes positive on the liquid coins at this cadence (the §6b
question). The offline replay's +$133 was one 8h window with ~88% estimated flow; the qualitative
flip (fast re-quote beats adverse) is robust, the exact number is not gospel. The honesty gate
stays the same: queue-aware fills (a realistic lower-ish bound), real maker fee, realistic
cancel/replace latency — and a forward paper track record is the only thing that turns the
mechanism into a claim.

## Suggested validation sequence (parent, after wiring)

1. `MM_FAST_REQUOTE_ENABLED=false` → confirm the bar loop + all existing MM tests are byte-for-byte
   unchanged (the flag-off safety).
2. `MM_FAST_REQUOTE_ENABLED=true MM_FAST_REQUOTE_MS=750 MM_CANCEL_REPLACE_LATENCY_MS=100` with an
   HL book → confirm the poll driver fetches, the engine re-quotes sub-second, fills route to the
   shared `InventoryBook`, and the Activity feed + NAV curve show fast-path fills.
3. Run it forward for hours and read `spread − adverse` per coin vs the bar-path baseline — the
   real C2 verdict.
