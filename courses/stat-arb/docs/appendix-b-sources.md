# Appendix B — Source notebook

Every citation in the course resolves here. Sources are tiered (see [§0.3](00-charter-and-sources.md)).

## B.1 Tier A — foundational literature (verified)

| Tag | Citation | What it proves |
|---|---|---|
| **EG87** | Engle, R. F., & Granger, C. W. J. (1987). *Co-integration and error correction: representation, estimation, and testing.* Econometrica, 55(2), 251–276. | Two-step cointegration test |
| **J91** | Johansen, S. (1991). *Estimation and hypothesis testing of cointegration vectors in Gaussian vector autoregressive models.* Econometrica, 59(6), 1551–1580. | Multi-variate cointegration |
| **AL10** | Avellaneda, M., & Lee, J.-H. (2010). *Statistical arbitrage in the U.S. equities market.* Quantitative Finance, 10(7), 761–782. | Modern PCA + OU stat-arb formulation |
| **B10** | Bertram, W. K. (2010). *Analytic solutions for optimal statistical arbitrage trading.* Physica A, 389(11), 2234–2243. | OU optimal entry/exit thresholds |
| **MLDP18** | López de Prado, M. (2018). *Advances in Financial Machine Learning.* Wiley. | Purged k-fold CV; deflated Sharpe ratio; honest methodology |
| **BLP14** | Bailey, D. H., & López de Prado, M. (2014). *The deflated Sharpe ratio: correcting for selection bias, backtest overfitting, and non-normality.* The Journal of Portfolio Management, 40(5), 94–107. | DSR closed form (§6.5) |
| **BBLPZ14** | Bailey, D. H., Borwein, J. M., López de Prado, M., & Zhu, Q. J. (2014). *Pseudo-mathematics and financial charlatanism.* Notices of the AMS, 61(5), 458–471. | Canonical paper on backtest overfitting |
| **AC01** | Almgren, R., & Chriss, N. (2001). *Optimal execution of portfolio transactions.* Journal of Risk, 3, 5–40. | Market-impact / slippage modelling; underpins §4.5 entry-passive / exit-aggressive asymmetry |
| **K56** | Kelly, J. L. (1956). *A new interpretation of information rate.* Bell System Technical Journal, 35, 917–926. | Original Kelly |
| **T06** | Thorp, E. O. (2006). *The Kelly criterion in blackjack, sports betting, and the stock market.* | Shrinkage argument for fractional Kelly |
| **J06** | Jorion, P. (2006). *Value at Risk: The New Benchmark for Managing Financial Risk* (3rd ed.). McGraw-Hill. | VaR methodology |
| **G89** | Grinold, R. (1989). *The fundamental law of active management.* Journal of Portfolio Management, 15(3), 30–37. | Original FLAM statement: $\text{IR} = \text{IC} \cdot \sqrt{N}$ |
| **GK99** | Grinold, R., & Kahn, R. (1999). *Active Portfolio Management* (2nd ed.). McGraw-Hill. | Comprehensive FLAM treatment + effective-$N$ |
| **CST02** | Clarke, R., de Silva, H., & Thorley, S. (2002). *Portfolio constraints and the fundamental law of active management.* Financial Analysts Journal, 58(5), 48–66. | Transfer-coefficient correction; the formal effective-$N$ correction in real portfolios |
| **H89** | Hamilton, J. D. (1989). *A new approach to the economic analysis of nonstationary time series and the business cycle.* Econometrica, 57(2), 357–384. | Markov regime-switching; the formal foundation for the practitioner-grade regime detection used in §2.9, §3.6, §5.3 |
| **R89** | Rabiner, L. R. (1989). *A tutorial on hidden Markov models and selected applications in speech recognition.* Proceedings of the IEEE, 77(2), 257–286. | Canonical HMM reference; the Baum-Welch local-maxima warning that the practitioner archive operationalises |
| **AB02** | Ang, A., & Bekaert, G. (2002). *Regime switches in interest rates.* Journal of Business & Economic Statistics, 20(2), 163–182. | Operationalises 2-to-3-state regime models for cross-asset allocation |
| **AMP13** | Asness, C. S., Moskowitz, T. J., & Pedersen, L. H. (2013). *Value and momentum everywhere.* Journal of Finance, 68(3), 929–985. | Cross-family-diversification argument cited in §2.8 |
| **BH95** | Benjamini, Y., & Hochberg, Y. (1995). *Controlling the false discovery rate: a practical and powerful approach to multiple testing.* J. Royal Statistical Society B, 57(1), 289–300. | Multiple-testing correction for the §2.8 funnel |
| **LM88** | Lo, A., & MacKinlay, A. C. (1988). *Stock market prices do not follow random walks.* Review of Financial Studies, 1(1), 41–66. | Variance-ratio test; "trending vs choppy" decomposition |

## B.2 Tier B — reference implementations (URLs pending verification)

**Status:** the next session must `WebFetch` each URL, confirm it resolves, and note the license + last-commit-date in this table. Until then, all entries are `unverified`.

| Repo | URL (recall — verify) | What to read | License (recall — verify) | Verified? |
|---|---|---|---|---|
| `hudson-and-thames/mlfinlab` | `https://github.com/hudson-and-thames/mlfinlab` | Cointegration, fractional differentiation, purged CV | BSD-3 | ❌ |
| `hudson-and-thames/arbitragelab` | `https://github.com/hudson-and-thames/arbitragelab` | Engle-Granger, Johansen, Bertram, copula pairs | Mixed (may now be commercial) | ❌ |
| `statsmodels/statsmodels` | `https://github.com/statsmodels/statsmodels` | `tsa.stattools.adfuller`, `tsa.vector_ar.vecm` | BSD-3 | ❌ |
| `quantopian/zipline` | `https://github.com/quantopian/zipline` | Event-driven backtest loop | Apache-2 | ❌ |
| `robcarver17/pysystemtrade` | `https://github.com/robcarver17/pysystemtrade` | Stages composition; position-sizing | GPL-3 (read-only; do not copy code) | ❌ |
| `jesse-ai/jesse` | `https://github.com/jesse-ai/jesse` | Strategy lifecycle hooks; live/backtest parity | MIT | ❌ |
| `freqtrade/freqtrade` | `https://github.com/freqtrade/freqtrade` | Hyperopt; strategy/backtest separation | GPL-3 (read-only) | ❌ |
| `nautilustrader/nautilus_trader` | `https://github.com/nautilustrader/nautilus_trader` | Modern event-driven; venue abstraction | LGPL-3 | ❌ |
| `tradytics/eiten` | `https://github.com/tradytics/eiten` | Portfolio optimization | GPL-3 (read-only) | ❌ |
| QuantConnect Lean | `https://github.com/QuantConnect/Lean` | C# event-driven engine | Apache-2 | ❌ |

## B.3 Tier C — practitioner commentary (verified 2026-05-26)

The "rohn / roan" thread the user mentioned in Session 2 was identified as **@RohOnChain** (display name "Roan", ≈ 47.3K followers, bio: "building my life around quant systems in prediction markets and crypto on chain"). The handle was supplied directly by the user; the threads were located through their companion artifacts (a GitHub repo by Lewis Jackson that reproduces the framework verbatim, third-party write-ups, and RT confirmation by other practitioners). Full search log: [`_archive/x-search-attempt-2026-05-26.md`](_archive/x-search-attempt-2026-05-26.md).

| Archive file | Handle | Source URL | Fetch date | Claims extracted | Verdict mix | Cited in chapters |
|---|---|---|---|---|---|---|
| [`_archive/roan-markov-hedge-fund-method-2026-05-26.md`](_archive/roan-markov-hedge-fund-method-2026-05-26.md) | @RohOnChain | `https://github.com/jackson-video-resources/markov-hedge-fund-method` (verbatim companion repo); X anchor `https://x.com/RohOnChain/status/2049153122027900948` | 2026-05-26 | 12 | 7 × `AGREES_WITH_TIER_A`, 5 × `EXTENDS_TIER_A`, 0 × `CONTRADICTS_TIER_A`, 0 × `UNVERIFIABLE` | §2.9, §3.6, §5.3, §6.5, Appendix C Q1–Q6, Q12 |
| [`_archive/roan-fundamental-law-active-mgmt-2026-05-26.md`](_archive/roan-fundamental-law-active-mgmt-2026-05-26.md) | @RohOnChain | X anchor `https://x.com/RohOnChain/status/2041893855524745381`; PANews summary `https://www.panewslab.com/en/articles/019d9926-e679-744e-8181-02a535e49e32`; acidcapitalist refused verbatim under copyright | 2026-05-26 | 8 | 6 × `AGREES_WITH_TIER_A`, 2 × `EXTENDS_TIER_A`, 0 × `CONTRADICTS_TIER_A`, 0 × `UNVERIFIABLE` | §2.8, §5.2, §6.5, §6.7, Appendix C Q7–Q11 |
| (search log) | n/a | n/a | 2026-05-26 | n/a | Documents search-attempt methodology; not promoted into the course body itself. | [`_archive/x-search-attempt-2026-05-26.md`](_archive/x-search-attempt-2026-05-26.md) |

**Tier discipline reminder (from §0.3).** None of the practitioner claims above stands alone in the course body. Each is paired with its Tier-A mapping. The two archive files exist as *primary record* (so that if the X thread is deleted or edited, the course still has its own copy) and as *Tier-C citation target* (so that future sessions can verify the claim was promoted on the correct Tier-A basis).

**Unverified Tier-C — known gap.**

| Thread | Status | What's left to do |
|---|---|---|
| @RohOnChain — Neural Networks thread (`https://en.rattibha.com/thread/2052043443766194272`) | **Title + lead recovered; body gated (HTTP 403 from rattibha frontend).** Not integrated into the course. | If the user has a saved copy or rattibha unblocks, archive verbatim and run claims-extraction. Until then it sits in [`_archive/x-search-attempt-2026-05-26.md` §3](_archive/x-search-attempt-2026-05-26.md) as a known-but-unreached pointer. |

**Other Tier-C sources still to vet** (placeholders — *not currently cited anywhere in the course body*): Robert Carver's blog (`qoppac.blogspot.com`), Ernie Chan's blog (`epchan.blogspot.com`), Marcos López de Prado's QuantResearch newsletter, the QuantConnect community forum. Worth fetching when a specific claim from §6 / §7 needs operational sharpening.

## B.4 Verification ledger

| Date | Source | Action | Outcome |
|---|---|---|---|
| 2026-05-26 (S2) | All Tier-B entries | Initial draft from training-data recall | Marked unverified |
| 2026-05-26 (S2) | "rohn / roan" thread | User-mentioned, not yet researched | Marked unverified; placeholder only |
| 2026-05-26 (S3) | @RohOnChain handle | User confirmed handle via direct URL (`https://x.com/RohOnChain`). Display name "Roan". | Tier-C verified. |
| 2026-05-26 (S3) | RohOnChain Markov Hedge Fund Method | Verbatim text recovered via companion GitHub repo `jackson-video-resources/markov-hedge-fund-method` (211 ⭐, MIT, explicit Roan attribution). Archive file written. 12 claims extracted; 12/12 mapped to Tier A. | Tier-C verified. Cited in §2.9, §3.6, §5.3, §6.5, Appendix C. |
| 2026-05-26 (S3) | RohOnChain Fundamental Law thread | Paraphrase recovered via PANews structured summary (acidcapitalist refused verbatim under copyright; original X thread gated). Archive file written as paraphrase, not verbatim. 8 claims extracted; 8/8 mapped to Tier A. | Tier-C verified as paraphrase. Cited in §2.8, §5.2, §6.5, §6.7, Appendix C. |
| 2026-05-26 (S3) | RohOnChain Neural Networks thread | rattibha frontend returned HTTP 403; body not recoverable. Title + lead only. | Documented in search log; **not** integrated into course body. |
| 2026-05-26 (S3) | NAV Consulting, SS&C GlobeOp, Sudrania (fund administrators) | Public service descriptions fetched and summarised in §7.7. | Tier-A (public corporate disclosures). |

(This ledger gets a new row every time a source is verified or rejected in a future session.)
