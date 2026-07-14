# Alpha Mandate Review — where the next 20 hours go

> **Session:** 2026-07-13, responding to [FABLE_ALPHA_MANDATE.md](FABLE_ALPHA_MANDATE.md) §12.
> Analysis only — no code shipped this session. Companion to
> [PROFIT_PIVOT_II.md](PROFIT_PIVOT_II.md) (still the active plan; this document amends its
> priorities, it does not replace it).

## 0. Verdict up front

**The current plan is right and under-run — with one genuinely new addition.** The desk's
documented failure mode (correct research verdicts followed by more building instead of more
accrual — PROFIT_PIVOT_II §1, rule R-A) is *currently live*: as of the last ledger entry
(2026-07-05, Journal #95) the carry desk — the only proven-positive book — has been awaiting
operator relaunch for over a week, and the VRP edge — the largest validated, quantified,
unexploited edge in the repo — still has **zero minutes of live book time** after being measured
in Journal #12 and distribution-validated in #42.

So the next 20 hours are **not** a new strategy hunt. They are: (1) turn the proven things on,
(2) finish the one small open build item (P1-4 allocator), (3) launch the VRP book that has been
"next" for a month, and (4) open exactly one new frontier — a **measurement-only prediction-market
module** — because this session verified the fact that makes it cheap: **HIP-4 event markets are
live on Hyperliquid mainnet** (launched 2026-05-02; daily BTC binaries first, validator-published
Fed/CPI/sports markets by May 25; zero fee to open, fees on close/settle). The desk can price BTC
binaries off its own Deribit-fitted surface with code it already owns. No other new build clears
the bar this session.

## 1. What was verified vs. taken on trust

**Verified against the repo this session:**
- Ledger state (PROFIT_PIVOT_II §4, last updated 2026-07-05): carry desk built + supervised
  launcher shipped, 7 books open +$48.54 at last checkpoint, **awaiting operator relaunch**;
  P1 item 4 (E7 allocator + beta-hedge) is the open build item; differential board at day 2/7.
- Files exist as claimed: full carry stack (`src/market-making/carry/`), `maker-execution.ts`,
  `funding-differential.ts` + board script, `regime-cross-sectional.ts`,
  `src/derivatives/deribit/deribit-client.ts` + `greeks/black-scholes.ts` (**no VRP book class**
  — confirmed pure opportunity), `scripts/launch-carry-30d.sh`, `scripts/launch-regime-track.sh`.

**Verified against the outside world this session:**
- **HIP-4 is real and live** — mainnet 2026-05-02, announced 2026-02-02. Binary/multi-outcome
  contracts settling to 0/1, fully collateralized (no liquidation), same margin account as perps,
  free to open / fee on close-settle. Expanded from BTC price binaries to validator-published
  real-world event markets ~May 25; reportedly ~20% of BTC-prediction 24h volume within a month.
  Sources: [Crypto Briefing](https://cryptobriefing.com/hyperliquid-hip-4-outcome-markets/),
  [INCRYPTED](https://incrypted.com/en/how-prediction-markets-work-hyperliquid/),
  [news.bitcoin.com](https://news.bitcoin.com/hyperliquid-launches-hip-4-and-targets-polymarket-with-zero-fee-outcome-markets/),
  [Galaxy via WEEX](https://www.weex.com/news/detail/galaxy-deep-research-report-how-hyperliquids-hip-4-upgrade-changes-the-landscape-of-prediction-markets-nxnsl75eanr99yoglh68dpye).

**Still unverified (flagged, not load-bearing for the ranking):**
- The IMDEA "$40M+ arbitrage extracted from Polymarket" citation (mandate §6). The qualitative
  claim (persistent cross-venue probability spreads from segmented user bases) is what the
  measurement phase tests empirically anyway; the headline number changes nothing until then.
- **Whether anything is live right now.** The sandbox has no running process and no Postgres —
  operator must confirm (§4, "Operator asks").

## 2. The ranked plan (amends PROFIT_PIVOT_II §2; same honesty rules)

| # | Move | Driver | Measured vs unknown | Honest expectation | Bounding risk | Hours |
|---|---|---|---|---|---|---|
| A1 | **Relaunch carry + finish P1-4 allocator/beta-hedge** (M1) | persistent one-sided funding, delta-neutral | proven-positive live (+$18.13/85min #72; +$48.54 open at #92); 13→12 gated symbols; allocator is the only unbuilt piece | 6–12%/yr on carry capital, DD < 1% | funding regime flips; crowding | ~1 op + 4 build |
| A2 | **Launch the VRP book** (M3 / E6, P2 as written) | sellers paid for gap risk | +5.9/+3.7 vol pts (#12); short-vol won 86.3% of 117 rolling 24h windows (#42); **zero live minutes** | high-single-digit %/yr on its sleeve, **fat left tail** | the 13.7% of windows; sizing + stress gate are everything | ~8 |
| A3 | **Prediction-market measurement module** (NEW — mandate objective 2) | segmented crowds price the same event differently; HIP-4 now on home venue | HIP-4 verified live (this doc §1); Deribit surface + HL client already owned; **gap sizes/depth/executability wholly unmeasured** | unknown; capacity small by design ($1–5k/trade); measurement decides | resolution/wording risk; capital-lock annualization trap; sub-fee gaps | ~5–6 |
| A4 | **HIP-3 24/7 weekend capture** (W9 prep — data, not a strategy) | tokenized gold/oil/index trade while CME sleeps | claim structural, sample unmeasured | none yet — feeds a *future* trend decision | per-deployer liquidity; gap-inclusive vol | ~2 |
| A5 | (optional) W17 cross-sectional momentum, **offline OOS score only** | breadth momentum ≠ killed pair stat-arb | partial signal exists (`regime-cross-sectional.ts`), never scored standalone | unknown | R-C blocks any book until the regime benchmark reads out | spare hours only |

**Explicitly not pursued** (mandate §8 + desk rules): any new directional book (R-C — the regime
benchmark track must produce its pre-registered honest read first; `launch-regime-track.sh` exists,
launching it is an operator action, not a build), more risk infrastructure around unrun books
(R-B), stat-arb, real-capital wiring, M4/M5 (stay parked behind their existing gates).

## 3. The prediction-market scope (A3) — measurement-first, pre-registered

Same pattern as M2 (7 boards before any differential leg): **no order placement in phase 1.**

- **Cleanest first pair — HIP-4 BTC daily binaries vs Deribit-implied digitals.** Same underlying,
  no wording-dispute risk, both clients already exist. The desk's fitted vol surface prices any
  digital; the gap between model price and HIP-4 crowd price is the first series to collect.
- **Then cross-venue:** public read-only collectors for Polymarket (CLOB/gamma API) and Kalshi
  (public API), normalized to `{event, expiry, venue, implied prob, depth, fee-adjusted executable
  prob}`, plus a gap ledger that prints **annualized locked-capital return** — never raw spread.
  The trap worked out: $200 edge on $2,000 locked 90 days = **4.1%/yr**, not "10%". Every ledger
  row carries this number.
- **The LIT lesson transfers:** event-matching (wording, expiry, resolution source) is this
  domain's ticker collision. The matcher ships with a same-event sanity guard from day 1 —
  mismatched resolution criteria are refused, not traded (see
  [TICKER_COLLISION_POSTMORTEM.md](TICKER_COLLISION_POSTMORTEM.md)).
- **Pre-registered success metric (decided now, before building):** over **14 consecutive daily
  boards**, at least **5 same-event pairs** show a fee-adjusted, depth-executable gap with
  annualized locked-capital return **≥ 15%/yr**. If not met, the honest answer is "the gaps aren't
  there at our executable size" — publish that in the journal and drop it. HIP-4 market-making
  (sub-strategy 3) is not considered until this measurement phase reads out.

## 4. Why this beats "just finish the carry allocator"

Finishing P1-4 alone leaves the largest measured edge in the repo (VRP) at zero live minutes for
yet another week — exactly the R-A defect the desk already diagnosed in itself. The 20 hours above
finish the current plan **and** turn on its next phase (P2 was already scheduled — it's late, not
new) **and** open the mission's stated frontier (new/decentralized market discovery) at
measurement-only cost with a kill criterion attached. Nothing here is a new strategy bet; the only
new spend (A3) buys information, not exposure.

**Operator asks (blocking, in order):**
1. Confirm what's actually live: is the carry desk running? (`bash scripts/launch-carry-30d.sh status`)
2. If not: `bash scripts/launch-carry-30d.sh` — resume-not-flatten picks up the 7 open books.
3. `bash scripts/launch-regime-track.sh` — starts the benchmark clock that unblocks R-C.
4. Daily: `funding-differential-board.ts` (M2 boards) + carry scan refresh at re-gate.

**Build order for the next coding session:** A1 allocator (finishes P1) → A2 VRP book v0 (P2 as
pre-registered) → A3 collectors + gap ledger → A4 capture cron. Each lands with specs, tsc/jest
green, per CLAUDE.md §10.1.
