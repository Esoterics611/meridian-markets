# Equities Stat-Arb — Alpaca integration execution spec

> **STATUS (S24, 2026-06-01): Phase 1 SHIPPED.** Adapters built + offline-verified
> (118 suites / 792 tests): `src/stat-arb/feed/alpaca/` (`AlpacaDataClient` w/
> `adjustment=all` + pagination, `AlpacaBarFeed`, `AlpacaPriceSource`, `AlpacaPaperVenue`),
> `FEED_SOURCE=alpaca` config + factory wiring, 8 `EQUITY_PRESETS`, P0.4 short-borrow carry
> in `HistoricalReplayVenue`, and `cointegration-stability.ts STAB_SOURCE=alpaca`. **The
> live thesis test + paper-trade need an Alpaca paper key (hand-off)** → persistence verdict
> lands in QUANT_JOURNAL Entry #7. Phase 2 (OOS gate on Alpaca, scanner/UI routing) + Phase 3
> (course) are still open.

> Why: Entry #5 proved directional-crypto cointegration is a short-window artifact
> (the cliff). Equities have **real** structural cointegration (same-sector names
> share cash-flow drivers), so this is where the desk's OOS-validation wisdom
> actually pays. This doc is the paste-ready Phase-1 build. Adapters reuse the
> existing swap seams (§7 of CLAUDE.md) — one new feed + one new venue, everything
> else (signals, OOS gate, deflated Sharpe, sizing, scanner) is reused unchanged.

## Phase 0 — accounts (no code)
- **Alpaca** paper account → API key + secret. US person, no VPN. Same REST/WS API
  for paper and live → `EXECUTION_MODE=paper` is honest paper trading on real prices.
- **IBKR** paper (later) — for real **short-borrow / financing** (P0.4) and a wider
  universe. Alpaca first (lowest friction), IBKR when borrow cost matters.
- Secrets go through `ISecretProvider.get()` (`ALPACA_KEY_ID`, `ALPACA_SECRET`),
  read in `app-config.factory.ts` only — never `process.env` elsewhere (CLAUDE.md §6).

## Phase 1 — adapters (mirror the Binance pair)
Build alongside `src/stat-arb/feed/binance-public-client.ts`:

- `AlpacaDataClient` — `GET https://data.alpaca.markets/v2/stocks/{sym}/bars`
  (`timeframe=15Min`, `start`/`end`, `adjustment=all` ← **split/dividend adjusted,
  non-negotiable**), paginated via `next_page_token`. Inject `HttpGet` like the
  Binance client so unit tests run offline. Returns `Bar[]` (same shape).
- `AlpacaBarFeed implements IBarFeed` / `AlpacaPriceSource implements IPriceSource`.
- `AlpacaPaperVenue implements ITradingVenue` — submit/cancel orders against the
  Alpaca **paper** trading API (`https://paper-api.alpaca.markets`), real fills.
- Register in the feed/venue factory selected by `FEED_SOURCE=alpaca` +
  `EXECUTION_MODE=paper`. Leave Binance the default.
- **Market hours**: equities are not 24/7 — skip non-session bars, handle the
  open/close auction and halts. `alignMany()` already drops non-common timestamps,
  so a session-bounded feed aligns cleanly.
- **Short-borrow cost (P0.4)**: add a per-bar carry on the short leg in
  `HistoricalReplayVenue` (a `borrowBpsPerYear` param; IBKR exposes real rates,
  Alpaca a flag for hard-to-borrow). Equities stat-arb lives or dies on this.

## Phase 1 — equity baskets (the wisdom: same-sector, fundamentally linked)
Add to `market-presets.ts` (quote is implicit USD; the symbol is the ticker). These
are chosen for **genuine cointegration** (shared sector cash-flow drivers), the thing
crypto lacked:

- `equity-banks`: JPM, BAC, WFC, C, USB, PNC, TFC, GS, MS
- `equity-energy`: XOM, CVX, COP, EOG, SLB, PSX, VLO, MPC
- `equity-rails`: UNP, CSX, NSC, CP, CNI  *(near-duopoly — classic pairs)*
- `equity-megacap-tech`: AAPL, MSFT, GOOGL, AMZN, META, NVDA
- `equity-payments`: V, MA, AXP, PYPL, FIS, GPN
- `equity-staples`: KO, PEP, PG, CL, MDLZ, KMB  *(KO/PEP is the textbook pair)*
- `equity-pharma`: PFE, MRK, BMY, ABBV, LLY, JNJ
- `equity-semis`: NVDA, AMD, INTC, AVGO, QCOM, TXN, MU

Run `cointegration-stability.ts` (STAB_PRESETS=equity-*) on these **first** — the
thesis test is whether these *hold* across 30/90/180d where crypto collapsed.

## Phase 2 — validate (reuse the gate unchanged)
1. `cointegration-stability.ts` on the baskets → keep classes that persist ≥2 horizons.
2. `oos-candidates.ts` (point its client at Alpaca) → walk-forward + deflated Sharpe,
   **net of fee + spread + impact + short-borrow**. n≥20 OOS trades, DSR ≥ 0.95.
3. Survivors → sizing study for N* (impact ∝ N²; equities ADV is large → N* is big).
4. Forward paper-trade the gated basket on Alpaca 4–8 weeks; reconcile realized fills
   vs backtest weekly. Tracking error within threshold ⇒ "real."

## Phase 3 — course update (`courses/stat-arb`)
- New chapter "Stat-arb in equities" — why same-sector cointegration is structural
  (shared earnings drivers) vs crypto's spurious beta-to-BTC correlation; KO/PEP and
  the rails duopoly as worked examples.
- Add the **cointegration cliff** (Entry #5) as the cautionary tale: short-window
  cointegration is an artifact; show the 30→180d collapse table and the persistence filter.
- Extend the "testing in Meridian" chapter with the Alpaca paper-trading walkthrough
  + short-borrow cost.

## Reuse map (what does NOT change)
Signals (`strategy-registry`), the OOS gate (`walk-forward` + `deflated-sharpe` +
`purged-kfold`), sizing study, scanner, risk gates, the live loop, the `/demo` UI —
all asset-agnostic. Only the **feed** and **venue** are new. That is the whole point
of the swap-seam architecture (CLAUDE.md §7).

## First next-session task — ✅ DONE (S24), thesis run pending
The adapters, the 8 equity presets, the borrow-cost leg, and the source switch on
`cointegration-stability.ts` are built + green offline. **What remains is the live run**
(needs an Alpaca paper key — `ALPACA_KEY_ID`/`ALPACA_SECRET`):

```bash
STAB_SOURCE=alpaca STAB_INTERVAL=15m STAB_HORIZONS=30,90,180 \
  STAB_PRESETS=equity-banks,equity-megacap-tech \
  npx ts-node -r tsconfig-paths/register scripts/cointegration-stability.ts
```

If the baskets hold cointegration across ≥2 horizons → the equities thesis is confirmed and
the desk has its first structurally-cointegrated directional universe. Record the
persistence table in QUANT_JOURNAL Entry #7, then run the OOS gate (Phase 2).
