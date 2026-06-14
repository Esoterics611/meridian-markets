# MASTER PLAN III v2 — RED TEAM & EXPANSION
## A hostile review of the Wealth Desk plan by its own author, the strategies it missed, the markets it ignored, and the pruned operating model that survives contact

**Status:** Research document, June 12, 2026. Supersedes nothing — read alongside `WEALTH_DESK_MASTER_PLAN.md` (v1). Part A demolishes, Part B expands, Part C rebuilds smaller, Part D gives the new build prompts. Same disclaimer as v1: research framework, not advice; your capital, your calls.

> **Repo note (2026-06-14):** this is a copy kept in-repo for citability. It plans a personal
> multi-sleeve wealth desk ("Otzar") that is **mostly off-mission** for meridian-markets
> (CLAUDE.md §1: paper-only demonstration). Only **W9** + **W17** (and the **EV1** event/news
> infra they motivate) are scheduled here — see `docs/MASTER_PLAN_SESSIONS.md` PART VI. Everything
> else is recorder-only-after-the-F-chain or parked. Do not build the real-money sleeves.

---

# PART A — THE RED TEAM: what in v1 was bullshit, half-true, or undersold

I reviewed v1 the way a PM reviews a junior's pitch deck: assume every number is the best-case, every "unique edge" is shared by twelve other shops, and every backtest is curve-fit. Seven findings.

## A1. W1 ("nobody else will be there on HL options day one") — the single biggest overclaim in v1

**The claim:** day-one HL options MM is uncontested because you uniquely have HL execution + same-account perp hedging + a vol feed.
**The truth:** Wintermute, QCP, Amber, Auros, Galaxy, Pulsar, and a dozen prop shops have full options stacks, existing HL accounts, and far deeper vol books. If HL options matter, they will be there in week one with tighter Greeks risk than you. The HIP-3 experience proves capital shows up fast for anything on HyperCore.
**What actually survives:** three smaller, true edges. (1) **Size asymmetry** — books and expiries too small for a fund's minimum-viable-attention threshold are not too small for you; this is the same logic that put HIP-3 RWA books at the top of the Sweet-16 instead of BTC. (2) **Speed-to-deploy** — your agent-orchestrated build pipeline genuinely can re-spec a desk in days; most shops can't re-prioritize that fast for a small market. (3) **Same-margin-account delta hedging** is a real cost edge, just not a moat.
**The bigger problem v1 buried in one clause — the vega trap:** in a brand-new options market there is *no liquid instrument to hedge vega with*. Every fill makes you a net volatility position you cannot lay off; the perp leg only neutralizes delta. Day-one options MM is therefore **vol warehousing with extra steps** — you are structurally a vol seller into whatever the crowd buys (in crypto: calls). The mitigation is not cleverness, it's sizing: per-expiry vega caps an order of magnitude below what MM instinct suggests, quote mainly short-dated (gamma/theta cycle fast, vega exposure small), widen brutally as inventory accumulates, and accept being un-hedged-vega as the priced cost of the spread. v2 keeps W1 but demotes it from "the killer" to "a good trade with a famous failure mode."

## A2. The 14% VRP number — true, dated, and abused

Three separate problems with how v1 leaned on it. **First, apples-to-oranges:** the 0.14 figure is in annualized *variance* units (risk-neutral 0.72 vs realized 0.58) — it is not "14% return on capital for selling options," and converting variance premium into realized Sharpe after hedge costs, fees, and tail events typically loses half or more of it. **Second, the sample is 2017–2022** — before the ETF era. **Third, and decisive: the premium is being industrially harvested now.** The options complex has institutionalized — options OI now exceeds futures OI, with IBIT alone at 52% share, and institutional desks now layer overlay strategies onto spot exposure as standard practice. Covered-call ETFs and systematic overwriting programs sell exactly the front-end, near-ATM BTC premium the paper measured. Compressed vol confirms it: implied vol at 36 is near its lowest since 2023.
**What survives:** premium doesn't die under harvesting pressure, it *migrates* — to the wings and skew (retail still buys lottery calls; the call-wing slope is steepest in low-vol regimes), to alt-coin vol (SOL, XRP, HYPE options are young and less overwritten — CME only launched SOL and XRP options in October 2025, and HYPE options trade on Derive), to event dates and weekends, and to on-chain venues. **v2 directive: before selling a single contract, run "premium cartography"** — use the Session 1 surface recorder to *measure* where IV−RV spread, by wing, tenor, asset, and venue, is still fat in 2026 data, and sell only there. The strategy is no longer "harvest the VRP"; it is "map the VRP, then harvest the surviving pockets." (Session 12.)

## A3. The trend Sharpe of 1.51 — an in-sample optimum I quoted like a fact

The 1.51 came from the single best lookback/holding pair (28d/5d) in a 2013–2023 sample — the era when BTC did multiple 10x runs. Post-financialization crypto trends less cleanly; 2025–26 has been a whipsaw tape (2025 was flat but violent, and the market has chopped heavily with prediction markets now pricing ~50% odds of a touch of $45,000 before year-end). Plan on ensemble Sharpe of 0.5–0.8, not 1.5.
**What survives — and this is the most important constructive finding in the whole red team:** trend's risk-adjusted return comes from *breadth*, not parameter choice. A one-asset (effectively BTC-beta) trend program is "HODL with exits." A **twenty-market trend program** is a CTA. And for the first time in history, a single venue you already trade offers crypto + gold + oil + tokenized equities + FX, 24/7, on one margin account: HIP-3 books, where tokenized stocks and commodities are now 23 of the top 30 pairs and the venue has become the de facto weekend market for crude and gold. That upgrade — W4 becomes W9 — is worth more than every options strategy in v1 combined, and it reuses the most battle-tested parts of your stack. Full spec in Part B.

## A4. Eight sleeves for a one-man desk is attention bankruptcy

v1's portfolio was designed for a desk with a staff. You run an MM operation, a day job, Vanguard, and sefarim projects. Every live sleeve costs monitoring, reconciliation, tax accounting, and — the real killer — *context-switching during stress events*, which is exactly when all sleeves demand attention simultaneously (correlations of operational load go to 1 in a crash, just like asset correlations). Part C prunes to a **3+1 model**: three always-on sleeves that need only the Monday page, plus exactly **one** rotational opportunistic slot. Never two opportunistic sleeves live at once. This rule will cost you money in some quarters and save the desk in one bad week.

## A5. The trade v1 was too polite to name

The highest risk-adjusted return on your marginal hour is probably not any strategy in either document — it's scaling the MM operation (measured, working, fee-tier compounding) and your salary/career capital. Otzar's honest mandate is to be the *low-attention compounding layer* under those, not a second full-time job. Any design choice that makes Otzar exciting is a design failure. This is why Part C is smaller than Part B.

## A6. Costs v1 hand-waved

(a) **Tax drag:** Israeli tax treatment differs across spot, derivatives, staking yield, and on-chain rewards; a 5% gross carry trade can be a ~2.5% net trade, *below* the riskless floor. No sleeve goes live before the after-tax hurdle is computed with your accountant — this is a one-time table, build it once. (b) **Counterparty/venue map:** v1 said "venue risk" without pricing it — Deribit custody (now Coinbase-owned, a plus), on-chain contract risk on Derive/opt.fun/HIP-4, stablecoin issuer risk on the cash floor. Part C assigns explicit caps per counterparty bucket, which is the only honest way to "price" it. (c) **The annualization trap** on resolution-locked trades: a prediction-market arb earning $200 on $2,000 locked for 90 days is a 4% annualized return dressed as a 10% win — every W10-class trade must be evaluated in annualized, capital-locked terms.

## A7. v1's stress test was too gentle

Add four scenarios to the Session 8 kernel: **(S2) the melt-up** — BTC +40%, IV ×1.5: hurts the collar's short call leg and any short call-wing premium trades, precisely the structures v1 favored; **(S3) correlation-to-one** — all alt/RWA trend positions and vol pairs converge to one beta overnight (the dispersion trade's nightmare and the multi-asset trend program's worst week); **(S4) yield-stack break** — the cash floor's yield-bearing stables gap: Ethena's insurance fund stood at $61M against $5.6B supply — roughly 1.1%, and over $4.2B of sUSDe sits looped through Pendle PTs on Aave, about 60% of USDe supply — a reflexive flywheel that unwinds fast; **(S5) venue-down-during-gap** — Deribit or HL unreachable for 6 hours during a 20% move with open short gamma. If the book can't survive S1–S5 simultaneously at the 15% budget, the book is too big.

---

# PART B — THE EXPANSION: more strategies, more markets, more brain

Numbered continuing from v1. Stars mark what changed my mind during the red team.

## W9 ★★ The 24/7 multi-asset trend program on HIP-3 (v1's W4, grown up)

**The upgrade:** run the same ensemble TSMOM engine across every liquid HIP-3 book plus core crypto: gold, silver, crude, equity-index and mega-cap tokenized stocks, FX crosses, BTC/ETH/SOL/HYPE — fifteen to twenty-five markets on one venue, one margin account, one execution engine you already trust. Classic managed-futures math: at pairwise correlations of 0.2–0.4 across asset classes, twenty markets at individual Sharpe ~0.3 aggregate to a program Sharpe near 1 — breadth manufactures what parameter-tuning fakes. And the venue's structural quirk is a genuine, possibly unique edge: these books trade around the clock and have become the de facto venue for trading commodities like crude and gold over the weekend, exactly when high-impact events have habitually broken — a trend system that can *respond to weekend information while CME sleeps* is something no traditional CTA possesses.
**Honest costs and red ink:** (1) funding payments on perps are a persistent drag long-trend positions must overcome — log funding-adjusted signal returns, and let the signal itself net expected funding; (2) HIP-3 deployer risk — these markets are not covered by HLP and depend entirely on the deployer's liquidity management, and you watched Felix shut down; cap per-deployer exposure; (3) the run-53 stale-underlying lesson inverts here: weekend prices on RWA books are *discovery*, but Monday-open gaps vs the underlying are basis risk — size each market off its *gap-inclusive* volatility, not its smooth-hours vol; (4) liquidity on the long tail of HIP-3 books is thin — the universe scanner from Master Plan I's book-selection module is the right gatekeeper for which markets the trend program may touch.
**Verdict: this replaces W4 as the desk's core engine and is the strongest single idea in either document.** Session 9.

## W10 ★ The probability-surface complex (prediction markets × options digitals)

Four venues now price the same BTC event risk in binary form: Kalshi (regulated US), Polymarket (crypto-native), HIP-4 on HL (live since May 2, 2026 with daily BTC binaries), and Deribit (any strike's digital is implied by the surface). They are populated by different crowds — Polymarket skews crypto-native, Kalshi skews TradFi, and deposit friction prevents fast equalization — and the inefficiency is documented at scale: academic work from IMDEA found over $40 million in arbitrage profits extracted from Polymarket alone between April 2024 and April 2025 across 86 million bets, with persistent 1–5% cross-platform spreads attributed to structural differences in user bases, fees, and settlement.
Three sub-strategies, in rising sophistication: **(a) pure cross-venue arb** — same event, YES on one venue + NO on another summing under $1.00 after fees; risk-free in outcome terms but capital-locked (the A6 annualization trap governs sizing); **(b) surface-vs-crowd RV** — your fitted Deribit surface prices any digital; when Polymarket assigns 53% to BTC touching $45,000 before Dec 31 and Kalshi ~48% to the same class of event, compare against the option-implied barrier probability and trade the gap on the venue side only (one-touch pricing needs care — use the surface plus a barrier adjustment, and demand a fat edge buffer); **(c) HIP-4 making** — v1's Session 7 already specs it; the surface is the same machinery.
**Red ink:** resolution risk (wording disputes), small capacity (this is a $1–5k-per-trade game, perfect for you, useless for funds — that's *why* it persists), withdrawal/jurisdiction frictions across venues, and the temptation to take a *view* instead of trading the *gap*. Verdict: research-grade until the probability recorder (Session 10) shows 3 months of measured, executable gaps.

## W11 The ETH staking-stack and the carry family tree

A unification v1 missed: staking yield, perp funding carry, and sUSDe are *the same trade* at different points on a risk curve. (a) Hold the ETH core as **staked ETH** (stETH/eETH) — ~3% native yield on a position you hold anyway; the cost is liquid-staking contract risk and stETH/ETH basis in stress. (b) **Staked-ETH basis trade** — long stETH, short ETH perp: collects staking yield + funding when positive, the classic cash-and-carry with a yield-bearing leg; currently thin for the same reasons as W3 but it shares W3's regime gate and infrastructure. (c) Or skip the construction and **hold sUSDe, which is this trade in a wrapper**: sUSDe yield comes from perp funding plus staking yield on collateral, realized 4%–30% across 2024–25 with most periods at 8–18%, compressed to high single digits in Q2 2026 as funding cooled. The decision rule: if your self-built carry (W3/W11b) can't beat sUSDe net of your own ops time, hold the wrapper and spend the hours on W9. That comparison — *build vs buy on every carry trade* — belongs on the Monday page.

## W12 The enhanced-cash yield curve (the W8 floor, done properly)

The cash floor is a *portfolio*, laddered by risk bucket with hard caps: T-bill-grade wrappers and regulated platform yield at the base; sUSDS at the governance-set 3.75% and similar in the conservative DeFi bucket; Pendle PT fixed yields typically pricing 5–11% over 30–180 day terms and Maple's syrupUSDC at a published 6–10% in the credit/duration bucket; sUSDe (7-day trailing ~9.4% as of late April, 90-day trailing 11.8%) in the basis-risk bucket, sized knowing the ~1.1% insurance buffer. **One anti-strategy and one intelligence product:** never loop PTs as collateral — the $4.2B looped PT-sUSDe complex on Aave is one of the most influential yield engines on-chain and therefore one of its largest reflexive unwind risks; instead, *monitor* it — Pendle PT implied yields and the loop's size are a free leading indicator of funding-regime turns for W3/W11, and that monitoring feed is a Tessera module, not a position. Session 11.

## W13 Volatility relative value — four concrete pairs instead of v1's vague seam

(a) **Alt-vol vs major-vol:** SOL/XRP/HYPE implied vs BTC/ETH implied — young, less-overwritten surfaces (CME's SOL and XRP options only launched October 2025) against the industrially harvested majors; structurally long the rich-premium side, beware correlation-to-one (stress S3). (b) **Deribit vs IBIT/CME IV** — same underlying, different collateral, hours, and crowd; slow-moving, data-first. (c) **The weekend-vol seam:** on-chain venues price Saturday risk, listed venues price Friday-close-to-Monday-open as one gap; calendar structures around the weekend boundary monetize the difference — and your venue *makes* weekend prices (W9's edge, expressed in vol). (d) **HYPE implied (Derive) vs HYPE realized** — you have better HYPE realized-vol and flow data than almost anyone alive; if any single-name vol mispricing is knowable to you, it's this one. All four are *recorder-first*: no trades until Tessera's surface module shows the gap is persistent, executable, and survives fees.

## W14 The event-vol calendar (mostly a rule, occasionally a trade)

The rule (free): never hold short gamma over scheduled macro prints and known crypto events; the v1 W2/W6 executors get an event-blackout calendar. The trade (optional): systematic pre-event long-vol / post-event crush structures only where the cartography (Session 12) shows event premium is *under*-priced — in crypto it is often over-priced, in which case the rule is the whole strategy.

## W15 Skew harvesting on the lottery wing

The crypto-specific premium pocket most likely to have survived institutionalization: the persistently bid call wing, steepest in low-vol regimes — i.e., *now*. Expression: call-spread overwrites on the rich wing (defined risk, sells the 15–25d call, buys the further wing), gated on measured smile asymmetry rather than IV level, so it can run even when the ATM VRP gate is closed. This is the *only* short-premium structure v2 permits in the current low-IV regime, because it sells the part of the surface that is rich *relative to itself*. Melt-up stress S2 is its nightmare; size accordingly and pair it with the trend program, which is long the melt-up by construction.

## W16 Forced-flow provision (HLP-class vaults and backstop liquidation)

Returns from being the counterparty to liquidations — flow that *must* trade. You understand the adverse-selection profile of HLP better than most (you compete with it daily), and each HIP-3 dex now runs an onchain backstop liquidator that takes over backstop-liquidatable positions. Small, capped allocation; treat drawdown history as the only prospectus. It diversifies *return source* but concentrates *venue* — count it fully against the HL concentration cap.

## W17 Cross-sectional alt momentum (the stat-arb you didn't reject)

Your "stat-arb is weak" verdict was about cointegration pairs — unstable spreads, crowded majors. Cross-sectional momentum is a different animal: research on crypto momentum finds the cross-sectional portfolio better suited to cryptocurrencies than time-series in some samples, and the same large-cap study that validated TSMOM tested cross-sectional variants across the same horizons. Long the strongest quartile, short the weakest, beta-neutralized, weekly, on the HL universe your book-selector already scores for liquidity. Modest conviction, market-neutral by construction, shares 100% of W9's infrastructure — which is the only reason it makes the list. Run it as a *signal inside W9's engine* (a cross-sectional tilt), not a separate desk.

---

# PART C — THE PRUNED OPERATING MODEL: what one disciplined human actually runs

## C1. The 3+1 structure

**Always-on (Monday-page attention only):**
1. **W12 cash curve** — laddered floor, hard caps per risk bucket, quarterly review.
2. **W9 multi-asset trend** — the engine; weekly rebalance through Malchus; includes the W17 cross-sectional tilt as a signal, not a sleeve.
3. **W5 collar program** — quarterly rolls on the core stack, trend-conditional call leg; entered now while IV sits at nine-month lows.

**The one rotational slot (at most ONE live at any time, chosen by the regime engine):**
- CARRY dial opens → W3/W11 carry harvester gets the slot.
- VOL dial reaches RICH → W2 (cartography-gated) + W15 share the slot.
- STRUCTURE dial fires (HL options mainnet) → W1 gets the slot for its launch window, pre-empting the others.
- No dial open → the slot stays in cash and you are *fully invested in patience*.

**Research-only until 3 months of recorded evidence (positions of $0):** W10 probability surface, W13 vol RV pairs, W14 event premium, W16 vault allocation sizing.

## C2. Revised allocation skeleton (desk equity = 100)

| Layer | Range | Hard cap | Notes |
|---|---|---|---|
| W12 cash curve | 30–55 | — | ≤15 in basis-risk bucket (sUSDe-class); ≤20 per issuer |
| Core stack + W5 collars | 25–35 | 40 | collar mandatory above 25 |
| W9 trend program | 15–30 | 35 | per-market vol-targeted; per-deployer cap on HIP-3 |
| Rotational slot | 0–15 | 15 | one occupant; joint stress governs |
| Research book | 0 | 0 | recorders, paper, shadow only |

Binding constraint unchanged: joint stress S1–S5 ≤ 15% of desk equity, enforced by the Malchus veto. Counterparty caps: ≤50% of desk equity net-exposed to the HL ecosystem (including W16 and HIP-3 margin), ≤25% to any single on-chain protocol, ≤35% to Deribit/Coinbase complex.

## C3. The honest expected shape

A book like this targets cash-plus-mid-single-digits in dead regimes (you're living in one), high-teens-to-twenties in trending or high-carry regimes, with the 15% drawdown line defended by construction rather than hope. If that sounds unexciting next to the strategies Part B describes — correct. The exciting version of this desk is the one that doesn't exist in three years.

---

# PART D — NEW AND AMENDED BUILD PROMPTS

Sessions 1–8 from v1 stand with two amendments, then four new sessions. Priority order for the next month: **Session 9 → 1 → 2 → 11**, then 10 and 12 as research capacity allows.

### AMENDMENT to Session 3 & 8 (stress kernel)
```
Extend the scenario set in otzar/optbt and the Malchus joint-stress veto with:
S2 melt-up {BTC +40%, IV x1.5, alt beta 1.3}; S3 correlation-to-one {all trend
and RV positions repriced at single-factor beta, pairwise corr 0.95}; S4
yield-stack break {basis-risk bucket of the cash floor marked -15%, carry
positions gapped against us 300bp}; S5 venue-down {primary venue unreachable
6h during a 20% move; no hedging of open Greeks during the window}. The veto
binds on the WORST of S1–S5, not the average. Add per-counterparty exposure
accounting (HL ecosystem, Deribit complex, per on-chain protocol) with the
caps from MASTER_PLAN_III_v2 Part C2, enforced engine-side.
```

### SESSION 9 — W9: the multi-asset trend program (replaces Session 4's scope)

```
Read JOURNAL.md, the Malchus intent SDK, otzar/regime, and the book-selection
module from Master Plan I. Do not touch live trading.

Build `otzar/cta/`: an ensemble time-series momentum program across HL core
perps AND HIP-3 books (gold, silver, crude, tokenized equity indices and
mega-caps, FX crosses) — target universe 15–25 markets.

1. Universe gating: reuse the book-selector's liquidity/quality scoring to
   admit markets; per-deployer exposure caps (HIP-3 deployer risk is real);
   a market exits the universe automatically if depth/volume decays.
2. Signals: ensemble lookbacks {7,14,28,56,84,168}d, equal-vote, long/flat
   per market (long/short where shorting is sane); add a cross-sectional
   momentum tilt across the crypto subset (top-minus-bottom quartile,
   beta-neutralized) as one additional vote, not a separate book.
3. Sizing: per-market vol targeting using GAP-INCLUSIVE volatility (include
   weekend/session gaps vs underlying reference from Tessera/Pyth — run-53
   lesson); portfolio-level vol target with a correlation-aware aggregator;
   funding-cost-adjusted expected return must be positive for a long to open
   (log funding drag per position explicitly).
4. Execution: weekly rebalance + a mid-week risk-reduce trigger only (no
   mid-week adds); intents through Malchus propose/dispose; 10% no-trade band.
5. Replay over all captured history; then 4+ weeks paper. Report: program
   Sharpe vs per-market Sharpe (the breadth dividend, shown explicitly),
   funding drag, whipsaw cost in the current chop regime, S3 stress result.
6. Wire sleeve P&L and per-market state into the Monday page.

Tests + JOURNAL.md entry. Live flag present, hard-disabled.
```

### SESSION 10 — W10: the probability surface recorder

```
Read JOURNAL.md and tessera/vol. Research module — zero order placement.

Build `tessera/prob/`: a unified event-probability surface across venues.

1. Collectors: Kalshi public API and Polymarket public data for BTC/ETH price
   markets (touch and terminal); HIP-4 outcome market prices via HL API;
   Deribit-implied digitals and barrier-adjusted touch probabilities computed
   from the fitted surface (document the approximation and its error band).
2. Normalize everything to {event spec, expiry, implied probability, venue,
   depth at price, fees-adjusted executable probability}.
3. Gap ledger: log every cross-venue and venue-vs-surface gap that exceeds
   fees + a 2-point buffer, with the depth actually available, capital-lock
   duration to resolution, and the ANNUALIZED locked-capital return — the
   ledger's headline metric (a 5-point gap on a 90-day market is ~4%/yr at
   full lock; print that number, not the 5 points).
4. Weekly report: top persistent gaps, venue-crowd bias patterns (e.g.
   crypto-native vs TradFi venue skew on the same tail event), and the
   surface-vs-crowd divergence on headline strikes.
5. After 3 months of data, we evaluate whether an execution phase is
   justified. Build nothing executable now.

Tests + JOURNAL.md entry.
```

### SESSION 11 — W12: the cash-curve allocator and the loop monitor

```
Read JOURNAL.md and otzar/regime.

1. Build `otzar/cash/`: a config-driven ladder for the desk's idle capital
   across risk buckets {regulated/T-bill-grade, conservative DeFi, fixed-rate
   PT, basis-risk wrappers}, with hard caps per bucket and per issuer from
   the v2 Part C2 table. Output is a PROPOSED rebalance ticket on the Monday
   page — human executes; this module never holds keys or places anything.
2. Hurdle math: maintain the desk's after-tax riskless hurdle rate (config
   values supplied by accountant review) and print every other sleeve's
   regime-gate hurdle as hurdle = after_tax_riskless + risk_spread.
3. The loop monitor (intelligence, not position): track Pendle PT implied
   yields for sUSDe/major markets, total looped PT collateral on Aave, and
   sUSDe 7d/90d trailing yield. Alert on regime signals: PT implied yield
   spiking (funding regime turning ON — wake the W3 gate), loop TVL rapid
   unwind (systemic stress — tighten everything), insurance-fund coverage
   ratio deterioration.
4. Add a build-vs-buy line to the Monday page: own-carry expected net yield
   vs wrapper yield (sUSDe-class), so the rotational-slot decision is a
   printed number, not a vibe.

Tests + JOURNAL.md entry.
```

### SESSION 12 — W2/W15 prerequisite: premium cartography

```
Read JOURNAL.md and tessera/vol (requires several weeks of Session 1 data;
backfill with any obtainable historical surface data first).

Build `otzar/cartography/`: a standing report answering ONE question — where
does option premium still exceed subsequent realized cost in 2026 markets?

1. Grid: {asset: BTC, ETH, SOL, HYPE} x {tenor: 1w, 2w, 1m, 3m} x {region:
   ATM, 25d put wing, 25d call wing} x {venue where multiple exist} x
   {regime state from otzar/regime} x {event vs non-event windows}.
2. For each cell: implied vs subsequently-realized vol spread, a simulated
   delta-hedged short P&L using the Session 3 engine's pessimistic fills,
   sample size, and a crowding proxy (open interest growth, known overwriting
   flow on majors).
3. Output: a heatmap + ranked table of surviving premium pockets with
   honest confidence grades. W2 and W15 are PERMITTED to sell only in cells
   graded B or better with 30+ observations; the executor reads this file
   as its allowlist — encode that contract in code, not convention.
4. Refresh weekly; flag cells whose premium is decaying quarter-over-quarter
   (the institutionalization front advancing — expect it).

Tests + JOURNAL.md entry.
```

---

# CLOSING — what changed between v1 and v2, in one paragraph

v1 found the right ingredients and over-seasoned three of them: it crowned a strategy (HL options MM) whose moat is partly imaginary and whose vega trap is structural; it quoted a premium (VRP) measured before the industry started strip-mining it; and it sized a portfolio for a desk with employees. v2's corrections: the core engine is a twenty-market, 24/7 trend program that exists nowhere else because the venue that makes it possible barely existed two years ago; premium selling becomes a mapping discipline before it is a trading strategy; new market families (probability surfaces, the carry family tree, the yield curve, forced-flow provision) are admitted as recorders first and positions only on evidence; and the whole thing is governed by a 3+1 attention budget and a five-scenario stress veto, because the desk's scarcest asset was never capital — it's one human's calm.
