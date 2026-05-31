# Research Tab Realignment — Plan

Status: **IMPLEMENTED** (Phases 0–3, 2026-06-01). UI: `src/stat-arb/demo/public/index.html`. 110 suites / 709 tests green; `tsc --noEmit` clean. Verify in-app per the "How to test" section at the bottom.

> Implementation summary
> - **P0** — FLATTEN ALL wired; per-station ✕ remove on stat-arb cards; Trade-top-N now appends (no silent wipe).
> - **P1** — Research is now the scan→asset-classes→trade flow: "⊹ Scan all source data", results grouped **by asset class** + cross-class rollup, Scanner tab folded in, single-book path retired (every "trade" launches a station), robustness tools (walk-forward/sweep/Monte-Carlo) surfaced with a synthetic-feed caveat.
> - **P2** — FX (EUR stables) stat-arb preset added; unified scan covers crypto + stablecoin + FX on both boards.
> - **P3** — TESSERA reference sources implemented (Pyth FX OHLC, DefiLlama peg, Bit2C ILS) behind one interface, injected HTTP, mock-default-safe; Pyth FX wired into the scanner as a new asset class; `GET /api/market-data/reference[/sources]` + a "data sources wired" UI readout.
> - **P3+** — reference-source pairs are now **tradeable on the same live loop** (not scan-only): `ReferenceBarFeed`/`ReferencePriceSource`/`warmupFromReference` give each book a per-source feed selected by `PortfolioPair.source`; `/portfolio/launch` + the scan "▶ trade" button thread `source`; each Live-books card shows its `feedId` (`binance.spot` / `ref.pyth`). **Remaining follow-up:** cross-source pairing (per-symbol source + timestamp resampling) for the USD/ILS (Pyth) × USDC/NIS (Bit2C) basis. Note: at 5 bps taker most FX pairs read **sub-fee** (correct fee discipline) — they surface in the scan but only clearing pairs get a trade button.

## 0. The target user flow (what we actually want)

> "Scan the source data → show **all the asset classes that fit the model** → trade from there." Buttons must be consistent. Surface the new asset classes + other data sources from the previous plan.

One coherent loop: **Scan (wide) → Rank/group by asset class → Trade (one click) → Monitor**. Today that loop is fractured across three tabs with three different "trade" backends, one dead button, and asset classes that exist on the backend but never reach this flow.

---

## 1. What's there today (verified)

**Tabs** (`index.html:161‑168`): Desk · Launch · Market Making · Scanner · Signal · Research.

**The "Research" tab is three legacy panels, none of which scan:**
- `index.html:219‑226` — **Live position** (span‑4): single‑book snapshot + in‑memory fills. Reads `/api/stat-arb/live/snapshot`.
- `index.html:313‑328` — **Discovered pairs** (span‑6): pair discovery for **one** preset, only after a manual **⤓ Backfill** click. Reads `/api/market-data/universe?presetId=…`.
- `index.html:330‑334` — **Backtest on real history** (span‑6).

So "Research" = single‑book monitor + single‑preset discovery + backtest. It does **not** scan source data, and it does **not** show "all asset classes that fit the model." That capability lives in a *different* tab (**Scanner**, `index.html:297‑311`), and the two are disconnected.

**There are THREE different "trade" backends behind buttons that all say "trade"/"launch":**

| UI button | JS fn | Endpoint | Semantics | Result lands on |
|---|---|---|---|---|
| Research → Discovered pairs → `trade` | `tradeLive` (`869`) | `POST /live/configure` + `/start` | **legacy single book** | Research → Live position |
| Research → `▶ Trade top N` | `tradeAll` (`895`) | `POST /live/portfolio` | **REPLACES whole portfolio** | Desk → Live books |
| Scanner → `▶ trade` | `launchOpp` (`644`) | `POST /live/portfolio/launch` | **appends a station** | Desk → Live books |
| Signal → `▶ Trade it` | `tradeFromSignal` (`784`) | `POST /live/portfolio/launch` | appends a station | Desk → Live books |
| Launch → `▶ Launch station` | `launchStation` (`495`) | `POST /live/portfolio/launch` | appends a station | Desk → Live books |

Confirmed in `src/execution/live.controller.ts`: `POST /portfolio` (`199`) calls `setPairs` = **replace**; `POST /portfolio/launch` (`227`) calls `addBook` = **append**. So **"Trade top N" silently wipes any stations you launched** from Scanner/Signal/Launch. And the row‑level "trade" in Research arms a *different book type* (single) shown on a *different tab* than every other trade button.

**Dead button:** `#flatten-all` (⚑ FLATTEN ALL, `index.html:174`) has **no `onclick` handler** (handlers are `index.html:1054‑1081`; only `kill-all` is wired). It does nothing — even though `POST /live/flatten` and `POST /live/portfolio/flatten` both exist (`live.controller.ts:159, 166`).

**Backend done, never wired into the UI:**
- `POST /live/flatten`, `POST /live/portfolio/flatten` — flatten open positions (US‑41). UI never calls them.
- `POST /live/portfolio/remove` (`live.controller.ts:172`) — stop+drop one station. UI never calls it. So **stat‑arb Live‑books cards have no per‑station remove** (only a `▸` focus button, `index.html:945`), while **MM book cards DO have a `✕` remove** (`index.html:594` → `/market-making/remove`). Inconsistent.
- `/api/stat-arb/research/*` — walk‑forward, parameter‑sweep, Monte‑Carlo (`research.controller.ts`) exist but run on a **synthetic feed** and are **not** surfaced in `/demo` (US‑46).

**Asset classes that exist but never reach this flow:**
- The opportunity scanner sweeps only the **8 crypto** stat‑arb presets (`stat-arb.module.ts:250` → `MARKET_PRESETS`).
- The MM screener uses **MM presets**, which already include **Stablecoin** and **FX (EUR via stables)** classes (`mm-market-presets.ts`) — but those only appear in the MM tab, never in the unified scan.
- `MARKET_PRESETS` has a `stablecoin-peg` stat‑arb preset too, but the Research/Scanner flow treats it as just another crypto row.

**New data sources from the previous plan — genuinely NOT built (backend‑first work):**
- Grep of `src/` for `OANDA / Pyth / DefiLlama / Bit2C / ILS-market` → **none**. Only feeds are `binance.spot` and `mock` (`feedId`/`ingestId` audit). ILS appears only as a Lira‑Bridge hedge/config constant, not a market‑data source.
- So the TESSERA reference‑data adapters (OANDA/Pyth FX `EUR/USD`,`USD/ILS`; DefiLlama peg; Bit2C `USDC/NIS`) and the FX/ILS basis universe are **unbuilt**. This is real backend work, not UI wiring. (`EUR/EURI` in the MM FX preset is the one exception — it resolves to Binance markets, no new adapter.)

---

## 2. Findings → severity

| # | Finding | Type | Sev |
|---|---|---|---|
| F1 | No scan→asset‑classes→trade loop in Research; scan lives in a disconnected tab | flow gap | High |
| F2 | "trade" means 3 different backends; row‑trade arms a different book type than everywhere else | inconsistency | High |
| F3 | "Trade top N" REPLACES the portfolio → silently wipes launched stations | footgun | High |
| F4 | `#flatten-all` is a dead button (no handler) though backend flatten exists | dead button | High |
| F5 | No per‑station remove/flatten on stat‑arb cards, but MM cards have it | inconsistency | Med |
| F6 | Stablecoin/FX asset classes exist (MM presets) but never appear in the unified scan | siloed feature | Med |
| F7 | `/research/*` (walk‑forward/sweep/MC) endpoints exist, unsurfaced + synthetic‑only | unsurfaced | Med |
| F8 | "Research" tab is misnamed: it's a single‑book monitor, not research | IA | Med |
| F9 | TESSERA alt‑data sources (OANDA/Pyth/DefiLlama/Bit2C, ILS) not implemented | backend gap | (scope) |

---

## 3. Plan (phased; each phase shippable on its own)

### Phase 0 — Make the buttons honest & consistent (UI‑only; backend already done)
0.1 Wire `#flatten-all` → `POST /live/flatten` + `/live/portfolio/flatten` (+ `/market-making/flatten`), then refresh. (F4)
0.2 Add a `✕` per‑station control to stat‑arb Live‑books cards → `POST /live/portfolio/remove {pair}`, mirroring MM's `removeMm`. (F5)
0.3 Fix "Trade top N" replace‑footgun: switch it to **append** (`/portfolio/launch` per pair) OR relabel to "Replace portfolio with top N" + confirm. Recommend: append, to match every other launch. (F3)
0.4 Unify the trade verb: Research "Discovered pairs → trade" should **launch a station** (`/portfolio/launch`), not arm the legacy single book — identical to Scanner/Signal/Launch. (F2)

### Phase 1 — Rebuild Research as the scan→classes→trade flow (UI‑only; backend done) — [D1, D2, D4 LOCKED]
1.1 Add a prominent **"⊹ Scan all source data"** action at the top of Research that calls `/api/opportunities` (all presets) + `/api/market-making/screen` (all presets) in parallel — the same calls the Scanner tab already makes (`scanRun`, `index.html:619`).
1.2 Render results **grouped by asset class** (the literal ask: "show all the asset classes that fit the model"): one collapsible group per `assetClass`, header showing #pairs clearing the fee gate + best net‑edge/day; expand to the ranked pairs. Today the scanner returns flat rows with an `assetClass` column — add the roll‑up.
1.3 Each row's **trade** button → `/portfolio/launch` (append) and **backtest** → existing `/market-data/backtest`; consistent with Phase 0.4.
1.4 **[D2] Retire the legacy single‑book path.** Remove the "Live position" panel + `tradeLive`/`/configure`+`/start` wiring; every "trade" launches a station (`/portfolio/launch`). Keep single‑preset "Discovered pairs" only as a class drill‑down. (F8) Note: leave the single‑book *backend* endpoints in place (other consumers/mq) — this is a UI retirement.
1.5 **[D1] Fold the standalone Scanner tab into Research.** Remove the `scan` tab button; Research becomes the home of the scan board. Reuse `renderOpp`/`renderMmScreen`/`launchOpp`/`quoteMm` (`index.html:631‑664`) inside the grouped view.
1.6 **[D4] Surface the research tools now.** Add a "validate before you trade" sub‑panel calling `/api/stat-arb/research/walk-forward`, `/sweep`, `/monte-carlo` (`research.controller.ts`). **Carry a clear "synthetic feed" caveat** in the UI — these run on the synthetic generator today, not the scanned real history (`research.controller.ts:13‑15`). Stretch: plumb `ReplayEngine` so they read real bars (then drop the caveat) — only if cheap; otherwise label and ship.

### Phase 2 — Surface the asset classes that already exist but are siloed (small backend + UI)
2.1 Unify the scan so a single sweep shows **crypto + stablecoin + FX** classes for both stat‑arb (`/api/opportunities`) and MM (`/api/market-making/screen`). The stat‑arb scanner already includes `stablecoin-peg`; add the FX class where the model fits, and make MM's Stablecoin/FX classes appear in the same grouped view.
2.2 Cross‑link: a stablecoin/FX class row offers both "trade pair" (stat‑arb) and "quote it" (MM) where applicable.

### Phase 3 — New external data sources (BACKEND‑FIRST) — [D3 LOCKED: in scope this round] — F9
The genuinely‑unbuilt part: bring non‑Binance source data in so the scan covers FX and the ILS basis. **Backend first, UI last.** Follow CLAUDE.md §6/§7: modular monolith, one DB, every adapter behind an interface with a real+mock impl selected by config, `process.env` only in `app-config.factory.ts`, secrets via `ISecretProvider`.

3.1 **Bar‑shape decision (do this first).** Discovery + backtest consume `Bar[]` (OHLC at the feed interval). FX spot / peg / oracle sources are *rate series*, not klines. Define how a reference rate becomes a `Bar` (e.g. synthesize OHLC=close per interval, or add a `ReferenceSeries→Bar` shim). This choice gates every adapter below.
3.2 **Adapters (prefer no‑key public sources to match the Binance‑public ethos):**
  - **Pyth Hermes** (public HTTP, no key) → FX `EUR/USD`, `USD/ILS`. *Preferred over OANDA* (OANDA needs an account/key → `ISecretProvider` + dormant‑until‑secrets real adapter, mock default).
  - **DefiLlama stablecoins** (public) → peg deviation series for the stablecoin basis.
  - **Bit2C** (public ticker, no key) → `USDC/NIS` (or `BTC/NIS`) for the ILS basis vs the on‑chain/Binance leg.
  Each: `I…Feed` interface + real impl + mock impl, registered in the module factory with the **mock as the safe default**; a `*_SOURCE`/secret config flag flips to real. New `feedId`/`ingestId` per adapter.
3.3 **New presets / asset classes** consuming these: an **FX** class (`EUR/USD`, `USD/ILS`) and an **ILS‑basis** class (`USDC/NIS` vs USDC). Mirror the `MarketPreset` shape; add to `MARKET_PRESETS` and/or `MM_MARKET_PRESETS`.
3.4 **Storage:** rates fit the 6‑decimal micros convention (USD/ILS≈3.7, EUR/USD≈1.08). Confirm `market_bars` venue tagging distinguishes `pyth`/`bit2c`/`defillama` from `binance.spot`. No new migration if the existing schema is venue‑agnostic — verify.
3.5 **Wire into the Phase‑1 unified scan** exactly like Binance presets (scanner takes `ScannerPreset[]` + a `BarLoader` — inject a loader that dispatches per source).
3.6 **Tests:** adapter unit specs with fixture responses (`*.spec.ts`); scanner/discovery specs over the new presets; integration specs `*.int-spec.ts` guarded by `describeIfDb`. Keep the suite green.

### Cross‑cutting
- Tests: each new endpoint/UI behavior gets a spec; keep the suite green (101 suites / 673 tests today).
- Docs: update `UI_USER_STORIES.md` (US‑18/41/42/46 change status) + CLAUDE.md §8 session log.
- Discipline: verify via `tsc` + `jest` (dev server won't run in this sandbox); hand smoke steps to the user.
- Commit on `master` with `Co-Authored-By` trailer at end of the implementing session.

---

## 4. Sequencing for the fresh session (all four phases in scope — D3)
Ship in order; each phase is independently committable:
1. **Phase 0** — button consistency + dead buttons (fast; fixes the "try the buttons" complaints). UI‑only.
2. **Phase 1** — rebuild Research as scan→classes→trade, fold Scanner in, retire single‑book, surface research tools. UI‑only.
3. **Phase 2** — surface the existing stablecoin/FX classes in the unified scan. Small backend + UI.
4. **Phase 3** — new external data adapters (Pyth/DefiLlama/Bit2C + FX/ILS presets). **Backend‑first**, biggest lift; start with 3.1 (bar‑shape decision). Don't let it block 0‑2 landing.

Rationale: 0‑2 are pure realignment of already‑built backend (immediate user‑visible win); Phase 3 adds genuinely new source data and is the only part needing new backend + possibly secrets.

## 5. Decisions — LOCKED (2026‑05‑31)
- **D1 (IA):** ✅ Rework Research into the scan‑first flow; **fold the Scanner tab into Research**.
- **D2 (legacy single book):** ✅ **Retire** the single‑book "Live position" UI path; every "trade" launches a station. (Backend endpoints stay for `mq`/other consumers.)
- **D3 (scope):** ✅ **All phases 0‑3 this round**, including the TESSERA data‑source adapters.
- **D4 (research tools):** ✅ **Surface** `/research/*` (walk‑forward/sweep/MC) now, with an explicit "synthetic feed" caveat; real‑history plumbing is a stretch goal.
