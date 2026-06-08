# Appendix B — Source notebook

Every citation in the course resolves here. Sources are organised by topic (B.1 through B.7) and tiered A/B/C per the rule in [§0.2](00-charter-and-sources.md#02-the-source-tiering-rule). Each entry carries a full citation, a paragraph explaining *why* the source is load-bearing (or, where the source is interesting but not load-bearing, an honest note saying so), and a tag the chapters use to cite back. Sister entries in [the stat-arb course's Appendix B](../../stat-arb/docs/appendix-b-sources.md) cover overlap (Almgren-Chriss, López de Prado, the Jorion VaR reference) and are not duplicated here unless market-making-specific framing changes the annotation.

The source-collection method is in [§0.3](00-charter-and-sources.md#03-source-collection-method). The seven canonical papers a reader must skim are named in [§0.4](00-charter-and-sources.md#04-the-canonical-market-making-papers-you-must-read).

## B.1 Microstructure foundations — Tier A

The foundational layer. Every market-making result above the microstructure level — Avellaneda-Stoikov, Guéant-Lehalle, VPIN-based gating — rests on the spread decomposition these six papers establish. If a chapter cites "the adverse-selection component of the spread" it is citing this group; if it cites "the inventory component" it is citing this group; the operational extensions in B.2 are downstream.

**R84 — Roll (1984).** Roll, R. (1984). *A Simple Implicit Measure of the Effective Bid-Ask Spread in an Efficient Market.* Journal of Finance, 39(4), 1127–1139.

**Tier A.** The first published derivation of an effective-spread estimator from transaction prices alone, assuming an efficient market and independent order flow. The Roll estimator says that under uninformed flow the serial covariance of transaction-price changes equals $-s^2 / 4$, so $s = 2\sqrt{-\text{cov}(\Delta p_t, \Delta p_{t-1})}$. The paper is load-bearing for [§2.5](02-microstructure.md), where the Roll estimator anchors the "what the spread *would* be in a Glosten-Milgrom world with no informed trading" baseline. Roll is also a useful corrective against the modern habit of believing the quoted spread *is* the effective spread — in practice the effective spread is wider than Roll's estimate because flow is not independent, and the gap is the GM85 adverse-selection component.

**GM85 — Glosten & Milgrom (1985).** Glosten, L. R., & Milgrom, P. R. (1985). *Bid, Ask and Transaction Prices in a Specialist Market with Heterogeneously Informed Traders.* Journal of Financial Economics, 14(1), 71–100.

**Tier A.** *The* paper on adverse selection. Models the market maker as a Bayesian who quotes a bid and ask such that, given the conditional probability that the next order comes from an informed trader, the expected loss to informed flow equals the expected gain from uninformed flow. The result is that the bid-ask spread exists *even with zero inventory cost and zero order-processing cost* whenever the maker faces an asymmetric-information environment. Load-bearing for [§1.1](01-introduction.md) (the definition of the three spread components), [§2.6](02-microstructure.md) (the spread decomposition), and [§5.4](05-risk.md) (the adverse-selection circuit breaker). The single most-cited paper in the course; read sections 2 and 3 carefully, the remaining proofs of comparative statics are skip-readable.

**K85 — Kyle (1985).** Kyle, A. S. (1985). *Continuous Auctions and Insider Trading.* Econometrica, 53(6), 1315–1335.

**Tier A.** The model of how a single informed trader's order flow moves price, derived in a sequential-auction setting with a strategic informed trader, noise traders, and a competitive market maker. The result that gives the field the term *Kyle's lambda* — the linear price-impact coefficient $\lambda = \sigma_v / (2 \sigma_u)$, where $\sigma_v$ is the standard deviation of the asset's fundamental value and $\sigma_u$ the standard deviation of noise-trade volume. Load-bearing for [§2.6](02-microstructure.md), where Kyle's $\lambda$ is the practitioner-grade calibration of adverse selection cost per unit volume, and for [§5.4](05-risk.md), where the per-fill markout against $\lambda \cdot v$ is the standard reference point for "did this fill turn out toxic?" Read section 2 carefully; sections 3 and 4 are extensions.

**S78 — Stoll (1978).** Stoll, H. R. (1978). *The Supply of Dealer Services in Securities Markets.* Journal of Finance, 33(4), 1133–1151.

**Tier A.** The early dealer-inventory model. Stoll derives a spread that compensates the dealer for the *risk* of holding inventory in a stochastic-price environment, with no informational asymmetry — pure inventory risk. The result is a half-spread proportional to $\sigma^2 \cdot |q|$, which is structurally what Avellaneda-Stoikov rederives twenty-five years later in a more general setting. Load-bearing for [§2.6](02-microstructure.md) (the inventory component of the spread decomposition) and for the historical framing in [§3.1](03-avellaneda-stoikov.md) (where the AS08 result comes from). Read the introduction and section 2; the rest is comparative statics.

**H91 — Hasbrouck (1991).** Hasbrouck, J. (1991). *Measuring the Information Content of Stock Trades.* Journal of Finance, 46(1), 179–207.

**Tier A.** The empirical-microstructure-econometrics paper that operationalises GM85 with real data. Hasbrouck fits a vector-autoregression to signed trades and quote revisions and reads off the long-run impact of a unit-size trade — that long-run impact is the empirical analogue of the GM85 information content. Load-bearing for [§2.7](02-microstructure.md) (the markout-horizon discussion — Hasbrouck's VAR justifies looking at long-horizon mid moves, not just the next-trade move) and for the markout-window choice in [§6.6](06-backtesting.md). The paper is also a useful sanity check on the post-fill mid-drift methodology that practitioners often confuse with adverse selection; Hasbrouck draws the line between the two cleanly.

**HS81 — Ho & Stoll (1981).** Ho, T., & Stoll, H. R. (1981). *Optimal Dealer Pricing under Transactions and Return Uncertainty.* Journal of Financial Economics, 9(1), 47–73.

**Tier A.** The foundational *inventory-aware quoting* paper. Ho-Stoll set up the dealer's problem as an optimal-control problem: maximise expected terminal wealth subject to inventory drift, return uncertainty, and an exponential utility. The result — bid and ask quotes that skew away from inventory in proportion to risk aversion times variance times inventory — is structurally the Avellaneda-Stoikov result, twenty-seven years earlier, in a simpler setup. Load-bearing for [§3.1](03-avellaneda-stoikov.md) (the historical framing) and [§3.3](03-avellaneda-stoikov.md) (the comparison: where AS08 generalises HS81 and where it doesn't). Read section 2 and section 3; the rest is special cases.

## B.2 Inventory-aware quoting — Tier A

The modern operational layer. These are the four papers a junior quoter is expected to have read on day one of an interview process. Together they give the closed-form quotes, the infinite-horizon fix, the textbook synthesis, and the option-pricing-aware extension.

**AS08 — Avellaneda & Stoikov (2008).** Avellaneda, M., & Stoikov, S. (2008). *High-Frequency Trading in a Limit Order Book.* Quantitative Finance, 8(3), 217–224.

**Tier A.** The closed-form inventory-aware quoter the entire course is built around. AS08 sets up the market maker's problem as a Hamilton-Jacobi-Bellman optimisation with mean-zero mid-price diffusion, exponential utility with risk-aversion $\gamma$, and Poisson order-arrival intensities $\lambda^{a,b}(\delta) = A \exp(-k \delta)$. Solving the HJB equation under the linear-utility approximation gives the reservation price $r = s - q \gamma \sigma^2 (T-t)$ and the optimal half-spread $\delta^a + \delta^b = \gamma \sigma^2 (T-t) + (2/\gamma) \ln(1 + \gamma/k)$. Load-bearing for *all of [§3](03-avellaneda-stoikov.md)*, the code shape in [Appendix A.4](appendix-a-code-shapes.md#a4-avellanedastoikovquoter), and the calibration in [§5.6](05-risk.md). Read end-to-end at least twice — once to follow the derivation, once after implementing the quoter to recognise which assumptions you're now relying on.

**GLFT13 — Guéant, Lehalle & Fernandez-Tapia (2013).** Guéant, O., Lehalle, C.-A., & Fernandez-Tapia, J. (2013). *Dealing with the Inventory Risk: A Solution to the Market Making Problem.* Mathematics and Financial Economics, 7(4), 477–507.

**Tier A.** The fix to AS08's "terminal time $T$" awkwardness. Real market makers do not have a known horizon at which they want to be flat; GLFT13 takes the infinite-horizon asymptotic of the AS08 problem under an inventory-penalty term, recovers closed-form quotes that depend only on the *current* inventory (not on $T - t$), and shows that the asymptotic quotes are the ones practitioners actually use. Load-bearing for [§3.5](03-avellaneda-stoikov.md), where the infinite-horizon variant of the quoter is the production-grade form. The paper also has the cleanest treatment of the *boundary conditions* — what happens at maximum inventory, where the quoter should refuse to lean further into a one-sided position. Read sections 2 through 4; section 5 onward is extensions.

**CJP15 — Cartea, Jaimungal & Penalva (2015).** Cartea, Á., Jaimungal, S., & Penalva, J. (2015). *Algorithmic and High-Frequency Trading.* Cambridge University Press.

**Tier A.** The textbook synthesis. CJP15 covers GM85, K85, HS81, AS08, GLFT13, and the volatility-aware extensions in a single notation, with worked examples that fill in the steps the papers gloss over. The honourable exception to "market-making textbooks ship no code" — the book includes pseudocode for every model it derives. Load-bearing as the *reference treatment* for [§2 through §5](02-microstructure.md); when this course departs from CJP15 (the few places we do — the four-component P&L attribution in [§6.5](06-backtesting.md) is one), we say why. Read cover-to-cover if you read only one book on the course's reading list; the rest are reference-as-needed.

**SS09 — Stoikov & Saglam (2009).** Stoikov, S., & Saglam, M. (2009). *Option Market Making under Inventory Risk.* Review of Derivatives Research, 12(1), 55–79.

**Tier A.** The cleanest treatment in the literature of *how to calibrate $\gamma$* — the risk-aversion parameter that AS08 leaves as a free dial. Stoikov-Saglam derive the option-market-making variant of AS08, where the quoted instrument's volatility itself is stochastic, and in the process give an explicit recipe for picking $\gamma$ from observable utility-of-wealth considerations rather than hand-waving. Load-bearing for [§3.7](03-avellaneda-stoikov.md) (calibration) and [§5.6](05-risk.md) (the risk-budget framing of $\gamma$). The option-specific machinery in the rest of the paper is not relevant to spot market making but is the natural extension for any reader who wants to take the course material into the options world.

## B.3 Order flow & queue — Tier A / B

Where the quote meets the queue. Two papers on queue position and one on toxic flow, plus the influential critique that limits how seriously to take VPIN.

**CST10 — Cont, Stoikov & Talreja (2010).** Cont, R., Stoikov, S., & Talreja, R. (2010). *A Stochastic Model for Order Book Dynamics.* Operations Research, 58(3), 549–563.

**Tier A.** The canonical stochastic model of the limit order book. Cont-Stoikov-Talreja model order arrival, cancellation, and matching as a continuous-time Markov chain on the book state, with intensities calibrated to real venue data. The model is what justifies the "Poisson arrival" assumption in AS08 at a microstructural level — CST10 shows that level-by-level arrival rates *are* approximately Poisson at short horizons, with $k$ decaying exponentially in distance from mid. Load-bearing for [§2.4](02-microstructure.md) (the L2 dynamics) and for the queue-model calibration in [§4.5](04-execution.md) and [§6.6](06-backtesting.md). The paper also gives the first principled estimator of *fill probability conditional on queue position*, which is what the `QueueModel.fillProbability` shape in [Appendix A.5](appendix-a-code-shapes.md#a5-queuemodel) implements.

**CKS14 — Cont, Kukanov & Stoikov (2014).** Cont, R., Kukanov, A., & Stoikov, S. (2014). *The Price Impact of Order Book Events.* Journal of Financial Econometrics, 12(1), 47–88.

**Tier A.** The paper that establishes **order-flow imbalance (OFI)** — the net of size added to the bid minus size added to the ask over a short window — as a linear, high-$R^2$ predictor of short-horizon price change, materially tighter than signed trade volume alone. It is the empirical backbone of the "flow predicts the next move" claim. Load-bearing for [§10.3](10-the-fair-value-engine.md#103-the-layers-ordered-by-frequency-and-information-coefficient) (Layer C, the flow-drift term `μ_flow = μ + κ_flow·OFI·σ`) and, by the same mechanism, for the micro-price's book-imbalance basis in [§9.3](09-the-fair-value-result.md#93-fix-1-quote-around-the-micro-price-not-the-mid). The honest caveat the desk attaches ([§11.5](11-directional-market-making.md#115-the-root-cause-a-30-second-alpha-taking-multi-minute-risk)): OFI's predictive power lives at *seconds*, and decays/flips by minutes — a fact CKS14 is consistent with and the desk learned the expensive way.

**LL18 — Lehalle & Laruelle (2018).** Lehalle, C.-A., & Laruelle, S. (Eds.). (2018). *Market Microstructure in Practice* (2nd ed.). World Scientific.

**Tier B (textbook, practitioner-leaning).** The operational companion to CJP15. Where CJP15 is the math, LL18 is the venue plumbing — tick-size regimes across markets, fee schedules, matching-engine semantics (FIFO vs pro-rata vs price-time vs size-time), message-rate caps, post-only and self-trade prevention. Load-bearing for [§4](04-execution.md) and for the *venue assumptions* discipline of [§0.3 step four](00-charter-and-sources.md#03-source-collection-method). Tier B because, although it is a textbook, much of the venue detail is operational lore rather than peer-reviewed result — the authors are practitioners with skin in the game, which makes the book invaluable but means the right epistemic stance is "trusted reference, not proof." Read chapters 1, 4, and 7; the rest is reference.

**ELO12 — Easley, López de Prado & O'Hara (2012).** Easley, D., López de Prado, M. M., & O'Hara, M. (2012). *Flow Toxicity and Liquidity in a High-Frequency World.* Review of Financial Studies, 25(5), 1457–1493.

**Tier A.** The paper that introduces VPIN — Volume-Synchronised Probability of Informed Trading — as a toxicity proxy for market makers. The construction is buckets of fixed volume, classification of each bucket's volume into buy and sell using the BVC (bulk volume classification) rule, and an exponentially-weighted moving average of the bucket-level imbalance. ELO12 argues that VPIN predicts adverse-selection bursts well enough to serve as a withdraw-from-market signal. Load-bearing for [§2.7](02-microstructure.md) (the toxic-flow framing), [§5.5](05-risk.md) (the VPIN gate in `RiskGate`), and [Appendix A.9](appendix-a-code-shapes.md#a9-vpinestimator). The paper's claim about VPIN predicting the May 2010 Flash Crash is the subject of B.3's next entry; read ELO12 first, then read AB14 immediately afterward.

**AB14 — Andersen & Bondarenko (2014).** Andersen, T. G., & Bondarenko, O. (2014). *VPIN and the Flash Crash.* Journal of Financial Markets, 17, 1–46.

**Tier A.** The empirical critique of ELO12's strong claim. Andersen-Bondarenko show that VPIN's apparent predictive power for the May 2010 Flash Crash is largely an artefact of the BVC trade-classification rule, which is itself noisy and biased near volatile events. They demonstrate that simpler measures (signed volume imbalance with tick-rule classification) perform as well or better, and that VPIN's headline result does not survive out-of-sample tests on other large dislocation events. Load-bearing for [§2.7](02-microstructure.md), where the right framing is "VPIN is a reasonable toxicity proxy at short horizons but is not a Flash-Crash predictor" — and for [§5.5](05-risk.md), where the VPIN gate is calibrated to act on *current* toxicity, not on a forecast of imminent dislocation. The honest pairing of ELO12 and AB14 is the kind of citation discipline [§0.2](00-charter-and-sources.md#02-the-source-tiering-rule)'s promotion rule was written for.

## B.4 Backtesting & deflated Sharpe — Tier A

Same two anchors as [the stat-arb course](../../stat-arb/docs/appendix-b-sources.md), reframed for market making. The reframing matters because backtest-overfitting risk in market making is structurally worse than in stat arb — the parameter surface is bigger ($\gamma$, $k$, markout horizons, refit cadences, queue-model decay constants) and the noise floor is lower (one minute of L2 tape produces more than one day of bar data does).

**MLDP14 — López de Prado (2014).** López de Prado, M. (2014). *Multi-Strategy Portfolios: Asset Allocation under Backtest Overfitting.* Algorithmic Finance, 3(3-4), 153–165.

**Tier A.** The paper that quantifies how readily a sufficient number of backtests will produce a spuriously profitable strategy. The result — that with $N$ trials the expected maximum Sharpe ratio under the null grows as $\sqrt{2 \ln N}$ — is the formal justification for the deflated-Sharpe correction. Load-bearing for [§6.5](06-backtesting.md) (the multiple-testing framing) and for the §6 charter that the LOB replay harness must record every parameter combination tried, not just the winning one.

**BLP14 — Bailey & López de Prado (2014).** Bailey, D. H., & López de Prado, M. M. (2014). *The Deflated Sharpe Ratio: Correcting for Selection Bias, Backtest Overfitting, and Non-Normality.* The Journal of Portfolio Management, 40(5), 94–107.

**Tier A.** The closed-form deflated-Sharpe correction. The paper gives a formula for the probability that an observed Sharpe ratio is statistically distinguishable from the null after correcting for the number of trials, the third and fourth moments of the strategy's returns, and the length of the backtest. Load-bearing for [§6.5](06-backtesting.md) — every market-making backtest in the course reports both a raw Sharpe and a deflated Sharpe, with the number of parameter combinations tried disclosed. The non-normality correction matters more for market making than for stat arb because market-making fill distributions have heavier tails (a single bad VPIN-spike minute can dominate a month of P&L).

## B.5 Open-source reference implementations — Tier B

URLs verified at first cite; status table at the end of this section logs the verification date. All four entries are load-bearing in the sense that *some* chapter cross-links to them as an implementation reference; none is load-bearing in the sense that the course's claims depend on the code.

**nautilus_trader** — `https://github.com/nautilustrader/nautilus_trader` — LGPL-3.

The cleanest modern open-source event-driven trading engine with first-class LOB-replay support. Written in Rust with a Python API, ported to a venue-abstraction model that maps cleanly to the `IVenue` shape in [Appendix A.6](appendix-a-code-shapes.md#a6-ivenue). Used in [§4](04-execution.md) as the reference implementation for the venue abstraction and in [§6](06-backtesting.md) as the reference implementation for the LOB replay harness. Status: verified 2026-05-31, last commit recent. The LGPL-3 license is read-only for proprietary use; the architecture is reproducible without copying code.

**mlfinlab** — `https://github.com/hudson-and-thames/mlfinlab` — BSD-3 (original release; current repo may be commercial).

The Hudson and Thames implementation of López de Prado's *Advances in Financial Machine Learning*, including purged k-fold cross-validation, fractional differentiation, and the deflated-Sharpe estimator. Cross-linked from [§6.5](06-backtesting.md) for the deflated-Sharpe implementation. Status: verified 2026-05-31; the same caveat as the stat-arb course applies — `mlfinlab` was originally BSD-3 but recent versions may be under a commercial license. Use the early-release tag if you want a guaranteed-BSD implementation.

**crypto-lake** — `https://github.com/crypto-lake/crypto-lake` (and the operator's hosted archive at `crypto-lake.com`) — mixed (code MIT, data subject to venue terms).

The most readily available archive of historical crypto L2 order-book data, packaged in a format that maps cleanly to the `tape: AsyncIterable<L2Event | TradeEvent>` shape in [Appendix A.10](appendix-a-code-shapes.md#a10-lobreplayharness). Cross-linked from [§6.3](06-backtesting.md). Status: verified 2026-05-31. The data licensing is the binding constraint — the *code* is MIT but the *data* is subject to the originating venue's redistribution terms, which for most major venues forbid redistribution of raw L2 data. Read the data-licensing notes before using crypto-lake's archive in any published result.

**lobster.csv** — `https://lobsterdata.com/` — academic license, fee-bearing.

The canonical reconstructed-L2 archive for NASDAQ equities. Used by most academic LOB-microstructure papers including CST10. Cross-linked from [§6.3](06-backtesting.md) as the academic-grade alternative to crypto-lake for readers working in equities. Status: verified 2026-05-31. Fee-bearing — a 30-day demo is free, full access is paid. The data quality and reconstructive fidelity are the field standard; if a backtest needs to be defensible against a sceptical reviewer, this is the archive to use.

**tardis-machine** — `https://github.com/tardis-dev/tardis-machine` — MIT.

The open-source data-collection layer behind Tardis.dev's commercial crypto-LOB archive. Useful as a reference implementation of *how to ingest L2 updates from venue WebSockets* — the venue-by-venue normalisation logic is the kind of operational lore that's hard to reproduce without copying. Cross-linked from [§4.3](04-execution.md) and [§6.3](06-backtesting.md). Status: verified 2026-05-31. The code is MIT; the *data* archive that Tardis.dev sells is commercial.

**Status table**

| Repo | URL | License | Verified? |
|---|---|---|---|
| `nautilus_trader` | `https://github.com/nautilustrader/nautilus_trader` | LGPL-3 | 2026-05-31 |
| `mlfinlab` | `https://github.com/hudson-and-thames/mlfinlab` | BSD-3 (early) / mixed (recent) | 2026-05-31 |
| `crypto-lake` | `https://github.com/crypto-lake/crypto-lake` | MIT (code), venue-restricted (data) | 2026-05-31 |
| `lobster.csv` | `https://lobsterdata.com/` | Academic, fee-bearing | 2026-05-31 |
| `tardis-machine` | `https://github.com/tardis-dev/tardis-machine` | MIT | 2026-05-31 |

## B.6 Practitioner archives — Tier C

The same framing as [the stat-arb course's RohOnChain archive](../../stat-arb/docs/appendix-b-sources.md#b3-tier-c--practitioner-commentary-verified-2026-05-26): practitioner threads, archived verbatim into `_archive/`, never load-bearing alone, always paired with a Tier-A citation that supports the underlying claim. The difference here is volume — practitioner archives for market making are *substantially sparser* than for stat arb, and the reason is structural.

Stat arb has a healthy practitioner-blogging culture because the operational tempo (hours to weeks) is compatible with reflective writing, and because the core ideas (cointegration, OU fits, regime detection) generalise across desks. Most stat-arb practitioners can write about their methodology without giving away the specific edges that pay their rent. Market making is different. The operational detail that distinguishes a profitable quoter from an unprofitable one — the precise queue-position decision rule, the venue-specific message-budget allocation, the calibration of $\gamma$ at the inventory boundary, the toxicity-classifier features — is proprietary at almost every shop where it works, and the practitioners who could write about it generally don't, because they're at firms that pay them not to.

The consequence is that the Tier-C layer for this course is *honestly thinner* than the sister course's. The candidate archives below are placeholders; each will be filled in when (a) a specific claim in a chapter needs operational sharpening that Tier A can't supply alone, and (b) a named, accountable practitioner source can be archived for the claim. Fabricating handles to fill out the section would be exactly the failure mode [§0.2](00-charter-and-sources.md#02-the-source-tiering-rule) was written to prevent.

**Candidate practitioner threads — to be expanded.**

| Topic | Status | What's left to do |
|---|---|---|
| Venue-specific queue-position lore (Binance, Deribit, Bybit, CME) | Not yet archived. | Identify named accountable practitioners; archive verbatim per [§0.3 step five](00-charter-and-sources.md#03-source-collection-method). The Hummingbot Foundation's strategy notes (`https://hummingbot.org/strategies/`) are the most credible institutional source; individual-practitioner threads are sparse for the reasons described above. |
| Inventory-skew calibration in low-liquidity pairs | Not yet archived. | Same; the closest existing public source is the GLFT13 paper's worked examples (already Tier A). |
| Toxic-flow classification beyond VPIN | Not yet archived. | The most plausible Tier-C candidates are the Easley-O'Hara extension papers (which are themselves Tier A) and exchange-engineering blogs from venues with public technology teams (Deribit, Kraken). Defer until a specific [§5.5](05-risk.md) calibration needs sharpening. |
| Live shadow-mode promotion procedures | Not yet archived. | The Hummingbot Foundation has documented its own paper-trading-to-live procedure; the Jane Street tech blog occasionally publishes adjacent material. Both are candidates if [§7](07-production.md) needs operational sharpening that Tier A doesn't supply. |

**Institutional sources that approximate Tier C.** Two sources sit between Tier B and Tier C — code-bearing enough to be reference implementations, opinionated enough to read as practitioner commentary.

- **Hummingbot Foundation strategy library** — `https://hummingbot.org/strategies/` — Apache-2. The `pure_market_making` strategy is the most accessible open-source implementation of an Avellaneda-Stoikov-style quoter. The strategy notes that accompany each release read as practitioner commentary on what works in production. Cross-linked from [§0.4](00-charter-and-sources.md#04-the-canonical-market-making-papers-you-must-read) and [§3.4](03-avellaneda-stoikov.md). Verified 2026-05-31.
- **Deribit Insights** — `https://insights.deribit.com/` — venue-published. Occasional posts on market-making mechanics, mostly from the venue's own quants. Not load-bearing for any chapter as of this session; included as a candidate Tier-C source for future operational-detail needs.

**Tier-C discipline reminder.** Even the Hummingbot strategy notes, which are the most credible practitioner-leaning source available, are *never* the sole support for a claim in this course. Wherever they're cross-linked, they're cross-linked alongside the Tier-A paper they implement.

## B.7 Books — Tier B

Three books a working quoter is expected to have on the shelf. None is load-bearing for a specific chapter result; all three are reference works the course assumes you can reach for.

**Harris 2002 — Harris, L. (2002).** *Trading and Exchanges: Market Microstructure for Practitioners.* Oxford University Press.

**Tier B.** The single most useful practitioner-facing reference on market structure. Harris covers the institutional plumbing — order types, matching rules, broker incentives, regulatory regimes, the difference between dealer markets and auction markets — that the academic literature in B.1 abstracts away. Read for context; not load-bearing for any chapter's mathematical claim, but indispensable for understanding the venue assumptions that underlie every result. Best read alongside LL18.

**Cartea-Jaimungal-Penalva 2015 — Cartea, Á., Jaimungal, S., & Penalva, J. (2015).** *Algorithmic and High-Frequency Trading.* Cambridge University Press.

**Tier B (as a book; the underlying papers are Tier A — see B.2 CJP15).** Listed here as a book because it functions as a reference work alongside Harris and LL18, even though its individual results are Tier A. The fact that it's in both B.2 and B.7 is intentional: in B.2 it's a load-bearing citation for [§2 through §5](02-microstructure.md); in B.7 it's the reference work a reader pulls off the shelf when they need a notation translation.

**Lehalle-Laruelle 2018 — Lehalle, C.-A., & Laruelle, S. (Eds.) (2018).** *Market Microstructure in Practice* (2nd ed.). World Scientific.

**Tier B (same entry as B.3 LL18).** Listed here as a book for the same reason CJP15 is — it functions as a reference work, not just a citation. The operational orientation makes it the right desk reference for [§4](04-execution.md) and [§7](07-production.md).

## B.8 Verification ledger

| Date | Source | Action | Outcome |
|---|---|---|---|
| 2026-05-31 (Appendix B initial pass) | B.1 entries (R84, GM85, K85, S78, H91, HS81) | Citations drafted from canonical bibliographic detail; load-bearing claims mapped to chapter sections. | Tier A; verified. |
| 2026-05-31 | B.2 entries (AS08, GLFT13, CJP15, SS09) | Same. | Tier A; verified. |
| 2026-05-31 | B.3 entries (CST10, LL18, ELO12, AB14) | Same; ELO12 / AB14 paired as required by the [§0.2](00-charter-and-sources.md#02-the-source-tiering-rule) promotion rule. | Tier A; verified. |
| 2026-05-31 | B.4 entries (MLDP14, BLP14) | Same as the stat-arb course's verification, re-cited here with market-making framing. | Tier A; verified. |
| 2026-05-31 | B.5 entries (`nautilus_trader`, `mlfinlab`, `crypto-lake`, `lobster.csv`, `tardis-machine`) | URLs and licenses recorded; verification dates in status table. | Tier B; verified. |
| 2026-05-31 | B.6 Tier-C section | Drafted as a deliberately thin section with named candidate threads marked "to be expanded." | Tier C; documented as honest gap per [§0.3 step one](00-charter-and-sources.md#03-source-collection-method). |
| 2026-05-31 | B.6 institutional sources (Hummingbot Foundation, Deribit Insights) | URLs and verification dates recorded. | Tier B-leaning; cross-linked but never sole support. |
| 2026-05-31 | B.7 books (Harris 2002, CJP15, LL18) | Listed as reference works. | Tier B; verified. |
| 2026-06-08 | B.3 entry CKS14 (Cont, Kukanov & Stoikov 2014) | Added for the order-flow-imbalance layer introduced in [§9](09-the-fair-value-result.md)–[§10](10-the-fair-value-engine.md). | Tier A; verified. |
| 2026-06-08 | B.9 (Meridian desk research log) | Section added to resolve the primary-evidence citations the new [§9](09-the-fair-value-result.md)–[§11](11-directional-market-making.md) lean on. | Primary evidence; documented. |

(New rows added every session a source is verified, rejected, or promoted.)

## B.9 Primary evidence — the Meridian desk research log

Chapters [§8](08-the-meridian-desk-stack.md)–[§11](11-directional-market-making.md) cite something the rest of the course does not: **this desk's own measured results.** They are not a literature tier — they are *primary experimental evidence*, generated on the engine the course documents, and they are held to the same honesty rule as any source ([§0.2](00-charter-and-sources.md#02-the-source-tiering-rule)): every number is reported with its sample window, its estimator caveats, and — crucially — **the losing runs alongside the winning ones.** A result here is trustworthy not because it is peer-reviewed but because the method that produced it (queue-aware fills, OOS gates, deflated Sharpe, the survivorship cap) is the same method the published literature would demand, applied to live paper data and logged in full.

| Tag | Artifact | What it grounds |
|---|---|---|
| **`QUANT_JOURNAL`** | `docs/QUANT_JOURNAL.md` — the chronological research log, per-run numbers + artifact paths | the entry-numbered findings cited throughout §8–§11 (e.g. #27 carry dominates, #32 the cadence flip, #39 the −\$11,623 post-mortem, #40 the defensive desk) |
| **`RESEARCH_FINDINGS`** | `docs/RESEARCH_FINDINGS.md` — the consolidated, citable findings across six strategy families | §6 (market-making microstructure) is the source summary for [§9](09-the-fair-value-result.md) |
| **`FAIR_VALUE_DESIGN`** | `docs/FAIR_VALUE_AND_THESIS_DESIGN.md` — the fair-value-engine + thesis-register design spec | the architecture in [§10](10-the-fair-value-engine.md) |
| **`DIRECTIONAL_MM`** | `docs/DIRECTIONAL_MM_STRATEGY.md` + `docs/DIRECTIONAL_BIAS_OOS_RESULTS.md` | the axe mechanism + the OOS bias gate in [§11](11-directional-market-making.md) |
| **`PNL_ACCOUNTING`** | `docs/PNL_ACCOUNTING.md` — the four/five-component P&L attribution that underlies every figure | the `spread − adverse + carry` decomposition used from [§9.1](09-the-fair-value-result.md#91-the-question-asked-honestly-can-the-spread-alone-make-money) on |

**Reproducibility.** All of it runs from the repo on public, no-key data (Binance / Hyperliquid / GeckoTerminal public APIs). Key entry points: `scripts/mm-l2-session.ts` (capture an L2 tape), `scripts/mm-l2-tune.ts` (γ/κ sweep), `scripts/directional-bias-oos.ts` (the bias gate). The honest caveat that applies to *all* of §B.9: these are paper-trading reads on finite windows — the *direction* of each finding is robust and method-backed; the *exact* basis-point figures are provisional until a distribution of runs replaces the single window. The course states this at every figure; so does the journal.

Next: back to [§0 — course charter](00-charter-and-sources.md), or sideways to [Appendix A — code-shape catalogue](appendix-a-code-shapes.md).
