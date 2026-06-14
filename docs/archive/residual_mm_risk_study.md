# Managing the Losses That Survive a Good Fair-Value Model
### A market-maker's toolkit for basis, trending inventory, residual adverse selection, and hedge cost

Scope: you have already solved top-of-book pick-off (micro-price center + sub-second re-quote) and basic beta-weighted delta hedging. This study targets the four residual leaks you named, ranks the highest-leverage fixes, maps each to your stack (GLFT/AS quoter, F3 toxicity rail, inventory skew + hard cap, beta hedge with $2k dead-band, per-book P&L attribution), and flags where the academic theory and what desks actually do diverge.

---

## 0. One correction before the toolkit: you are measuring the wrong hedge residual

Your headline hedge metric — "neutralizes ~99.8% of gross delta, gross $383k → residual $586" — is a *delta* residual, and delta is not the thing that's bleeding you. Problem #1 (cross-hedge basis) is by construction invisible to a delta metric.

The minimum-variance hedge ratio is the OLS beta:

```
h* = Cov(ΔS_alt, ΔF_major) / Var(ΔF_major) = ρ · (σ_alt / σ_major)
```

After hedging at h*, the variance left on the alt inventory is:

```
Var(residual) = σ_alt² · (1 − ρ²)
```

That `(1 − ρ²)` term is the basis. It is exactly the part a beta hedge *cannot* touch, and your own betas are fit at **R² = 0.5–0.8**. So:

- R² = 0.8 → 20% of inventory variance unhedged → **√0.2 ≈ 45% of the alt's volatility still live** on your book after a "perfect" hedge.
- R² = 0.5 → 50% unhedged → **√0.5 ≈ 71% of the alt's volatility still live.**

A beta-weighted delta of ~0 and a 71%-of-vol-still-live book are fully consistent. The "99.8%" number is true and almost irrelevant to your P&L. **Switch your hedge-quality KPI from residual delta to residual marked-P&L variance per book**, decomposed into (hedged factor variance) vs (idiosyncratic/basis variance). Once you do that, problems #1 and #2 stop looking like separate bugs and start looking like one number you can optimize: residual variance per dollar of spread captured.

This reframe drives the ranking below.

---

## 1. Highest-leverage changes, ranked

These are ordered by expected P&L impact for *your* specific situation (micro-price solved, bleeding on basis + trending inventory).

**#1 — Net correlated inventory across the 8 books before you hedge anything.**
You are running 8 single-instrument controllers that each hedge their own delta to a major. But BTC/ETH/SOL/DOGE/BNB/XRP/ADA/SUI are one correlated portfolio. A net-short SOL in book 3 and a net-long ETH in book 2 partially hedge each other *for free*, with zero taker cost and zero basis tracking error, before any perp leg fires. The multi-asset market-making theory (Bergault–Guéant factor method) says single-asset controllers are simply not "operable" for a correlated book except under the unrealistic assumption that prices are uncorrelated. Concretely: compute one portfolio risk number, hedge only the residual factor exposure, and let correlated inventories offset internally. This is the single biggest lever because it attacks #1 (less gross alt inventory to mark against you), #4 (far less hedge churn and taker cost), and partially #2 at once. See §5.

**#2 — Replace the fixed $2k dead-band with an inventory-dependent internalize-vs-externalize rule.**
A static dead-band is a crude special case of the right object. Barzykin–Bergault–Guéant prove there's an inventory *region* inside which the optimal action is to NOT hedge and instead skew quotes to let client flow flatten you (internalize), and outside which you hedge at a rate that grows with inventory (externalize). The region width scales with your "franchise" (flow rate). Your $2k band is a flat approximation of a band that should breathe with volatility, flow toxicity, and basis. This directly cuts #4 (hedge cost from over-trading the band edges) and improves #2 (you stop paying taker fees to fight noise). See §4.

**#3 — Put a drift/alpha term in the quote center so you stop fighting trends.**
Your micro-price center is a *driftless* fair value. In a trend, a passive maker mechanically accumulates against the move (net short into a rally) because the aggressive side keeps lifting your offers; skew-against-inventory leans you back too slowly because it only reacts to the inventory you've *already* taken. The fix the literature supports is a forward-looking term: add an alpha/drift estimate to the reservation price (Cartea–Jaimungal directional/order-flow models; GLFT with drift), so in an up-trend you raise *both* quotes and widen/pull the offer pre-emptively rather than after you're already short. This is the direct structural answer to #2 and recovers some of #3. See §3.

**#4 — Make the residual basis a first-class cost: basis-vol-scaled spread + basis-aware inventory caps.**
You already price hedge cost (taker + half-spread) back into the maker spread. Extend that: the unhedgeable `√(1−ρ²)·σ_alt` is a *carry cost of holding that name's inventory*, so (i) widen the alt's half-spread by a term proportional to its basis vol, and (ii) make the hard inventory cap *tighter* for high-basis / low-R² names (SUI, DOGE) than for ETH/BTC where you hold the instrument itself. High basis → you get paid more to warehouse it, and you're allowed to warehouse less of it. See §4.

**#5 — Recalibrate adverse-selection measurement to the horizon where it actually saturates, and feed a proper toxicity metric into F3.**
Your F3 rail scales half-spread off a "flow-toxicity window," but two things are probably mis-set: (a) the markout horizon you're judging toxicity on, and (b) the metric. Adverse selection on a passive fill keeps developing well past the millisecond scale — practitioner TCA typically measures to 1-min/5-min and reads off the horizon where the markout curve flattens. And the canonical toxicity metric (VPIN) has a well-documented failure mode you should know before wiring it in. See §2.

Everything below is the detailed version with formulas, citations, your-system mapping, failure modes, and a paper experiment for each.

---

## 2. Adverse selection beyond micro-price

The micro-price fixes *stale-mid* pick-off. It does nothing about the structural fact that **every passive fill has negative expected drift**: you get filled precisely when the aggressor knows something or the book is about to move (Cartea–Jaimungal at-the-touch market making; and explicitly, the "negative drift of a limit-order fill", arXiv 2407.16527). A fill at the front of a deep queue is less toxic than a fill at the back, because back-of-queue orders get executed by *large* (informed) trades that sweep the level. So the residual #3 is real and irreducible to zero — the game is measuring it correctly and pricing/avoiding the worst of it.

### 2.1 Markout curves at the right horizon (measurement first)
- **(a) What / formula.** A markout is the signed mid-move after your fill: for a buy fill at price `p`, `MO(τ) = mid(t+τ) − p` (flip sign for sells). Build the curve `MO(τ)` over `τ ∈ {0.1s, 1s, 5s, 30s, 60s, 5m}`. The level at large τ is your realized adverse selection; the *shape* tells you the horizon over which you're being picked off and therefore how fast you'd need to hedge or scratch.
- **(b) Citation / desk use.** Databento's microstructure guide and Nasdaq's Mackintosh ("What Markouts Are and Why They Don't Always Matter") are the practitioner canon; the key operational point from venue-analysis work (BestEx Research) is that **venues self-report millisecond markouts precisely because short horizons understate adverse selection** — real desks measure to 1-min/5-min and take the horizon where the rate of change goes trivial. QuestDB even ships a markout SQL recipe (`HORIZON JOIN ... RANGE FROM -30s TO 30s STEP 1s`) — and QuestDB is already your hot store, so this is near-zero integration cost.
- **(c) Slots into.** Your P&L attribution already has an "adverse selection (markout)" line — instrument it as a *curve per book*, not a single number, and split by fill side and by queue position at fill. The pre-trade portion (`τ < 0`) tells you if you're reacting to stale signals (information leakage); the post-trade slope is the cost.
- **(d) Failure modes.** Too-short horizon → you'll conclude you're fine and keep bleeding. Too-long → volatility noise swamps the signal and you need far more fills for significance. Markout also conflates adverse selection with your own hedge impact if you compute it on a mid you're moving.
- **(e) Experiment.** Log every fill with `{book, side, fill_price, queue_pos_at_fill, depth_at_level, mid at +{0.1,1,5,30,60,300}s}`. Plot per-book markout curves. Hypothesis to reject: "markout is flat after 1s." If it keeps sloping to 60s, your F3 window is too short and your hedge is too slow.

### 2.2 Flow toxicity / VPIN (with its real caveat)
- **(a) What / formula.** VPIN = order-flow toxicity estimated in *volume time*, not clock time. Bucket trades into equal-volume buckets of size `V`; classify each bucket's buy/sell split (bulk-volume classification uses the standardized price change through a normal CDF rather than the tick rule); then `VPIN = (1/n) Σ |V_buy − V_sell| / V` over the last `n` buckets. High VPIN = one-sided/toxic flow.
- **(b) Citation / desk use.** Easley, López de Prado & O'Hara, "Flow Toxicity and Liquidity in a High-Frequency World" (Review of Financial Studies, 2012) and "The Microstructure of the Flash Crash." The intended use is *exactly your F3*: dynamically widen or withdraw as toxicity rises. **Caveat you must know:** Andersen & Bondarenko (2014) showed VPIN's predictive power is largely a mechanical artifact of trading intensity, that it peaked *after* not before the flash crash on better data, and that bulk-volume classification choices drive the results. Treat VPIN as one input, not gospel.
- **(c) Slots into.** This *is* the signal your F3 half-spread multiplier should consume — but volume-clock VPIN is well suited to crypto's bursty 24/7 flow where clock-time windows are noisy. Compute it off your trades websocket aggressor flow; on Hyperliquid you have real aggressor labels, so you can skip BVC and use true signed volume (cleaner than the equities case the papers had to estimate).
- **(d) Failure modes.** Mechanical correlation with volume (above); parameter sensitivity (bucket size `V`, window `n`); and the asymmetric-cost problem the authors themselves flagged — under-estimating toxicity is far more expensive than over-estimating it, so bias the F3 mapping toward caution.
- **(e) Experiment.** Compute VPIN per book; regress *forward* 1-min markout on current VPIN. If the relationship is real for your venue (not just a volume proxy), gate F3 on it; if VPIN ≈ f(volume) explains your markout just as well, use realized signed-volume imbalance directly and save the complexity.

### 2.3 Trade-informed quote skewing, quote fade, and queue-aware quoting
- **(a) What / intuition.** Beyond widening symmetrically (your F3), *skew*: when aggressor flow is one-sided (buyers lifting), step your offer back and your bid in — you're fading the side that's about to pick you off and improving the side you *want* filled to reduce inventory. Queue-aware quoting decides join-vs-step-ahead-vs-pull from the *value of queue position*: front-of-queue executes against the next (any-size) trade and suffers less adverse selection; back-of-queue executes against large informed sweeps.
- **(b) Citation.** Cartea, Donnelly & Jaimungal, "Enhancing Trading Strategies with Order Book Signals" (Applied Mathematical Finance) — posts at-the-touch sometimes, deeper sometimes, conditioned on order-flow/imbalance. On queue value: the Glosten–Milgrom-to-full-book work (arXiv 1902.10743) formalizes that the difference in value between front and back of a queue is *the* parameter HFT desks race over, precisely because front position reduces adverse-selection risk.
- **(c) Slots into.** You have queue-aware FIFO fills modeled already — so you can *act* on queue position, not just simulate it. Add a rule: if your order has decayed to the back third of a thick queue AND flow is toxic on that side, cancel/re-post rather than wait to be swept. This is the legitimate, passive-CLOB version of "last look" — you don't get a hold-and-reject, but you get **cancel latency** (your honest ~30ms rail) as your only protection window. Use it.
- **(d) Failure modes.** Skewing and fading lowers fill rate → less spread captured; over-fade and you quote yourself out of the market and capture nothing. Cancel/replace churn raises your effective latency exposure and can *worsen* queue position (you go to the back). On Hyperliquid the maker rebate (−0.2bps) rewards resting, so excessive cancellation forfeits rebate.
- **(e) Experiment.** A/B two quoters on the same book/data: baseline F3-symmetric-widen vs F3 + flow-conditioned skew + queue-decay-pull. Compare per-book spread-captured, markout, and fill rate. The win condition is *higher markout-adjusted spread capture*, not higher gross capture.

**Theory-vs-practice flag:** academic at-the-touch models assume a constant LO fill rate independent of price moves; real fills are negatively correlated with the next move (that's the whole problem). Your queue-aware simulator is already more honest than most papers — lean on it.

---

## 3. Inventory management in trending markets (problem #2)

This is where your passive-LP structure fights you: you accumulate *against* the trend and your reactive skew leans back slower than the mark moves. The toolkit has three layers — size the penalty right, skew actively, and add a forward-looking drift term.

### 3.1 Sizing the inventory penalty (AS γ / GLFT risk aversion)
- **(a) Formula.** Avellaneda–Stoikov: reservation price `r = s − q·γ·σ²·(T−t)`; total optimal spread `δ_a + δ_b = γσ²(T−t) + (2/γ)·ln(1 + γ/k)`. The first term is the inventory-risk premium, the second is the competitive/market term. GLFT gives the closed-form steady-state (infinite-horizon) version you're using, where the symmetric half-spread `≈ (1/γ)ln(1+γ/k)` is inventory-independent and the *skew* component scales like `√(σ²γ/(kA))` and is roughly linear in `q`. The single knob that controls "how hard do I lean against inventory" is `γ` (and equivalently the Cartea–Jaimungal running penalty `φ`; note these are not independent — `φ ≈ ½γσ²` ties them).
- **(b) Citation / desk use.** Avellaneda & Stoikov (2008, Quantitative Finance 8:3); Guéant, Lehalle & Fernandez-Tapia (2013, Math. Finan. Econ. 7). Practitioner translation: Hummingbot's `avellaneda_market_making` exposes `risk_factor` (γ) directly and auto-fits κ/A from the book; their docs are a clean reference for the 24/7-crypto adaptation (the infinite-horizon variant, since crypto has no close).
- **(c) Slots into.** Your inventory-skew multiplier *is* the AS/GLFT skew term. Make `γ` (or the multiplier) a function of regime: raise it in trending/toxic regimes so the book leans back harder and caps tighter; lower it in calm regimes to capture more spread. This is the parameter the regime detector in §5 switches.
- **(d) Failure modes.** Too-high γ → you quote so defensively you capture no spread and still take inventory because the *other* side fills; in a strong trend a higher γ alone still loses because skew is reactive. AS with no inventory bound (unlike GLFT's hard `[−Q,Q]`) can let inventory run; you have the hard 25% cap, keep it.
- **(e) Experiment.** Sweep γ across {calm, trending, toxic} historical windows; for each, record terminal inventory distribution, spread-captured, and inventory-carry P&L. You're looking for the γ that minimizes inventory-carry loss *per unit spread captured* in trending windows specifically — not the global optimum.

### 3.2 Drift-aware / directional quoting — the actual fix for "fighting the trend"
- **(a) What / intuition.** Add a midprice drift estimate `μ` to the reservation price: `r = s + (drift term in μ) − q·γ·σ²·(T−t)`. The market-making-with-directional-bets extension (Fodra–Labadie; Cartea–Jaimungal with ambiguity aversion to drift) places *asymmetric* quotes that favor getting hit on the side that reduces your trend-exposure. In an up-trend you lift both quotes and pull the offer earlier — so you stop selling into the rally before you're short, instead of skewing back after.
- **(b) Citation.** "High-frequency market-making with inventory constraints and directional bets" (arXiv 1206.4810) is the direct extension; Cartea, Jaimungal & Ricci "Buy Low, Sell High" and Cartea–Donnelly–Jaimungal "Algorithmic trading with model uncertainty" formalize drift/ambiguity. Cartea–Wang "Market Making with Alpha Signals" gives the HJB with an explicit alpha state `α`. Open-source: `hftbacktest` has a runnable "Market Making with Alpha — Order Book Imbalance" tutorial on BTCUSDT with realistic queue/latency and maker rebate (`−0.00005`), which is close to your setup.
- **(c) Slots into.** New input to the quote center: a short-horizon drift/alpha signal (order-book imbalance momentum, signed-trade EWMA, or your micro-price *velocity*). Feed it as an additive shift to the reservation price and as a multiplier that pulls the against-trend quote. This is a *new component* between your micro-price center and your skew stage.
- **(d) Failure modes.** This is the dangerous one: a drift term turns a market maker into a *directional trader*. A wrong/whipsaw signal makes you cross the spread to chase and you pay taker fees to lose. Mean-reverting microstructure noise will fake trends at short horizons. Keep the drift term small relative to the spread, cap its inventory effect, and never let it override the hard cap.
- **(e) Experiment.** Add drift as a *gated* term (on only when |signal| > threshold and toxicity confirms a real move). Compare trending-window P&L vs your reactive-skew-only baseline. Measure the new failure cost explicitly: P&L on windows where the drift signal was wrong. If that tail cost > the trending-window gain, the signal isn't good enough — ship it off.

### 3.3 Max-adverse-inventory stop-and-flatten, and cross-vs-wait
- **(a) What / mechanism.** Two distinct rules. (i) *Stop-and-flatten*: a hard rule that when inventory hits the cap AND the mark is moving against you at rate > threshold, you cross the spread with a taker leg to flatten rather than keep skewing. (ii) *Cross-vs-wait*: the continuous version — Barzykin–Bergault–Guéant's internalize/externalize threshold (§4) *is* the optimal "do I cross now or wait for flow" rule; below the threshold you wait (skew), above it you hedge/flatten at an inventory-proportional rate.
- **(b) Citation.** Barzykin, Bergault & Guéant, "Market making by an FX dealer" (arXiv 2112.02269) and "Algorithmic market making in dealer markets with hedging and market impact" (Mathematical Finance, 2023). The proven result: a *pure-internalization region* exists — an inventory band where not hedging is optimal — outside which you externalize to pull inventory back toward zero.
- **(c) Slots into.** Replaces your "hold until cap, then refuse more inventory" logic with "hold until threshold, then *actively flatten* at a rate that scales with how far past threshold you are." The cap stays as a hard backstop; the threshold is a soft, dynamic inner band.
- **(d) Failure modes.** Stop-and-flatten in a fast trend means you cross at the worst possible time (you realize the loss at the local extreme) — this is the classic "stopped out at the bottom." It caps tail loss at the cost of locking in adverse selection. Tune the threshold so you flatten on *persistent* adverse moves, not spikes.
- **(e) Experiment.** On your worst historical trending book, compare: (A) skew-only-to-cap, (B) stop-and-flatten at cap, (C) continuous internalize/externalize threshold. Plot the inventory-path and the P&L tail (5th percentile). C should dominate on tail risk per unit cost.

---

## 4. Hedging & basis (problems #1 and #4)

### 4.1 Hedge the name with itself when you can; price the basis when you can't
- **(a) Intuition.** Cross-hedging an alt with a major is a *choice you make to save cost*, and its price is the `(1−ρ²)σ²` residual. The decision rule: hedge an alt with its own perp when (own-instrument liquidity & fees) < (basis variance cost of proxy hedging). Hyperliquid lists perps for all 8 of your names — so for SOL/DOGE/XRP you can often hedge the name directly and eliminate basis entirely, at the cost of more taker legs.
- **(b) Citation.** Minimum-variance hedging is textbook (Ederington 1979; the OHR literature). The "measuring MV hedging effectiveness" review (ScienceDirect, 2023) is a clean survey of OLS vs sophisticated estimators and — importantly — finds the fancy estimators often *don't* beat OLS economically. So don't over-engineer the estimator before you've fixed the instrument choice.
- **(c) Slots into.** Your beta-map stage gets a per-name switch: `hedge_with ∈ {own_perp, major_proxy}`, chosen by a cost comparison you compute from live fees + measured basis vol. For high-R² alts that co-move tightly with ETH (and where you also hold ETH inventory to net against), proxy-hedge; for low-R² names, hedge the name or just hold less of it.
- **(d) Failure modes.** Hedging every name with itself maximizes taker cost and defeats the netting benefit of §5. There's a genuine tension: own-instrument hedging kills basis but kills netting; proxy hedging enables netting but eats basis. The portfolio approach (§5) resolves it — net first, then hedge the residual factor, then only direct-hedge the names whose idiosyncratic residual is still too big.
- **(e) Experiment.** For each alt, compute realized basis-vol cost of proxy-hedging vs realized taker cost of self-hedging over the capture window. Rank names; self-hedge the ones where basis cost > taker cost.

### 4.2 Dynamic beta: Kalman/EWMA vs static OLS
- **(a) Formula.** Static OLS beta over 30d hourly is a fixed `h`. A Kalman filter treats beta as a hidden random walk `β_t = β_{t−1} + w_t`, observation `r_alt,t = β_t·r_major,t + e_t`, and updates `β_t` every bar — adapting fast without a lookback-window cliff. EWMA covariance is the cheap middle ground: `β_t = Cov_ewma(ΔS,ΔF)/Var_ewma(ΔF)` with decay λ.
- **(b) Citation.** QuantStart and Palomar's *Portfolio Optimization* (ch. 15.6) both show Kalman hedge ratios are far smoother and more adaptive than rolling-OLS (which is "very noisy, wildly varying" with short windows). But the hedging-effectiveness literature (ScienceDirect 2023; and the constant/time-varying/Kalman comparison, ResearchGate 2006) repeatedly finds the *economic* gain over OLS is small once you account for transaction cost of re-hedging to a jittery beta.
- **(c) Slots into.** Replace the 30d-static OLS in your beta-map with an EWMA or Kalman beta updated intraday. This matters most for alts whose beta to ETH genuinely drifts (regime-dependent correlation — crypto betas spike toward 1 in risk-off flushes and decompress in alt seasons). A static 30d beta will be systematically wrong exactly when it matters (regime breaks).
- **(d) Failure modes.** A jittery beta makes you re-hedge constantly → straight into problem #4 (hedge churn cost). The Kalman process/observation covariance ratio is a hidden tuning knob that's easy to overfit. EWMA λ too fast = noise, too slow = stale. And per the literature, you may spend real fees chasing a beta improvement that doesn't pay.
- **(e) Experiment.** Backtest three beta estimators (static-30d-OLS, EWMA, Kalman) on the *residual P&L variance* metric from §0, net of the extra hedge transaction cost each one induces. Win condition: lower residual-variance-minus-hedge-cost. Expect Kalman to win on tracking but possibly lose on cost — that's the real trade-off, not a foregone conclusion.

### 4.3 Cointegration-aware hedging
- **(a) Intuition.** Beta hedging matches *returns*; cointegration matches *levels*. If alt and major are cointegrated, the basis (spread) is mean-reverting, and you can hedge the level relationship (Johansen/Engle-Granger hedge ratio) and even *expect* the basis to revert rather than treating it as pure noise. The Kalman-on-cointegration-coefficients approach (random-walk state on the cointegrating vector) unifies 4.2 and 4.3.
- **(b) Citation.** Pairs-trading / cointegration hedge-ratio literature (Palomar ch. 15; the Kalman-cointegration pairs work). Note the OHR critique: ignoring cointegration biases the OLS hedge ratio.
- **(c) Slots into.** Mostly relevant if you want to hold basis *as a position* (expecting reversion) rather than minimize its variance. For a market maker that's a strategy change, not a hedge tweak — flag it as optional/advanced.
- **(d) Failure modes.** Cointegration relationships break (the KO/PEP example in Palomar shows pairs that *look* cointegrated aren't). Betting on basis reversion when the relationship has structurally broken (e.g., a name de-pegs from the complex) is how cointegration strategies blow up.
- **(e) Experiment.** Test cointegration (Johansen) on each alt/major pair on rolling windows; only the stably-cointegrated pairs are candidates for level-hedging. Most crypto alt/BTC pairs will fail stability — that's a useful negative result.

### 4.4 Hedge cadence & dead-band sizing (problem #4 directly)
- **(a) Mechanism.** The dead-band trades off tracking error (band too wide → residual delta drifts) against transaction cost (band too narrow → you churn the perp leg paying taker + half-spread every wiggle). The optimal band is *not* a fixed dollar amount — it widens with hedge cost and the asset's own mean-reversion, and narrows with volatility and basis.
- **(b) Citation.** Barzykin–Bergault–Guéant again: the no-hedge region width is increasing in flow/franchise and the model gives the optimal hedging *rate* as a function of inventory, not a binary band. Butz & Oomen, "Internalisation by electronic FX spot dealers" (Quantitative Finance, 2019) is the practitioner-facing companion on how spot dealers actually set this.
- **(c) Slots into.** Replace `$2k fixed dead-band` with `band(σ, hedge_cost, toxicity)`. Inside the band, hedge rate = 0 (pure skew/internalize). Outside, hedge rate rises with distance past the band. This is the same object as §3.3's cross-vs-wait — implement once, use for both.
- **(d) Failure modes.** A volatility-scaled band can balloon in a vol spike exactly when you most want to be hedged; cap the band. An adaptive band is another thing to overfit.
- **(e) Experiment.** Sweep band width (and adaptive vs fixed) on the hedge-cost vs residual-delta-variance frontier. You'll get an efficient frontier; pick the point matching your risk tolerance. This is the cleanest single experiment for problem #4.

---

## 5. Portfolio-level: treat the 8 books as one correlated book

This is lever #1 and deserves its own section because it's the structural change with the biggest payoff and the most code impact.

### 5.1 Net inventory across correlated names before hedging
- **(a) Mechanism.** Maintain one portfolio inventory vector `q = (q_BTC, …, q_SUI)` and a covariance matrix `Σ`. The portfolio risk is `qᵀΣq`. Your *net factor exposure* (project `q` onto BTC/ETH factors) is what you hedge; correlated idiosyncratic positions that offset (long ETH-beta in one name, short in another) net out for free with no taker cost and no basis. Bergault–Guéant's factor method reduces the otherwise curse-of-dimensionality multi-asset problem to a tractable low-rank form precisely so this is computable in real time.
- **(b) Citation.** Bergault, Evangelista, Guéant & Vieira, "Closed-form approximations in multi-asset market making" (Applied Mathematical Finance, 2021; arXiv 1810.04383); Bergault & Guéant, "Size matters for OTC market makers… dimensionality reduction" (Math. Finance, 2021). Guéant's own summary of the portfolio-level FX work: a portfolio model means clients get better prices and *less market footprint because there is less externalisation* — i.e., netting reduces how much you have to hedge externally. That is exactly your #1/#4 win, stated by the people who proved it.
- **(c) Slots into.** Architecturally significant: today you have 8 independent controllers + 8 hedge legs. You'd add a **portfolio risk layer** that (i) aggregates inventory into `q`, (ii) holds live `Σ` (EWMA/Kalman), (iii) computes net factor delta, (iv) issues *one* hedge instruction for the residual factor exposure instead of 8 per-book hedges. Your per-book quoters still set quotes locally, but their inventory-skew `γ` term reads the *portfolio* risk contribution `(Σq)_i`, not just local `q_i` — so a name that adds diversifying inventory is skewed *less* than one that piles onto an existing factor bet.
- **(d) Failure modes.** Correlations are unstable and spike to 1 in crashes (diversification evaporates exactly when you need it) — so a portfolio that looks netted in calm markets can be a concentrated factor bet in a flush. `Σ` estimation error compounds across 8 names. And a portfolio layer is a single point of failure / added latency on the hot path. Mitigate with correlation-stress-tested caps (next).
- **(e) Experiment.** Replay your 8-book capture twice: (A) 8 independent hedgers (current), (B) portfolio-netted single residual hedge. Compare total taker cost, total residual P&L variance, and gross hedge notional. Expect a large drop in hedge notional and cost in (B); the variance comparison tells you whether netting held up through any trending/toxic sub-windows.

### 5.2 Correlation-aware inventory caps
- **(a) Mechanism.** Replace 8 independent 25%-notional caps with a portfolio risk cap: limit `qᵀΣq` (or factor-VaR), plus per-name caps that *tighten* when a name is correlated with inventory you already hold. Holding $250k short SOL and then accumulating short ETH is one concentrated factor short, not two diversified positions — the cap should see that.
- **(b) Citation.** Implied by the multi-asset framework above; in practice this is portfolio risk-budgeting applied to MM inventory.
- **(c) Slots into.** The hard-cap check changes from per-book scalar to a portfolio constraint evaluated on every fill. Per-name caps become a function of current portfolio composition.
- **(d) Failure modes.** Same correlation-instability problem; a cap built on calm-market `Σ` is too loose in a regime break. Use stressed `Σ` (or correlation → high) for the cap even while using live `Σ` for hedging.
- **(e) Experiment.** Measure how often your independent per-book caps allowed a portfolio position that a factor-VaR cap would have blocked, and what those positions did to P&L. That frequency × loss is the value of the change.

### 5.3 Regime detection and parameter switching
- **(a) Mechanism.** Classify the current regime — calm / trending / toxic — from {realized vol, signed-flow autocorrelation (trend), VPIN or signed-volume imbalance (toxic)} and switch quoter params: calm → tight spread, low γ, wide hedge band; trending → drift term on, tighter caps, more skew; toxic → F3 wide, pull stale queue positions, tighten caps. A Hidden Markov Model over these features is the standard formalization (used in the Kalman+HMM pairs work).
- **(b) Citation.** HMM regime detection is standard; the MM-specific hook is that AS/GLFT params are only optimal *conditional on a regime* (vol σ and arrival A,k differ by regime), so a single static parameter set is misspecified most of the time.
- **(c) Slots into.** A regime classifier feeding the parameter sets of every component above (γ, F3 mapping, drift gate, cap multiplier, hedge band). This is the "one knob that moves all knobs."
- **(d) Failure modes.** Regime mis-classification and *lag* (you detect the trend after it's over); whipsaw at regime boundaries thrashing your parameters. Keep transitions hysteretic (sticky) so you don't flip-flop.
- **(e) Experiment.** Label historical windows by regime; show that per-regime-optimal params beat global-optimal params out-of-sample. If they don't beat it net of switching cost, your regime signal is too laggy.

---

## 6. Tooling: what real crypto MM desks run, and open-source you can lift

- **Markout dashboards.** QuestDB ships a post-trade markout SQL recipe (HORIZON JOIN over a ±range with per-second steps) — and it's your hot store, so per-book markout curves are a query, not a project. Databento's microstructure guide is the reference for markout/TCA definitions.
- **Toxicity monitors.** `VisualHFT` (open-source, MIT) implements VPIN, order-flow imbalance, and LOB depth metrics as live dashboards — a ready reference implementation for the F3 input in §2.
- **Backtesting with honest fills.** `hftbacktest` (open-source) does queue-position + intra-order latency + maker-rebate modeling on crypto data — the closest open tool to your queue-aware FIFO + 30ms cancel/replace simulator, and it has a runnable order-book-imbalance alpha-MM tutorial. Use it to cross-check your own paper-fill engine.
- **Quoter reference.** Hummingbot's `avellaneda_market_making` (and the older `pure_market_making` with `inventory_skew_enabled` / `inventory_target_base_pct`) is the canonical open-source AS/inventory-skew implementation with the 24/7-crypto (infinite-horizon) adaptation spelled out in their docs — good for sanity-checking your GLFT/AS math against a known-working version.
- **Real-time Greeks/exposure.** This is where desks build proprietary; the portfolio layer in §5 (inventory vector `q`, live `Σ`, factor projection) *is* your real-time exposure system. No good open-source standard exists; QuestDB + Polars (both already in your Tessera stack) are the right substrate.

---

## 7. Where the academic theory diverges from what desks actually do (consolidated)

1. **Constant fill rate.** AS/GLFT assume LO fill intensity is independent of price moves. Reality: fills are negatively correlated with the next move (adverse selection is the *whole* problem). Desks bolt markout/toxicity adjustments onto the optimal quotes because the base model can't see this. Your queue-aware simulator already beats the academic assumption — don't regress to it.
2. **Terminal time `T`.** AS is a finite-horizon "end the day flat" model. Crypto is 24/7; the GLFT infinite-horizon variant (what Hummingbot uses) is the right one. Anyone quoting AS with a `(T−t)` term in crypto is using the wrong model.
3. **Pure internalizer.** Almost all MM models assume you only quote and wait. Real desks hedge externally. The Barzykin–Bergault–Guéant internalize/externalize work is the rare model that matches desk reality — and it's recent (2021–23), which tells you how long the gap persisted.
4. **VPIN.** Celebrated in the 2010–2012 papers, substantially debunked as a predictor by Andersen–Bondarenko (2014) (mechanical volume artifact). Desks use *a* toxicity signal; few trust VPIN specifically. Use realized signed-volume imbalance as a baseline and only add VPIN if it beats it on your data.
5. **Fancy hedge-ratio estimators.** The literature repeatedly finds Kalman/GARCH OHR estimators don't reliably beat OLS *economically* once you charge for the extra re-hedging. Theory loves them; the cost-benefit is often a wash. Test, don't assume.
6. **Optimal γ.** Papers treat γ as a given preference parameter. Desks don't have a "true" γ — they tune it per regime against realized P&L. Your regime-switching γ is more honest than the single-γ models.

---

## 8. Suggested experiment sequence (and what to capture)

Do these in order; each gates the next.

1. **Re-baseline the KPI.** Implement residual-P&L-variance-per-book and factor/idiosyncratic decomposition (§0). Until this exists you can't tell if any change below helped. *One day of work, unblocks everything.*
2. **Markout curves per book, per side, per queue position** (§2.1). Establishes the true adverse-selection horizon and whether F3's window/horizon is mis-set.
3. **Portfolio netting replay** (§5.1) — the highest-leverage single test. Replay current capture as 8-independent vs portfolio-netted; measure hedge notional, taker cost, residual variance.
4. **Hedge band / cadence frontier** (§4.4) and **internalize-vs-externalize threshold** (§3.3) — same object, one experiment.
5. **Drift-aware quoting, gated** (§3.2) — only after 1–4, because it's the one that can turn you directional and lose money; you want the clean baseline first.
6. **Beta estimator bake-off** (§4.2) and **self-vs-proxy hedge per name** (§4.1).

**On your closing question — yes, kick off the longer capture, and capture this specifically** so the dataset can actually validate the above rather than just being more P&L:

- Per fill: `timestamp, book, side, fill_price, our_quote_at_fill, queue_pos_at_fill, depth_at_level, micro_price, mid` and the **mid at +{0.1, 1, 5, 30, 60, 300}s** (markout curve raw material).
- Per book, continuous: `inventory path, skew applied, F3 multiplier, realized vol, signed-volume imbalance, VPIN`.
- Per alt: `own-perp mid, major-proxy mid, rolling beta (all three estimators), realized basis series`.
- Portfolio, continuous: `inventory vector q, live Σ, net factor delta, every hedge order (venue leg, size, taker cost, slippage)`.
- P&L attribution stamped at fill granularity, not just end-of-run, with the §0 factor/idiosyncratic split.

That gives you markouts-per-horizon, inventory paths, and basis moves keyed to every decision — enough to run experiments 1–6 as offline replays before you touch the live quoter.

---

## References (primary first)

- Avellaneda, M. & Stoikov, S. (2008). *High-frequency trading in a limit order book.* Quantitative Finance 8(3), 217–224.
- Guéant, O., Lehalle, C.-A. & Fernandez-Tapia, J. (2013). *Dealing with the inventory risk: a solution to the market making problem.* Mathematics and Financial Economics 7(4), 477–507. arXiv:1105.3115.
- Guéant, O. (2016). *The Financial Mathematics of Market Liquidity: From Optimal Execution to Market Making.* CRC Press.
- Bergault, P., Evangelista, D., Guéant, O. & Vieira, D. (2021). *Closed-form approximations in multi-asset market making.* Applied Mathematical Finance 28(2), 101–142. arXiv:1810.04383.
- Bergault, P. & Guéant, O. (2021). *Size matters for OTC market makers: general results and dimensionality reduction techniques.* Mathematical Finance 31(1), 279–322. arXiv:1907.01225.
- Barzykin, A., Bergault, P. & Guéant, O. (2022). *Market making by an FX dealer: tiers, pricing ladders and hedging rates for optimal risk control.* arXiv:2112.02269.
- Barzykin, A., Bergault, P. & Guéant, O. (2023). *Algorithmic market making in dealer markets with hedging and market impact.* Mathematical Finance. arXiv:2106.06974.
- Easley, D., López de Prado, M. & O'Hara, M. (2012). *Flow Toxicity and Liquidity in a High-Frequency World.* Review of Financial Studies 25(5), 1457–1493. (VPIN)
- Easley, D., López de Prado, M. & O'Hara, M. (2011). *The Microstructure of the 'Flash Crash'.* Journal of Portfolio Management 37(2).
- Andersen, T. & Bondarenko, O. (2014). *VPIN and the flash crash.* Journal of Financial Markets. (VPIN critique)
- Cartea, Á., Donnelly, R. & Jaimungal, S. (2018). *Enhancing trading strategies with order book signals.* Applied Mathematical Finance.
- Cartea, Á. & Wang, Y. *Market Making with Alpha Signals.* (Oxford-Man Institute working paper.)
- Cartea, Á., Jaimungal, S. & Penalva, J. (2015). *Algorithmic and High-Frequency Trading.* Cambridge University Press.
- Fodra, P. & Labadie, M. (2012). *High-frequency market-making with inventory constraints and directional bets.* arXiv:1206.4810.
- Butz, M. & Oomen, R. (2019). *Internalisation by electronic FX spot dealers.* Quantitative Finance 19(1), 35–56.
- Ho, T. & Stoll, H. (1981). *Optimal dealer pricing under transactions and return uncertainty.* Journal of Financial Economics 9(1), 47–73.
- *The Negative Drift of a Limit Order Fill.* arXiv:2407.16527.
- From Glosten-Milgrom to the whole limit order book — queue-position value. arXiv:1902.10743.

Practitioner / tooling: Databento Microstructure Guide (markouts); QuestDB markout SQL cookbook; BestEx Research on markout horizons; Nasdaq / P. Mackintosh on markouts; Hummingbot AS strategy docs & source; VisualHFT (VPIN/OFI dashboards); hftbacktest (queue/latency-aware crypto backtester); Crypto Chassis, "Defensive Market Making Against Market Manipulators."
