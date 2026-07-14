# Prediction-Market Market Making — the research memo

> 2026-07-14, written at the principal's direction after #96. Question posed: *"I thought
> making markets — using our millisecond models from the current MM desks — applied to
> prediction markets. I don't want to take positions, I want to make money on the spreads.
> I think we did this wrong."*
>
> **Verdict up front: the instinct is correct.** The ORV book (#96) was built as a
> taker/position book because we transferred the #70 "spread-MM is dead" verdict onto
> prediction markets. That transfer was wrong — every condition that killed spread-MM on
> Hyperliquid perps **inverts** on prediction-market books. The strategic frame should have
> been *house vs the crowd* (maker), not *prop bettor vs the crowd* (taker). This memo
> records why, how professionals actually earn on these venues, and the proposed build.

## 1. What #70 actually killed, and why it does not transfer

Entry #70's verdict: passive spread-MM on HL perps is negative-EV **for a participant with no
latency edge, no rebate tier, no flow, quoting ~1bp-wide books against professionals**. The
three load-bearing conditions, and their status on prediction-market binaries:

| #70 condition (HL perps) | Prediction-market books (HIP-4 / Polymarket crypto) |
|---|---|
| Spread ~1–2bps; the −0.2bps rebate is ~10× too small to cover multi-bps adverse selection | Spreads are **100–2,700bps**: our founding HIP-4 read was 2.7c wide on a 0.14 fair (#96 founding read); the ETH daily book sat **23 points wide** overnight. The spread available is 2–3 orders of magnitude larger relative to adverse-selection cost. |
| We are structurally the **slowest** quoter (validators in Tokyo, 2–3ms insiders vs our >200ms) — adversely selected by design | For crypto price binaries, "informed flow" = people reacting to the **underlying** move. We watch the underlying at sub-second cadence and reprice fair value analytically (Φ(d2) recompute is microseconds). On these books **we are the fast one**. The crowd re-quotes every 30–60s ([QuantVPS](https://www.quantvps.com/blog/market-making-in-prediction-markets)). |
| Flow is informed/professional; Citadel/Virtu earn spread on **purchased uninformed** flow — we held the photographic negative | Prediction-market flow is **retail/uninformed** (lottery buyers, in-play bettors) — the one venue class where uninformed flow is available without buying PFOF. |

Plus two structural bonuses absent on perps:

- **Inventory is defined-risk and self-extinguishing** — max loss = collateral, books settle
  in minutes-to-hours. The #64/#65 warehouse-drift trap has no room to grow.
- **Inventory is hedgeable where we already live** — a BTC/ETH binary has a digital delta off
  the same validated Greeks stack (#12); HIP-4 trades **in the same margin system as the
  perps**, so the hedge is co-located. Nobody in the retail-MM meta delta-hedges with a
  smile-calibrated model (see §3, the practitioner postmortem).

**Direct market evidence the speed-edge is real in this asset class:** Polymarket introduced
dynamic taker fees on its 5/15-minute crypto markets **explicitly to neutralise latency
arbitrage** ([Finance Magnates](https://www.financemagnates.com/cryptocurrency/polymarket-introduces-dynamic-fees-to-curb-latency-arbitrage-in-short-term-crypto-markets/),
[Cointelegraph](https://www.tradingview.com/news/cointelegraph:e59c32089094b:0-polymarket-quietly-introduces-taker-fees-on-15-minute-crypto-markets/)).
Fast fair-value traders were extracting enough from stale resting quotes that the venue
redesigned its fee model — and the redesign **routes 20–25% of those taker fees to makers as
rebates**. The venue is paying the side of the trade we want to be on.

## 2. Venue book (July 2026)

**Hyperliquid HIP-4** (mainnet 2026-05-02; our client already built, `src/prediction/`):
- **Fees: zero to open; charged only on close/burn/settle at perp-tier rates (~4bps maker /
  7bps taker); no maker rebates on outcome orders — rebate-tier users pay zero instead**
  ([Chainstack docs](https://docs.chainstack.com/docs/hyperliquid-hip4-outcome-markets-trading),
  [Bitcoin.com](https://news.bitcoin.com/hyperliquid-launches-hip-4-and-targets-polymarket-with-zero-fee-outcome-markets/)).
  ⚠️ **Our ORV fee placeholder (0.005/contract ≈ 50bps) is >10× too pessimistic** — the #96
  founding read's "1.5c fee-adjusted edge, below the 3c gate" was closer to 2.4c with real fees.
- Matching-engine fill taxonomy matters for a maker: **mint** (both sides opening) = **no fee
  to either side**; only the closing side of a normal trade pays. A maker who mostly opens
  against openers trades near-free.
- Limit orders only; prices 0.001–0.999, tick 0.0001 on the BTC binary; min notional $10;
  fully collateralized; YES/NO are **separate books** whose mids sum to ~1 (a standing
  complement-arb check).
- **Settlement = linear interpolation of mark-price samples**, not candle closes — our settle
  logic must match this, and it slightly smooths the pin.
- Young books, thin professional presence (a 23pt-wide ETH book overnight says nobody serious
  is quoting), no incentive program yet. This is exactly the "new markets" layer of the
  progress letter — *first disciplined quoter wins*.

**Polymarket** (CLOB, CTF on Polygon; public WSS/REST book feed):
- **Liquidity Rewards Program**: daily USDC, per-minute random sampling, quadratic score
  S(v,s) = ((v−s)/v)²·b — quoting near the mid earns disproportionately; min size and max
  spread per market; **two-sided required when mid <0.10 or >0.90**
  ([official docs](https://docs.polymarket.com/market-makers/liquidity-rewards)).
- **Maker Rebates Program** on short-duration crypto markets: dynamic taker fees (up to
  ~3% near p=0.5, →0 at the extremes, i.e. fee ∝ p(1−p)) fund daily maker rebates, 20–25%
  of taker-fee revenue ([docs](https://docs.polymarket.com/polymarket-learn/trading/maker-rebates-program)).
- Runs **5-min / 15-min / hourly / 4h / daily BTC & ETH up-down and threshold markets** — the
  highest-velocity crypto binaries anywhere, straight in our wheelhouse
  ([polymarket.com/crypto](https://polymarket.com/crypto)).
- Real-money venue (we are paper-only) — but the book feed is public: we can **paper-quote
  against their real L2** exactly like the HL replay harness, and model the rewards score as
  an explicit P&L line.

**Kalshi** (US-regulated DCM): maker fees ~0; taker fee ≈ 0.07·p·(1−p)·contracts; a
selective **designated market-maker program** (enhanced rebates ~0.5¢/contract + quoting
obligations) — Susquehanna has been the anchor MM since launch
([Kalshi help](https://help.kalshi.com/en/articles/13823819-how-to-become-a-market-maker-on-kalshi),
[Sportico](https://www.sportico.com/business/sports-betting/2025/kalshi-trading-exchange-peer-house-1234870465/)).
Crypto hourlies exist; the venue is sports/event-heavy. Later target, not first.

**AMM venues** (Azuro, Overtime, etc.): passive-LP models, not order-book MM — out of scope.

## 3. How the professionals actually earn (and how they die)

Three income streams, stacked: **(1) spread capture** on retail flow, **(2) venue payments**
(Polymarket rewards + rebate share; Kalshi DMM rebates), **(3) hedged-inventory carry**
(fills warehoused delta-neutral until TP/settle). The public post-mortems agree on the
failure mode — a two-week Polymarket LP deep-dive
([wanguolin](https://medium.com/@wanguolin/my-two-week-deep-dive-into-polymarket-liquidity-rewards-a-technical-postmortem-88d3a954a058))
found early reward farmers printing 200–300 USDC/day on 10k, then the meta compressed, and
the standing lesson became: **"unless you have strong, independent alpha, treat liquidity
rewards as a bonus, not the main profit engine."** Resting orders without a fair value =
selling gamma/tail risk for pennies; every minute in the book is unpriced short-vol exposure.

The quant framing ([HangukQuant](https://www.research.hangukquant.com/p/digital-option-market-making-on-prediction)):
fair value = e^(−rτ)Φ(d2); **quote half-width should scale with σ√τ·φ(d2)** (the digital's
local risk) plus inventory and calibration-error terms; near-expiry ATM is "0DTE but worse" —
delta explodes, hedging fails, spreads must blow out or quotes pull. Susquehanna's observed
behaviour on Kalshi is the same discipline: they **pull all quotes instantly on news** (the
Roschon Johnson scratch). The MM game here is won by repricing/pulling speed and priced
inventory — both of which are the desk's validated strengths (#27–#33: microprice centering +
sub-second cadence flipped spread-vs-adverse from −$1,020 to +$133).

**Where the maker edge dies, mapped to our controls:**

| Risk | Control |
|---|---|
| Near-expiry pin (digital Γ→∞ at strike) | σ√τ·φ(d2) width floor + hard no-quote window near expiry (ORV already has <45min) |
| News-jump books (sports/politics — no priceable underlying) | **Refused by construction** — only `class:priceBinary` on BTC/ETH, already our doctrine |
| Stale-quote pickoff on underlying moves | The sub-second reprice loop — our core validated mechanism; pull quotes when the underlying tick beats our re-quote |
| Warehoused fills | Digital-delta hedge in the co-located HL perp (existing hedge machinery), complement-pair netting (YES+NO), collateral caps |
| Fee/oracle assumptions | Confirm live: fill-taxonomy fees (mint vs close), mark-price-interpolation settle |
| Paper-fill flattery (no real queue) | The #96 caveat stands — FIFO queue-aware replay first (LobReplayHarness pointed at binary books), report fills conservatively |

## 4. The reframing that matters most

The #96 pre-registered gate — *Brier(RND) must beat Brier(market mid) before capital* — is
the right gate **for a position book** and the **wrong gate for a maker book**. A maker does
not need to out-calibrate the market mid; it needs a fair value **good enough and fast
enough** that resting quotes k cents around it are not systematically adverse-filled, plus a
hedge for what does fill. That is a strictly weaker requirement, and it is the one the desk's
existing machinery (fair value + cadence + hedge + PnlAttributor's spread/adverse/inventory
/fee decomposition) was built to satisfy. The calibration scorer stays — it validates the
quote anchor with free data and still adjudicates the parked position book — but it is not
the gate for making markets.

What the taker trial bought us (not wasted): the full HIP-4 pipeline live-verified (books,
fills, settle, caps), the NO-side skew lesson, and the founding fair-value read. It was the
wrong strategic frame, honestly run.

## 5. Proposed build (pre-registered; Phase 0 approved by the principal and SHIPPED same day — Journal #97)

**Phase 0 — measure before quoting (extends the already-planned calibration scorer):**
`orv-calibration.ts` grows a **maker-fill simulator**: snapshot HIP-4 L2 + RND fair at ~1s
cadence across all listed BTC/ETH dailies; replay resting two-sided quotes (half-width grid ×
reprice cadence grid) through the existing FIFO queue-aware harness. Pre-registered metric:
**revenue density** = fill-rate × captured half-spread − adverse markout (at +60s and at
settle) − hedge cost, per $ of collateral per day, with the fee taxonomy done right. If
revenue density ≤ 0 at every grid point, the maker thesis dies before a book exists.
- Same capture answers the calibration question (Brier at settle) for free — one collector,
  two verdicts.

**Phase 1 — `OutcomeMakerBook` (paper, HIP-4 first):** quote both sides around RND fair with
inventory skew (Avellaneda-style on bounded prices), σ√τ·φ(d2) width floor, no-quote window
near expiry, per-market/desk collateral caps, YES/NO complement netting, net digital-delta
hedge via the existing hedge stack, DeskEvent journaling (EVAL/QUOTE/FILL/HEDGE/SETTLE).
Success metric pre-registered from Phase 0's measured distribution before launch.

**Phase 2 — venue breadth:** Polymarket CLOB WSS adapter — paper-quote the real 15-min/hourly
crypto books with the **rewards score modelled as an explicit P&L line** (their sampling and
quadratic scoring are published, so the score is computable offline); Kalshi after.

**Corrections to the record shipped with this memo:** HIP-4 fee placeholder is ~10× high
(fix `ORV` fee model when trading resumes); `PROBABILITY_DESK.md` "killed spread-MM" framing
is scoped to perp-class books by this memo.

---
*Sources: linked inline. Repo grounding: QUANT_JOURNAL #70 (the perp-MM verdict), #27–#33
(fair-value/cadence mechanism), #96 (ORV overnight + founding read); PROBABILITY_DESK.md;
DESK_PROGRESS_2026-07-14.md (the "new markets" thesis this memo operationalizes).*
