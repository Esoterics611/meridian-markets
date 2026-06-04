# Cross-Venue, Cross-Asset Quant Research — Findings

*Meridian Markets desk · a paper-trading demonstration of an AI-agent-run quant desk · findings compiled 2026-06-04*

> **Abstract.** This is a consolidated, citable record of the systematic-trading research run on the Meridian desk across **six strategy families** and **eight-plus data venues**, spanning crypto, equities, FX, perpetual-swap funding, options volatility, and decentralized (DEX/perp-CLOB) markets. The desk's governing constraint is **honesty about the numbers** — it is a demonstration, so an inflated backtest is worthless. Accordingly every result below is reported through a fixed validation discipline (out-of-sample, multiple-testing-deflated, survivorship-aware, cost-and-queue-realistic), and **negative and null results are reported with the same prominence as positive ones** — the negative results are, in several cases, the most useful findings. The headline: most "edges" that look real in a naive backtest are **artifacts of short windows, survivorship, fill-on-touch, or ignored costs**; the edges that survive are small, and the desk's value is in measuring them truthfully rather than overstating them.

---

## 1. Method — how the numbers are kept honest

Every candidate strategy passes the same gate before any claim is made. This is the contribution that makes the rest of the document trustworthy.

| Discipline | What it controls | Where |
|---|---|---|
| **Out-of-sample walk-forward** | look-ahead; parameters re-fit per train window (Engle-Granger β per window) | `walkForward`, `scripts/oos-candidates.ts` |
| **Deflated Sharpe / PSR** | multiple-testing: N trials inflate the best Sharpe; deflate by the cross-trial dispersion | `research/deflated-sharpe.ts` |
| **Purged k-fold (purge + embargo)** | leakage across adjacent folds in autocorrelated series | `research/purged-kfold.ts` |
| **Survivorship gate** | a backtest on *today's* survivors is biased; the bias grows with window length | `research/survivorship-gate.ts` |
| **Cost model** | half-spread + linear market impact (λ·notional/ADV) + short-borrow carry + funding | `HistoricalReplayVenue`, `venue-fees.ts` |
| **Queue-aware fills** | fill-on-touch is an upper bound; FIFO queue position against a real L2 tape is the truth | `LobReplayHarness` |

Two cross-cutting methodological findings, established early and used throughout:

- **Position size is a *risk* lever, not an alpha lever.** Under flat fees, net edge in bps and Sharpe are size-invariant; size only scales variance, capped by the impact-optimal N\* (which grows ∝ N²). "Trade bigger to make more" is false; "trade bigger to take more risk on a real edge, up to N\*" is the correct framing.
- **Costs decide thin edges, and modelling them flips rankings.** Adding realistic half-spread + impact to the backtest *reverses* the strategy leaderboard — thin-leg "winners" die, liquid alt-dispersion survives. Any ranking computed gross of cost is not just optimistic, it is *ordered wrong*.

---

## 2. Crypto statistical arbitrage — the cointegration cliff (decisive negative)

**Thesis tested:** can a mean-reverting spread between cointegrated crypto pairs be traded net of fees?

**Finding:** **No, structurally.** Crypto cointegration is a **short-window artifact**. Across the universe, the count of pairs that hold cointegration **collapses to ≈ 0 at 90–180-day windows** (`scripts/cointegration-stability.ts`). A candidate that looks tradeable in-sample (an "ai-data" basket z-score strategy) was run through the full OOS + deflated-Sharpe gate on 30 days of real history and **killed**: too few OOS trades after the multiple-testing haircut. The one structural exception is the **stablecoin peg** — a real, narrow, fee-bound spread.

**Why it matters:** this is the result that drove the desk's **pivot to market-making as the live earner** and to **equities as the uncorrelated diversifier**. A negative result with a clear mechanism (the cliff is a property of the asset class's regime instability, not of the method) is more valuable than another curve-fit survivor.

---

## 3. Equities statistical arbitrage — real edge, but ~0.06 Sharpe and survivorship-bound

**Thesis tested:** same-sector equities are *structurally* cointegrated (shared cash-flow drivers), unlike crypto — does the spread survive the gate?

**Findings, in sequence (each fixed a bias in the last):**

1. **The cliff does NOT happen in equities.** Cointegration counts stay roughly flat across 180/365/730-day windows where crypto went to zero — **thesis confirmed.** (`STAB_SOURCE=alpaca/yahoo`.)
2. **Single near-passing pairs do not certify.** Banks USB/PNC reached DSR 92%, 41 OOS trades, 100% positive windows, +$66.8k/5yr — but did not cleanly PASS, and Sharpe **halved** from a 5→6-year window (regime sensitivity). Selection on a cherry-picked pair inflates the read.
3. **The de-biased basket verdict: real but tiny.** An **edge-disjoint** basket (each ticker used once → near-independent pairs), ranked by cointegration not Sharpe (selection-unbiased), judged on PSR vs 0: a 5-sector / 15-pair / **507-trade** pool nets **+$118k/5yr at pooled Sharpe 0.06, PSR 90%**. This solves the trade-count floor and removes selection bias — and reveals the USB/PNC 0.65 Sharpe was mostly selection luck.
4. **β-weighted sizing is marginal here** (0.06 → 0.06): the disjoint same-sector pairs sit at β ≈ 1, so equal-dollar ≈ β-weighted — a clean *negative* result that rules out "the sizing was wrong."
5. **More history flips the gate to PASS — but it is survivorship inflation.** Free no-key Yahoo daily history (decades, split/div-adjusted) lifts the gate to PASS (10yr: Sharpe 0.09, PSR 99%; 24yr: 0.15, PSR 100%, +$1.16M, 1867 trades) — **but Sharpe rises monotonically with window length (0.06 → 0.09 → 0.15)**, the signature of survivorship bias: a long backtest on today's survivors omits the casualties.

**Verdict:** a **real but ~0.06-Sharpe** edge — under any deployable bar. The binding blocker is **survivorship** (a point-in-time universe needs paid delisted history; CRSP/Sharadar). The desk chose the **free, no-data path**: a survivorship gate that caps any statistically-strong read on a survivor-only window to `UPPER-BOUND`, never a promote. **The real equities verdict is forward paper-trading, not the long-window backtest.**

---

## 4. Perpetual-swap funding-rate carry — a real, modest, fee-bound carry

**Thesis tested:** harvest the funding a perp pays by holding delta-neutral (long spot / short perp).

**Findings:**

- **Funding on majors is a real positive carry**, persistently one-directional (longs pay shorts). Binance 8h funding annualises to **~3–4%/yr** on BTC/ETH; the same measurement on **Hyperliquid's hourly** funding (this session) reads **ETH ≈ 8.1%/yr, BTC ≈ 4.5%/yr**, funding positive in 75–88% of settlements.
- **The edge is the funding *stream* (continuous); the round-trip fee is a *one-time* cost.** So carry is a **hold-longer** trade: breakeven hold ≈ fee ÷ funding-rate, after which net → the carry yield. On HL's hourly cadence, breakevens are short (2–4 days on the majors).
- **It is fee-bound on short holds**, and a delta-neutral *capture* needs a spot venue (HL is perps-only ⇒ a cross-venue long-spot/short-HL-perp carry is the deployable form).

**Application to MM:** funding is not just a standalone strategy — a market maker on a perp holds involuntary inventory that **accrues funding**, now modelled as the fifth P&L line on the desk (see [PNL_ACCOUNTING.md §5](PNL_ACCOUNTING.md)). On a positive-funding venue, a net-short maker is *paid* to hold inventory; a net-long maker pays. This materially changes the inventory-management calculus and is a genuine reason HL (rebate + harvestable funding) is the default venue.

---

## 5. FX-stable basis & options volatility — two more honest reads

- **FX-stable basis (EUR stablecoins):** the basis **reverts fast and reliably** — but it is **sub-fee for a taker**. The mean reversion is real; the per-trip edge is smaller than the round-trip taker cost. **Decision: route it to the maker book** (earn the spread rather than pay it), not trade it as a taker stat-arb.
- **Options variance risk premium (VRP):** the desk's Black-Scholes + Bachelier Greeks layer was **validated against Deribit on live data** (IV and Greeks match), and the **VRP is positive on both majors** — short vol has a real carry. This is a *measured, validated* edge held in reserve; it is not yet a live book.

Both reinforce the cost-discipline lesson: an edge that is real in price terms can be uneconomic for the wrong execution style (taker vs maker), and the honest move is to *change the execution*, not to ignore the cost.

---

## 6. Market-making microstructure — the deepest results

Market-making is the desk's live earner, and the microstructure research is where the fidelity work paid off. Findings, in order of how much they changed the picture:

1. **Fill-on-touch overstates fills only where you want to believe it.** Against a real Hyperliquid L2 tape with real per-trade aggressor flow, a **top-of-book** maker quote fills *about as often as fill-on-touch claimed* (ratio ≈ 1.0 — the top of book turns over fast). The loss there is **adverse selection, not phantom fills.** But a quote placed **into the stack** (e.g. 5 bps deep) fills **0** against ~21 touches — the cumulative queue above never clears. *Fill-on-touch lies most exactly on the wide, "safe" quotes.*
2. **The quoters were silently calibrated for ~$1 assets.** Avellaneda-Stoikov/GLFT written in price units mis-scale the variance term by ~10⁶ on a $1,900 asset (a −$18-trillion DEX run exposed it). The fix — computing skew/half-spread as fractions of mid off a fixed $1 reference, σ kept a return fraction — makes the quoters **price-scale-invariant** (identical bps at $1 or $1,900). This is a prerequisite for quoting any non-stablecoin.
3. **A market maker needs a ≤0 bps maker venue.** On a trending asset, a naive fixed spread takes a large adverse-selection loss; the spread captured is real but adverse > spread. At +1 bps retail maker cost the book loses; at 0 bps (structural) it is positive and monotone with low drawdown (a 24h replay: structural net positive across all buckets, **max drawdown ~0.001%** at $400k inventory). **The deploy condition is a maker rebate** — which is why **Hyperliquid (−0.2 bps rebate CLOB + L2 + funding)** became the default venue.
4. **DEX pools are wider but not free money.** GeckoTerminal DEX pools (Uniswap-v3) quote on the live loop, but the wider spread is **hazard compensation** (MEV, sandwiching, thin pools), and at fill-on-touch with no rebate they are net-negative — the honest lesson, not a disappointment.
5. **Per-pool γ/κ tuning needs *real* aggressor flow — and on it, a rebate book nets positive (BTC).** Sweeping γ × κ × spread-floor over a captured L2 tape, ranked drawdown-first then maker-net at the venue's own fee, is the right machinery — but on a **candle-volume estimate** of aggressive flow, every combo on top-of-book BTC/ETH/SOL filled **0**. Replacing the estimate with the **real Hyperliquid trades WebSocket** (per-trade taker flow, signed by aggressor side) unblocked it. On a 111-step / ~2h capture with **100% real WS flow + queue-aware FIFO fills + funding**, fill-on-touch overstated fills **3×** (queueFills 3 vs touchFills 9), and the per-pool sweep found **BTC γ=0.0005 / κ=1 / 5bps floor → +$345 over ~2h on $1M, maxDD 0.53%** — the **first net-positive read on honest fills at the −0.2bps rebate** (spread captured +$541 > adverse selection +$434). ETH/SOL had **no profitable calibration on the window** (every filling combo net-negative ⇒ the tuner correctly stands aside). The honest caveat: tiny fill counts (0–5/coin), one ~2h regime — *directional, not deployable*; the next step is repeated captures to turn one read into a distribution. Artifact: `docs/research/2026-06-04-mm-l2-wsflow1-verdict.json`.
6. **A fixed-spread OHLCV scan can't rank MM profitability — but it *can* discover new markets by inventory risk.** A full **230-perp Hyperliquid universe scan** (`scripts/hl-universe-discovery.ts`: one `metaAndAssetCtxs` call → funding + daily volume; per-coin klines → the live screener's `scoreMmSuitability`) nets **negative on every perp** at a fixed 1bps half-spread — because the proxy charges full per-bar σ as adverse against a fixed tiny spread, while the live book quotes a **σ-proportional** spread. The honest, *expected* corroboration of finding 5: MM edge is rebate + queue position, an L2/flow question, never OHLCV. The scan's real deliverable is the **σ-ranked liquid shortlist** (lowest inventory risk → least adverse): beyond BTC/ETH/SOL it surfaces **XRP (σ 11.6bps ≈ ETH, $96M/day, funding −19% APR), DOGE, ASTER, BNB** — non-majors at major-grade calm, now the `hl-discovery` paper preset and the next L2-capture targets. Inventory-risk ranking, *not* a profitability verdict (n=1 snapshot). Artifact: `docs/research/hl-universe/`; pipeline: `docs/research/hl-universe/RUNBOOK.md`.

---

## 7. Venue & data evaluation — the cross-venue map

A standing evaluation ledger ([DATA_SOURCES.md](DATA_SOURCES.md)) scores every venue on posture (no-key/key-free/paid), data (OHLCV/L2/funding/trades/IV), **maker economics** (rebate/0/cost — the MM deploy condition), and fit. Wired and load-bearing today:

| Venue | Kind | Maker | Role in the findings |
|---|---|---|---|
| **Hyperliquid** ⭐ | Perp-DEX (CLOB) | **rebate −0.2 bps** | default MM venue; L2 queue-aware fills; trades-WS aggressor; hourly funding carry |
| **Binance public** | CEX | ~1 bps / 5 bps | the data spine; stablecoin-peg stat-arb; 8h funding |
| **GeckoTerminal** | DEX (AMM, 100+ chains) | LP-fee (pool-dependent) | the discovery frontier; wider-spread / higher-hazard |
| **Alpaca** | Equities (paper) | commission-free | equities live + OOS gate |
| **Yahoo daily** | Equities | — | decades of free adjusted daily history (survivorship-caveated) |
| **Pyth / DefiLlama / Bit2C** | FX / peg / ILS reference | — | FX scan, peg readout, cross-source basis (pending) |

The growth frontier is **more perp-DEX CLOBs** (dYdX v4, Drift, Vertex/Aevo/Paradex) — each a maker-rebate + L2 + funding venue, the native habitat for inventory-aware quoting and cross-venue basis.

---

## 8. What is deployable, what is parked

| Strategy / venue | Status | Honest one-line verdict |
|---|---|---|
| Crypto stat-arb (non-stable) | **killed** | cointegration cliff; structurally untradeable net of fee |
| Stablecoin-peg stat-arb | watch | the one structural crypto spread; narrow, fee-bound |
| Equities sector stat-arb | **real but ~0.06 Sharpe** | under the bar; survivorship-bound; forward paper is the verdict |
| Funding-rate carry | **real, modest** | ~3–8%/yr on majors; hold past breakeven; needs a spot leg for delta-neutral capture |
| FX-stable basis | route to maker | reverts reliably but sub-fee for a taker |
| Options VRP | validated, in reserve | positive carry; BS matches Deribit; not yet a live book |
| MM on a rebate CLOB (HL) | **the live earner** | first **net-positive honest-fill read** (BTC tuned, +$345/2h/$1M, maxDD 0.53%) on real WS flow + queue-aware fills + −0.2bps rebate; ETH/SOL stand aside this window. Directional (one ~2h regime) — regime-breadth next |
| MM on a DEX AMM | research | wider spread is hazard pay; net-negative at fill-on-touch with no rebate |

**Real-capital deployment is parked** by mandate — Meridian is paper-only for the foreseeable future. The deliverable is a forward paper track record with conserved equity and low drawdown, produced by the honest measurement stack above.

---

## 9. The throughline

Across six strategy families and eight venues, one lesson recurs: **the naive edge is an artifact, and the honest edge is small.** Short windows manufacture crypto cointegration; survivorship manufactures equity Sharpe; fill-on-touch manufactures maker fills; ignored funding and impact manufacture carry. Strip each artifact out with the right control and what remains is modest — a few percent of funding carry, a 0.06-Sharpe equity basket, a structurally-positive maker book that lives or dies on a rebate. The desk's actual product is not any one of these edges; it is the **measurement discipline that tells them apart** — and the willingness to publish the null result. That is the research worth publishing.

---

### Reproducibility

All results are reproducible from the repo with public, no-key data (Alpaca/Yahoo for equities, Binance/Hyperliquid/GeckoTerminal public APIs for crypto). Key entry points: `scripts/cointegration-stability.ts`, `scripts/oos-candidates.ts`, `scripts/funding-carry-research.ts`, `scripts/mm-l2-session.ts`, `scripts/mm-l2-tune.ts`. The full chronological research log with per-run numbers and artifact paths is [QUANT_JOURNAL.md](QUANT_JOURNAL.md); the accounting that underlies every P&L figure is [PNL_ACCOUNTING.md](PNL_ACCOUNTING.md); the venue evaluation rubric is [DATA_SOURCES.md](DATA_SOURCES.md).
