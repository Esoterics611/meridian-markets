# Equities Stat-Arb — Alpaca integration execution spec

> **STATUS (S25, 2026-06-02): Phase 1 SHIPPED + Phase 2 plumbing WIRED (offline).**
> S24 built the adapters; S25 wired the two remaining offline seams so the whole
> equities path is one Alpaca key away from running:
> - **OOS gate → Alpaca** (`scripts/oos-candidates.ts`): `OOS_SOURCE=alpaca` routes
>   the real-history walk-forward + deflated-Sharpe gate to Alpaca + `EQUITY_PRESETS`,
>   with equity-aware cost defaults — **fee 0bps** (commission-free), **1bps half-spread**,
>   and **short-borrow carry ON** (50bps/yr easy-to-borrow default; `OOS_BORROW_BPS_YEAR`
>   for hard-to-borrow). Same gate, same verdict logic — only the source switched.
> - **Scanner → equities** (`opportunity-scanner` wiring): `EQUITY_PRESETS` join the
>   cross-asset scan board, **key-gated** (only when `ALPACA_KEY_ID` is set, so a no-key
>   deploy scans exactly as before). `makeScannerLoader` gained an `'alpaca'` branch.
>   *Caveat: the scanner is intraday-tuned — it's a coarse first look; the structural
>   verdict is `cointegration-stability.ts` + `oos-candidates.ts`.*
>
> Offline-verified: **120 suites / 803 tests**. The live loop (feed/price/venue/warmup)
> was already wired in S24. **What still needs an Alpaca paper key (hand-off):** the
> live thesis run + the OOS gate run + paper-trade → persistence verdict in QUANT_JOURNAL
> Entry #7. Phase 3 (course) is still open.
>
> Earlier — **Phase 1 (S24):** `src/stat-arb/feed/alpaca/` (`AlpacaDataClient` w/
> `adjustment=all` + pagination, `AlpacaBarFeed`, `AlpacaPriceSource`, `AlpacaPaperVenue`),
> `FEED_SOURCE=alpaca` config + factory wiring, 8 `EQUITY_PRESETS`, P0.4 short-borrow carry
> in `HistoricalReplayVenue`, and `cointegration-stability.ts STAB_SOURCE=alpaca`.

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

## Phase 2 — validate (reuse the gate unchanged) — ✅ WIRED (S25), needs key to run
1. `cointegration-stability.ts STAB_SOURCE=alpaca` on the baskets → keep classes that
   persist ≥2 horizons. *(wired S24)*
2. ✅ `oos-candidates.ts OOS_SOURCE=alpaca` → walk-forward + deflated Sharpe, **net of
   fee + spread + impact + short-borrow** (P0.4 carry on the short leg). n≥20 OOS trades,
   DSR ≥ 0.95. *(wired S25 — equity-aware cost defaults baked in.)*
3. Survivors → sizing study for N* (impact ∝ N²; equities ADV is large → N* is big).
4. Forward paper-trade the gated basket on Alpaca 4–8 weeks; reconcile realized fills
   vs backtest weekly. Tracking error within threshold ⇒ "real."

Also wired (S25): the cross-asset **scanner** picks up `EQUITY_PRESETS` whenever an
Alpaca key is present (key-gated, intraday-tuned coarse look — see status note).

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

## Hand-off — the live run (needs an Alpaca paper key)
Everything offline is built + green (120 suites / 803 tests). The only thing left is to
run the validation against real Alpaca data. Set the secrets first:

```bash
export ALPACA_KEY_ID=...        # Alpaca paper account key
export ALPACA_SECRET=...
```

**Step 1 — the thesis test** (do same-sector baskets HOLD cointegration where crypto's
collapsed?). Daily bars are the honest horizon for structural equity cointegration:

```bash
STAB_SOURCE=alpaca STAB_INTERVAL=1d STAB_HORIZONS=30,90,180 \
  STAB_PRESETS=equity-banks,equity-rails,equity-staples,equity-megacap-tech \
  npx ts-node -r tsconfig-paths/register scripts/cointegration-stability.ts
```

If baskets hold cointegration across ≥2 horizons → thesis confirmed; record the
persistence table in QUANT_JOURNAL Entry #7.

**Step 2 — the OOS gate** on a surviving class (net of fee + spread + impact + borrow):

```bash
OOS_SOURCE=alpaca OOS_PRESET=equity-banks OOS_DAYS=180 OOS_INTERVAL=1d \
  OOS_TRAIN=120 OOS_TEST=40 OOS_ENTRY=2.0,2.5 \
  npx ts-node -r tsconfig-paths/register scripts/oos-candidates.ts
```

PASS = DSR ≥ 0.95 with ≥ 20 OOS trades. (Daily bars × 180d ≈ 124 trading bars, so for
a real OOS trade count you'll likely want OOS_DAYS=365+ or 15m intraday bars — the gate
will tell you `INSUFFICIENT` if the trade count is too thin, exactly as it killed the
crypto candidate in Journal #4.)

**Step 3 —** survivors → sizing study (N*) → forward paper-trade on Alpaca (Phase 2.4).
