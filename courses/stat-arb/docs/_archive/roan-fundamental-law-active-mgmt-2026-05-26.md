# Roan / @RohOnChain — Fundamental Law of Active Management / "50 weak signals" thread (paraphrase archive)

| Field | Value |
|---|---|
| Handle | `@RohOnChain` |
| Display name | Roan |
| Primary tweet | `https://x.com/RohOnChain/status/2041893855524745381` (and its preceding thread chain) |
| Date of thread | ≈ October 2025 (inferred from tweet ID epoch) |
| Date archived | 2026-05-26 |
| Fetched from | `https://www.panewslab.com/en/articles/019d9926-e679-744e-8181-02a535e49e32` (structured paraphrase); `https://acidcapitalist.com/media/bitcoin-hype-aside-hedge-funds-win-by-stacking-50-weak-signa` (verbatim refused under copyright — paraphrase only retrieved). Original X thread is gated. |
| X timeline | gated (HTTP 402) — verbatim text could not be recovered |
| RT confirmation | `https://x.com/hkeskiva/status/2041787857157734512` (Heikki Keskiväli — practitioner — RT'd this thread with the comment *"This is basically 'wisdom of the crowd' but for trading signals"*) |
| Status | **Tier-C verified as paraphrase, not verbatim.** Treat sentence-level claims with care; the framework as a whole is on solid Tier-A ground (Grinold-Kahn). |

---

## A. What the thread is, in one paragraph

Roan's thread argues that traders who are *analytically correct* about trade direction still lose money because they fail to measure the *correlation* between their signals — i.e., they think they're combining N independent edges when they're really combining 2 or 3 independent edges and N − 3 noise terms. The thread then walks through an 11-step procedure for **stacking many weak signals into one position with controlled effective independence**, anchored on the Fundamental Law of Active Management (Grinold 1989; Grinold & Kahn 1995/1999):

$$ \text{IR} = \text{IC} \cdot \sqrt{N_{\text{effective}}} $$

— where IR is the strategy's annualised information ratio, IC is per-signal forecast skill (correlation between signal and realised return), and $N_{\text{effective}}$ is the *effective* number of independent bets after accounting for shared variance. Roan's headline number: 50 weak signals each with IC = 0.05, if their effective independence is high, produce IR ≈ 0.354 — *better than a single strong signal at IC = 0.10*.

## B. The 11-step combination engine (paraphrased)

Reproduced from the PANews structured summary (the only third-party write-up that survived verbatim-refusal). Organised in four phases:

**Phase 1 — Data preparation.**
1. Collect raw return series for each candidate signal.
2. De-mean each series (subtract the cross-sectional or time-series mean to remove constant exposure).
3. Compute the per-signal volatility.
4. Standardise each signal to unit variance (z-score).

**Phase 2 — Noise elimination.**
5. Hold out an out-of-sample window (the "OOS split") — never tune on what you score on.
6. Cross-sectional de-mean again to remove transient market-wide drifts.
7. Clean outliers (winsorise or robust-rank).

**Phase 3 — Extract advantages.**
8. Compute the per-signal expected return at each timestep.
9. **Orthogonalise** — regress each signal against the others and keep only the residual. This is the load-bearing step: it's what converts "N signals" into "N effective independent signals". Any signal whose residual explains nothing gets dropped.

**Phase 4 — Weight allocation.**
10. Compute the optimal Markowitz-style weights using the orthogonalised signals.
11. Normalise weights to a target volatility / leverage budget.

After the engine, **bet sizing is fractional Kelly with edge-uncertainty shrinkage**:

$$ f_{\text{empirical}} = f_{\text{Kelly}} \cdot (1 - \text{CV}_{\text{edge}}) $$

— where $\text{CV}_{\text{edge}}$ is the coefficient of variation of the edge estimate itself (i.e., how uncertain you are about your IC). Roan's framing: never bet full Kelly because your edge estimate is itself noisy.

## C. The five signal types (per PANews paraphrase of Roan's thread)

| Type | What it captures | Example |
|---|---|---|
| 1. Price / momentum | Market inertia | 12-1 momentum; cross-sectional ranking |
| 2. Mean reversion | Deviation from fair value | The pairs trading + OU strategies in this course |
| 3. Volatility | Implied vs realised gap | Short straddle when IV > RV; long when RV > IV |
| 4. Factor signals | Academic systematic premia | Value, quality, low-vol from the Fama-French / AQR literature |
| 5. Microstructure | Order-book imbalance / informed-flow proxies | OFI (Cont et al., 2014); cross-venue trade-flow asymmetry |

Roan's argument is that a stat-arb book using only type 2 (mean reversion) has a low effective N because every pair shares the same regime exposure. Adding signals from types 3 and 5 — even weak ones with IC = 0.03 — raises effective N more than adding more type-2 pairs does.

## D. The Polymarket sidebar

The thread closes with a Polymarket-specific application: combine five probability signals (market price drift, social-sentiment, news-event proximity, mover-imbalance, and a calibration prior) through the same engine, then size with the Kelly-with-edge-uncertainty formula above. This is outside the current stat-arb course scope but lands inside Meridian Markets' Phase 3 envelope per the bio's "prediction markets" reference.

## E. Claims extraction

| # | Claim (paraphrase) | Topic | Tier-A mapping | Verdict |
|---|---|---|---|---|
| 1 | $\text{IR} = \text{IC} \cdot \sqrt{N}$ is the right framework for thinking about combining many weak signals — not "find one strong edge". | §5, §6, Appendix C | Grinold (1989), Grinold & Kahn (1995/1999, ch. 6) — the FLAM is Tier-A canonical. | **AGREES_WITH_TIER_A** — promote; cite Grinold-Kahn. |
| 2 | The $N$ in the FLAM is the *effective* number of independent bets, not the raw count of signals. Practitioners routinely conflate the two and over-leverage. | §5, §6 | Clarke, de Silva & Thorley (2002), *Portfolio constraints and the fundamental law of active management*, Financial Analysts Journal — introduces the transfer coefficient (TC), which is the load-bearing correction in real portfolios. Grinold & Kahn (2000, "*The Fundamental Law Redux*") covers this directly. | **AGREES_WITH_TIER_A** — promote; cite Clarke et al. (2002). |
| 3 | Orthogonalising signals (regressing each against the others, keeping the residual) is the *operational* mechanism for converting "N signals" into "N effective independent signals". | §6, Appendix A | Bailey & López de Prado (2014), *Deflated Sharpe Ratio*, and López de Prado (2018, ch. 8) on "feature importance" — orthogonalisation is the load-bearing step. | **AGREES_WITH_TIER_A** — promote; cite López de Prado. |
| 4 | Five rough signal taxonomies (momentum / mean-reversion / vol / factor / microstructure) cover most signal families practitioners use. Diversifying *across families* matters more than adding more signals within one family. | Appendix C | Asness, Moskowitz & Pedersen (2013), *Value and Momentum Everywhere*, J. Finance — establishes the cross-family-diversification argument empirically. | **EXTENDS_TIER_A** — promote as a Practitioner-note callout pointing readers at the cross-family principle. |
| 5 | Bet-sizing should be fractional Kelly with a shrinkage factor proportional to the *uncertainty* of the edge estimate: $f_{\text{empirical}} = f_{\text{Kelly}} \cdot (1 - \text{CV}_{\text{edge}})$. | §5 | Thorp (2006) on Kelly shrinkage; MacLean, Thorp & Ziemba (2011, *The Kelly Capital Growth Investment Criterion*) — fractional Kelly is canonical, the CV-based shrinkage form is practitioner. | **EXTENDS_TIER_A** — the rule of thumb is sound; the specific functional form is not in Tier A. Practitioner-note in §5. |
| 6 | A stat-arb book built only on mean-reversion signals (one family) has a low effective N because every pair shares the same regime exposure. Adding signals from other families (vol, microstructure) raises effective N more than adding more pairs does. | §2.X, §6 | Asness et al. (2013); Clarke et al. (2002). | **AGREES_WITH_TIER_A** — strong promote. This is the answer to "why pairs trading alone isn't a fund." |
| 7 | "Hedge funds don't win by finding better signals — they win by combining more of them." | §6 | This is essentially the FLAM in one sentence. Mapped onto Grinold & Kahn (1995/1999, ch. 6). | **AGREES_WITH_TIER_A** — citable as a punchy framing alongside the formal citation. |
| 8 | Traders who measure effective independence and size accordingly "dramatically outperform" traders who count signals and assume independence. | §5, §6 | Clarke et al. (2002); Grinold & Kahn (2000). | **AGREES_WITH_TIER_A** — promote with Clarke et al. citation. |

## F. Promotion plan into the course

- **§2.X "Universe construction"** picks up claim #6 — the cross-family argument is the answer to "how big should my candidate universe of pairs be?" The realistic answer is "smaller than you think, because effective N drops fast within one family."
- **§5 "Risk, sizing, circuit breakers"** picks up claims #1, #2, #5, #8 with FLAM as a formal section under §5.2. The Kelly-with-edge-uncertainty form gets a Practitioner-note callout.
- **§6 "Backtesting honestly"** picks up claims #3, #7 — orthogonalisation as the load-bearing methodology step; the FLAM framing as the right way to read a multi-strategy backtest's Sharpe.
- **Appendix C** gets the punchier framings (claims #4, #7) as Q&A entries.

## G. What deliberately does NOT promote

- The specific numbers ("IR = 0.354" for 50 signals at IC = 0.05) reproduce a textbook example from Grinold & Kahn. They're correct but they're not Roan's; the course cites Grinold-Kahn directly.
- The Polymarket application — out of scope for this course. Flagged for a future prediction-markets course.
- The thread's framing as "secrets from hedge funds" — this is canonical FLAM material that's been in finance textbooks for thirty years. It's *operationally fresh* (the orthogonalisation-as-effective-N argument is well-stated) but the underlying math is not secret. The course frames it accordingly.

## H. Caveat — paraphrase, not verbatim

This archive is built from a third-party paraphrase (PANews) plus structural notes from a second third-party write-up (acidcapitalist, which refused verbatim under copyright). The original X thread is gated. **Individual sentence-level quotes should not be lifted from this archive.** What's defensible is the *framework* — the FLAM application, the 11-step engine, the orthogonalisation principle — which maps cleanly to Tier-A literature.

If the user has a saved verbatim copy of the original thread, this archive should be re-fetched and the paraphrase replaced with the original text.
