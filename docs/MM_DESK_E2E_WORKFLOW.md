# MM Desk — End-to-End Workflow, P&L Roll-Up, and Ghost-Code Audit

> Written 2026-06-09 (Journal #44 consolidation). Purpose: trace one quote → fill → P&L all the way from the tick that triggers it to the desk NAV row it lands in, name **every** model and where its numbers are written/logged, and flag the conflicts / stale paths so we can converge on **one tight system**. Cites `file:line` so it stays verifiable.

## 0. The one-line model

A **book** quotes a two-sided market on one instrument, gets **passively filled**, and books the fill into a single **avg-cost ledger**. The book's P&L is `realised − fees + unrealised(mark-to-mid) + funding`. N books roll up into a **desk**; a **perp hedge leg** neutralises the desk's residual delta and its P&L folds into the desk total. Everything that happens emits a **DeskEvent** (live tape) and is periodically snapshotted to **`mm_nav`** (durable) and **`/metrics`** (Prometheus).

```
            ┌── quote ──┐      ┌── fill ──┐      ┌── book P&L ──┐    ┌── desk ──┐
  feed/L2 → │ IQuoter + │  →   │ fill     │  →   │ InventoryBook│ →  │ trader   │ → mm_nav
   tick     │ governor  │      │ engine   │      │ + attribution│    │ + hedge  │   tape
            │ + risk gate│     │ (2 paths)│      │ (MmBook)     │    │ (desk)   │   /metrics
            └───────────┘      └──────────┘      └──────────────┘    └──────────┘
```

## 1. Two entry cadences (and the coexistence rule)

> **Update (Journal #44 — fast-only shipped):** the fast L2 path is now the **default and only LIVE
> path** — a live book on a non-L2 venue is **refused at launch** (`market-making.module.ts`), and
> funding now accrues on the fast path. The bar path below survives **only** as the offline/unit-test
> simulator. The two-path description is retained because the *code* still has both (test vs live).

A book is driven by **exactly one** of two clocks — never both (`mm-book.ts:191-192, 398`):

| | **Fast L2 path** (the earner) | **Bar path** (legacy / fallback) |
|---|---|---|
| Trigger | `L2PollDriver` polls the venue's real L2 book every `MM_FAST_REQUOTE_MS` (100ms) → `MmPortfolioTrader.routeL2Snapshot()` → `MmBook.onL2Snapshot()` (`mm-book.ts:362`) | `setInterval(tick, pollIntervalMs)` (15s) → `MmPortfolioTrader.tick()` → `MmBook.tick()` (`mm-book.ts:397`) |
| Fills | **queue-aware FIFO** against the real L2 tape + WS aggressor flow (`L2LiveFillEngine`) | **simulated** against the candle's high/low range (`passiveFills`, `mm-book.ts:503`) |
| Requires | an L2 book source (today: **Hyperliquid** only) | any bar feed (Binance/mock/DEX) |
| Selected by | book is in `MM_FAST_SYMBOLS` AND has a `fastEngine` (`isFastPath()`, `mm-book.ts:350`) | no `fastEngine` |
| Honesty | real — queue position resolves whether we'd actually fill | **fiction at the top of book** — candle volume can't resolve top-of-book turnover (Journal S33/#23) |

**Coexistence is clean, not conflicting:** `MmPortfolioTrader.tick()` filters out fast-path books (`mm-portfolio-trader.ts:316`), and a fast-path `MmBook.tick()` returns immediately (`mm-book.ts:398`). So a book is filled by one path only — **no double-counting**. But see §8 Q1: keeping both is the scope-creep the desk is trying to shed.

## 2. Stage 1 — Quoting

Per requote (either cadence), `MmBook` builds a two-sided quote:

1. **Fair-value center (F1).** The quote is centred on the **micro-price** off the top N L2 levels (`referenceMicros`, `MM_MICROPRICE_DEPTH=5`), not the stale mid — this is the single biggest adverse-selection cut (Journal #27-#33). Falls back to bar mid when no L2 source.
2. **The quoter model** (`IQuoter`, one per book, from `mmStrategyRegistry`):
   - `mm-symmetric` — fixed half-spread (baseline).
   - `mm-avellaneda-stoikov` — reservation price shifts with inventory; spread from γ/κ/σ.
   - `mm-glft` (**desk default**) — Guéant-Lehalle-Fernandez-Tapia closed-form; σ-scale-invariant since S31. `glft-quoter.ts`.
   - `mm-directional-glft` — GLFT that rests at a target inventory `q*` (the "axed" maker; parked pending an OOS bias).
3. **The inventory governor** (Journal #39/#41/#43, now default-ON — `app-config.factory.ts`):
   - `inventorySkewMult` (=4) scales the A-S reservation skew so it actively mean-reverts toward flat.
   - `maxInventoryNotionalFrac` (=0.25) caps |inventory| at ¼ of book capital **at the live mid** — risk-uniform across the 100×-price universe.
   - `hardInventoryCap` parks the accumulating side at the rail so the book physically cannot breach the cap.
4. **F3 adverse-selection defence** (`FlowToxicityScaler`, `MM_F3_TOXICITY`) — widens the half-spread into one-sided/toxic sweeps, tightens into calm flow. Width-only, inventory-neutral. *Off by default* (§8 Q3).
5. **The risk gate** (`CompositeRiskGate`, `mm-book.ts:489`) — VPIN toxicity → Allow / Pause / Deny. A non-Allow verdict blocks the quote (`blockedQuotes++`) and emits a **verdict** DeskEvent on transition.

## 3. Stage 2 — Fills

- **Fast path:** `L2LiveFillEngine` holds our resting order's **queue position** and fills it FIFO as the real tape trades through the level; it writes fills **directly into the book's shared `InventoryBook`** (`mm-book.ts:191`). `onL2Snapshot()` then reads the engine's fill counters and emits **one `fill` DeskEvent per new fill** (`emitFastFill`, `mm-book.ts:379`).
- **Bar path:** `passiveFills(bar, bid, ask)` returns which side(s) the candle's range crossed; `applyOne()` (`mm-book.ts:506`) books each fill.

Both paths converge on the **same ledger** — there is exactly one `InventoryBook` per book (`src/market-making/inventory/inventory-book.ts`).

## 4. Stage 3 — Per-fill & per-bar calculations

On each fill (`applyOne`, `mm-book.ts:506-537`):
- **Fee** = `notional × makerFeeBps` (HL maker rebate −0.2bps ⇒ a credit). `feeFor()`.
- **`InventoryBook.apply({side,size,price,fee})`** — avg-cost accounting: extends inventory at a new weighted avg cost, or on a reducing/closing fill books **realised** `(price − avgCost)·size` and accumulates **fees**.
- **`attributeFill()`** — splits the fill into **spread captured** (edge vs the mid at fill time) and queues **adverse selection** as a one-bar/forward mark-out (`pendingMarkout`, resolved next mid). Diagnostic only — see §5.
- **Multi-horizon markout curve** (`markout.onFill`, 1s/5s/30s) — the adverse-selection-vs-horizon diagnostic.
- **VPIN** — the fill's classified aggressor volume updates the toxicity estimate (fast path uses real WS prints; bar path uses BVC estimate).
- A **`fill` DeskEvent** is emitted (side, action open/add/reduce/close/flip, inventory after, realised booked, fee).

Per bar (bar path) / per snapshot (`mm-book.ts:407-424`):
- **Funding accrual** — `−(signed inv notional)·rate·Δt` (long pays a positive rate; a short earns). The live HL rate, refreshed by `FundingRefreshCron`.
- **Inventory carry** — MTM drift on inventory held across the bar: `carried·(mid − prevMid)`. **Diagnostic attribution only — it is already inside realised/unrealised and is NOT re-added to net** (`mm-book.ts:211-212`). This is the #43 fix.

## 5. The roll-up: fill → position → book → desk → hedge

| Level | Object | Carries | Net formula |
|---|---|---|---|
| **fill** | — | side, size, price, fee | — |
| **position** | `InventoryBook` | inventoryUnits, avgCostMicros, **realisedUnits**, **feesUnits** | realised booked on exits |
| **book** | `MmBook.snapshot()` | the ledger + spreadCaptured / adverse / inventoryCarry / vol / vpin / markout | **net = realised − fees + unrealised(MTM at mid) + funding** (`mm-book.ts:600` = `InventoryBook.totalPnlUnits(mid) + funding`; `inventory-book.ts:17`) |
| **desk** | `MmPortfolioTrader.snapshot()` | Σ over books of equity/realised/unreal/fees/funding/net | desk totals **+ hedge P&L folded in** (DR-2, `mm-portfolio-trader.ts:419-431`) |
| **hedge** | `DeskHedgeController` | per-underlying perp position, mtm + funding − cost | **`hedgePnlUnits`** folded into desk net/unrealised/equity as an OPEN position |

**Key reconciliation (the #43 rule):** the desk/book **net** is the four cash terms above. `spread / adverse / inventoryCarry` are a **separate mark-out attribution** that does NOT sum to net — the `/demo` card renders them dashed/dimmed as "diagnostic · ≠ net" (`mm-desk-view.ts`). The honest headline number is **realised** (Journal #44 DR-6); unrealised flatters the desk when open inventory is marked into a favourable move.

## 6. Where every number is tracked / logged

| Sink | What | Written by | Read at |
|---|---|---|---|
| **DeskEvent tape** | every fill / verdict-change / launch-remove-start-stop / **hedge rebalance** (DR-2) | the one place it happens (`MmBook` fills, `MmPortfolioTrader` lifecycle + hedge) | server log line + ring buffer → `GET /api/market-making/events` → `/demo` Activity feed |
| **`mm_nav`** (durable) | per-interval desk row (`book_key=''`) + per-book rows; equity/realised/unreal/fees/funding/inventory/maxDD; **now incl. hedge P&L** | `MmNavCron` from `trader.snapshot()` | `GET /api/market-making/nav`; the run-review skill |
| **`/metrics`** | Prometheus gauges (desk NAV, per-book funding, tick duration, feed polls…) | `MetricsCollector` from the same snapshot | `/metrics`, `TELEMETRY_ENABLED` |
| **`mm_book_state`** | restart-safe per-book state (inventory + P&L) | `serializeState()`/`restore()` each tick | rehydrate on boot |
| **`/demo` MM card** | the cash grid that sums to net + the diagnostic mark-out block | `mm-desk-view.ts` | the live UI |

## 7. Ghost-code / conflict audit (what I verified)

| Item | Status |
|---|---|
| Legacy `src/hedge/` (Lira-Bridge FX hedge) running a zombie cron | **REMOVED** this session (DR-1) — one hedge system now |
| Two **hedge** subsystems | resolved — only `src/market-making/hedge/` remains |
| Hedge `betaMap:{}` hard-coded degenerate default | **FIXED** (DR-3) — configurable + explicit + logged |
| Hedge P&L absent from desk NAV | **FIXED** (DR-2) — folded in + on the tape |
| Two **fill** paths (bar vs fast) | **clean coexistence** (no double-fill) but a convergence candidate — §8 Q1 |
| One `InventoryBook` per book, single source of truth | ✅ verified — both fill paths write the same ledger |
| `spread/adverse/inventoryCarry` double-counted into net | ✅ not double-counted (`mm-book.ts:211`) — diagnostic only |
| `MM_*` defaults that silently no-op a risk control | governor ON (#43); hedge default explicit (DR-3); `fastRequote`/`f3` still default-OFF — §8 Q3 |
| Orphan `hedge_positions` table + stale fixtures | dormant (no reader after DR-1) — stale-repo backlog |

## 8. Open questions — for discussion (and how top desks do it)

> Real top-tier MM desks run **one** quote→fill→hedge pipeline: quote off a micro-price/fair-value, re-quote in microseconds with cancel/replace, manage inventory with an A-S reservation price + a hard limit, **net the residual delta and hedge it on the most liquid leg past a band**, widen/pull on toxic flow, and attribute P&L into spread / adverse / inventory / hedge / fees. Meridian has all these pieces — the open work is *converging onto the single honest path* and proving the edge.

- **Q1 — Converge to ONE fill path (fast/L2 only)? ✅ DONE (Journal #44).** Shipped: fast/L2 is the default and only LIVE path; a non-L2 launch is refused; funding was ported onto the fast path; the bar path is now the offline/unit-test simulator only. Product consequence accepted: **no live MM on a venue without an L2 tape** (so the DEX/GeckoTerminal frontier is paused for live MM until it has one).
- **Q2 — Hedge target + cadence (DR-3 done / DR-4 open).** The β-map mechanism now exists but defaults to per-symbol self-hedge; top desks hedge the **aggregate basket β on one liquid leg** (alts→BTC/ETH) past a band, not each micro-fill. Needs an **OOS β fit** before the map is trusted (a wrong β over-hedges noise). And the hedge still runs on the **slow bar timer** while books fill at 100ms (DR-4) — it should move to the fast path so it tracks the inventory it's chasing. **→ OOS β fit, then DR-4.**
- **Q3 — Pin the canonical demo config (DR-0 follow-up).** `fastRequote` and `f3Toxicity` are default-OFF; the demo only gets them via the launch script's copy-pasted env. That's how #43's governor silently ran off. The defaults should be the *honest demo values*, or the canonical config pinned in one place (not a bash comment). **→ pin it.**
- **Q4 — Persist the attribution + headline realised (DR-5/6).** spread/adverse/inventoryCarry die at shutdown (only on the live card). Persist them to `mm_nav` and make the scorecard lead with realised. **→ schema add.**
- **Q5 — The edge.** DD control now works (per-book maxDD ≤1.42%, Journal #44) but the desk is still net-negative: spread ≈ adverse, rebate net-negative. The path to positive is the **adverse-selection defence** (confirm F3 actually fires — still uninstrumented) and the **validated directional lean** (parked) — **not more coins**. Run A′ should require **desk realised ≥ 0**, not just bounded DD.
- **Stale-repo backlog (deferred, lower priority than recent work):** the `telemetry.module.spec` test-isolation flake (pre-existing, fails on 382641a too), the orphan `hedge_positions` table + fixtures, and a sweep for other dead `MM_*`/legacy paths.
