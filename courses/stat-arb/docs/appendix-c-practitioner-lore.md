# Appendix C — Practitioner lore (RohOnChain archive)

This appendix is the dedicated home for material from the @RohOnChain (Roan) X archive that's interesting and citable as Tier-C, but didn't fit naturally into the chapter bodies (§2–§7). Everything here is paired with its archive-file citation and its Tier-A mapping per the §0.3 promotion rule.

The two archive files are:

- [`_archive/roan-markov-hedge-fund-method-2026-05-26.md`](_archive/roan-markov-hedge-fund-method-2026-05-26.md) — verbatim text of the Markov regime detection framework, captured from the public companion repo `jackson-video-resources/markov-hedge-fund-method` which reproduces Roan's content with explicit attribution.
- [`_archive/roan-fundamental-law-active-mgmt-2026-05-26.md`](_archive/roan-fundamental-law-active-mgmt-2026-05-26.md) — paraphrase of the "50 weak signals / Fundamental Law of Active Management" thread, captured from third-party write-ups (the original X thread was gated at fetch time).

The search log for both is in [`_archive/x-search-attempt-2026-05-26.md`](_archive/x-search-attempt-2026-05-26.md).

## C.1 The Q&A format

Each entry below is a practitioner claim, its archive provenance, the Tier-A material it maps to, and a short note on how it's being used in the course.

---

### Q1. "What's the simplest regime model that's still useful?"

**Claim (from RohOnChain — Markov Hedge Fund Method).** A 3-state Markov chain over rolling-return labels (Bull / Sideways / Bear, from a 20-day rolling return with a ±5% threshold) captures enough of the regime structure to be useful. You don't need a 10-state model or a deep network.

**Archive.** [`roan-markov-hedge-fund-method-2026-05-26.md` §E claim #1](_archive/roan-markov-hedge-fund-method-2026-05-26.md).

**Tier-A mapping.** Hamilton (1989), *A new approach to the economic analysis of nonstationary time series and the business cycle*, Econometrica 57(2). Ang & Bekaert (2002), *Regime switches in interest rates*, Journal of Business & Economic Statistics 20(2). Both establish that 2-to-3-state regime-switching models are the practitioner-grade decomposition; higher-order models routinely overfit.

**Course use.** Cited in §2.9 (spread-staleness diagnostics, the persistence-diagonal check) and §3.6 (OU diagnostics, the regime-as-gate composition pattern).

---

### Q2. "Why is the persistence diagonal of the transition matrix the most useful single number on it?"

**Claim (from RohOnChain — Markov Hedge Fund Method).** The diagonal entries $P_{ii}$ of the transition matrix — the probability of staying in the current regime — directly distinguish *trending* markets (high persistence: $P_{ii} > 0.85$) from *choppy* markets (low persistence: $P_{ii} < 0.65$). When the persistence collapses, the asset is becoming choppier independently of any direction-of-trend signal, which is leading information for stat-arb pairs that depend on that asset.

**Archive.** [`roan-markov-hedge-fund-method-2026-05-26.md` §E claim #8](_archive/roan-markov-hedge-fund-method-2026-05-26.md).

**Tier-A mapping.** Hamilton (1989); Lo & MacKinlay (1988), *Stock market prices do not follow random walks*, Review of Financial Studies 1(1) — the "trending vs choppy" decomposition is implicit in the variance-ratio test.

**Course use.** Cited in §2.9 as one of the staleness-diagnostic mechanisms.

---

### Q3. "Why fit multiple seeds when training a Hidden Markov Model?"

**Claim (from RohOnChain — Markov Hedge Fund Method).** The Baum-Welch algorithm that fits HMMs finds *local* maxima, not global. For production use, fit five-to-ten random seeds and keep the best by log-likelihood. Don't trust a single fit.

**Archive.** [`roan-markov-hedge-fund-method-2026-05-26.md` §E claim #5](_archive/roan-markov-hedge-fund-method-2026-05-26.md).

**Tier-A mapping.** Rabiner (1989), *A tutorial on hidden Markov models and selected applications in speech recognition*, Proceedings of the IEEE 77(2). The local-maxima warning is in §III.C of that paper, verbatim.

**Course use.** Cited in §3.6 (OU diagnostics) as the discipline for the HMM-upgrade path.

---

### Q4. "Why sort HMM latent states by mean daily return before reading them?"

**Claim (from RohOnChain — Markov Hedge Fund Method).** When you fit an HMM with `n_components=3`, the latent states come out in a *random* order from the fit — state 0 might be Bull on one random seed and Bear on another. To use the model interpretably, relabel the states by ascending mean daily return: lowest mean = Bear, highest mean = Bull. This is purely a labelling convention but it's the difference between an HMM you can read and an HMM you can't.

**Archive.** [`roan-markov-hedge-fund-method-2026-05-26.md` §E claim #11](_archive/roan-markov-hedge-fund-method-2026-05-26.md).

**Tier-A mapping.** No direct Tier-A — the labelling convention is purely practitioner. The underlying HMM is Rabiner (1989).

**Course use.** Mentioned in §3.6's Practitioner-note callout. Engineering implication: any HMM-based regime function in `signal/regime.ts` should run the relabelling internally before returning state labels.

---

### Q5. "If `hmmlearn` won't compile, do I really need the HMM layer?"

**Claim (from RohOnChain — Markov Hedge Fund Method).** No. The observable-state Markov model (the 3-state matrix from the rolling-return label) is most of the value. The HMM is an upgrade for cases where the observable label is too coarse. When `hmmlearn` fails to compile (common on Windows without MSVC build tools), the observable model alone is *still useful* — degrade gracefully rather than refuse to run.

**Archive.** [`roan-markov-hedge-fund-method-2026-05-26.md` §E claim #12](_archive/roan-markov-hedge-fund-method-2026-05-26.md).

**Tier-A mapping.** None — engineering claim. But it lines up with the §A.1 swap-seam pattern: features that depend on optional external dependencies should degrade rather than block.

**Course use.** Operational lore; not directly cited in chapter bodies, but informs Appendix A's pattern catalogue.

---

### Q6. "Why is composing the regime detector as a confirmation layer better than running it standalone?"

**Claim (from RohOnChain — Markov Hedge Fund Method).** The framework is built to *layer onto* an existing strategy as a confirmation gate, sizing filter, or veto — not to replace the strategy. The composition pattern is documented as three concrete recipes in the framework's `SKILL.md` (see the archive §C): regime-as-confirmation (only enter when regime agrees), regime-as-sizing-filter (stationary bear share scales position), regime-as-standalone-signal (signed `bull_prob − bear_prob`).

**Archive.** [`roan-markov-hedge-fund-method-2026-05-26.md` §C and §E claim #6](_archive/roan-markov-hedge-fund-method-2026-05-26.md).

**Tier-A mapping.** No direct Tier-A for the composition patterns themselves; these are engineering compositions. The underlying regime detection is Hamilton (1989).

**Course use.** Cited in §3.6 as the design pattern for layering regime detection onto OU strategies. Also informs §5 (risk) via the stationary-distribution-as-sizing-input pattern.

---

### Q7. "How many independent signals does my book actually have?"

**Claim (from RohOnChain — Fundamental Law thread).** The $N$ in the Fundamental Law $\text{IR} = \text{IC} \cdot \sqrt{N}$ is **not** the count of signals in your stack — it's the *effective* number of independent signals after accounting for shared variance. Most traders count 50 and operate as if they have 50 independent edges; the realised effective $N$ is closer to 5 once you measure cross-signal correlation. This is the single biggest reason books that "should" have Sharpe 3 only achieve Sharpe 1.

**Archive.** [`roan-fundamental-law-active-mgmt-2026-05-26.md` §E claim #2](_archive/roan-fundamental-law-active-mgmt-2026-05-26.md).

**Tier-A mapping.** Grinold (1989), *The Fundamental Law of Active Management*, Journal of Portfolio Management 15(3); Grinold & Kahn (1995/1999), *Active Portfolio Management* 2nd ed., ch. 6; Clarke, de Silva & Thorley (2002), *Portfolio constraints and the fundamental law of active management*, Financial Analysts Journal 58(5) — introduces the transfer coefficient that is the formal effective-$N$ correction in real portfolios.

**Course use.** Cited prominently in §2.8 (universe construction) Practitioner note, §5 (risk sizing), and §6 (backtesting / DSR). This is the Tier-C claim with the strongest Tier-A grounding in the course.

---

### Q8. "What's the operational fix for the effective-$N$ problem?"

**Claim (from RohOnChain — Fundamental Law thread).** Orthogonalise the signals. For each signal $s_i$, regress it against the others and keep only the residual. Signals whose residual explains nothing get dropped. The orthogonalised signal set has effective $N$ closer to the count of signals you've kept; the raw signal set is dominated by shared variance.

**Archive.** [`roan-fundamental-law-active-mgmt-2026-05-26.md` §E claim #3, §B step 9](_archive/roan-fundamental-law-active-mgmt-2026-05-26.md).

**Tier-A mapping.** López de Prado (2018, ch. 8) on feature importance and orthogonalisation; Bailey & López de Prado (2014) on the deflated Sharpe ratio which depends on this exact correction.

**Course use.** Cited in §6.5 (deflated Sharpe ratio computation). The orthogonalisation step is the operational mechanism that the DSR formalism assumes you've done; the practitioner thread is the clearest *operational* statement of it I found.

---

### Q9. "How should I size bets given my edge estimate is itself uncertain?"

**Claim (from RohOnChain — Fundamental Law thread).** Fractional Kelly with edge-uncertainty shrinkage: $f_{\text{empirical}} = f_{\text{Kelly}} \cdot (1 - \text{CV}_{\text{edge}})$, where $\text{CV}_{\text{edge}}$ is the coefficient of variation of your edge estimate. Never bet full Kelly because your edge estimate is itself noisy. The CV-shrinkage form is sharper than the generic "quarter-Kelly" rule of thumb because it adapts to how confident you actually are in the edge.

**Archive.** [`roan-fundamental-law-active-mgmt-2026-05-26.md` §E claim #5](_archive/roan-fundamental-law-active-mgmt-2026-05-26.md).

**Tier-A mapping.** Thorp (2006) on Kelly shrinkage; MacLean, Thorp & Ziemba (2011) — fractional Kelly is canonical in Tier A. The specific CV-shrinkage functional form is *not* in Tier A; it's a practitioner sharpening of the generic argument.

**Course use.** Practitioner-note callout in §5.2 (per-strategy sizing). The course retains the generic "quarter-Kelly" as the default; the CV-shrinkage form is offered as the more sophisticated alternative when the edge estimate's standard error is reliably measurable.

---

### Q10. "Why does adding signals from different families help more than adding signals from the same family?"

**Claim (from RohOnChain — Fundamental Law thread).** A book of 20 mean-reversion signals has low effective $N$ because every signal shares regime exposure. Adding even weak signals from other families — volatility (IV vs RV), microstructure (order-flow imbalance), or factor (value, low-vol, momentum) — raises effective $N$ more than another mean-reversion signal does. The mathematical reason is that orthogonalisation against signals in the same family destroys most of the original signal's residual; orthogonalisation against signals in *different* families preserves it.

**Archive.** [`roan-fundamental-law-active-mgmt-2026-05-26.md` §E claim #6](_archive/roan-fundamental-law-active-mgmt-2026-05-26.md).

**Tier-A mapping.** Asness, Moskowitz & Pedersen (2013), *Value and momentum everywhere*, Journal of Finance 68(3) — establishes the cross-family diversification argument empirically across asset classes and centuries of data. Grinold & Kahn (1999, ch. 6).

**Course use.** Cited in §2.8 Practitioner note (universe-construction discipline) and §6.5 (DSR interpretation). The concrete implication for any crypto stat-arb book is the diversification target: don't build 30 cointegrated pairs and call it a book; build a mixed book of pairs, funding-carry, and basis-trade positions to actually move the effective $N$.

---

### Q11. "Does 'hedge funds win by finding better signals or by combining more signals'?"

**Claim (from RohOnChain — Fundamental Law thread).** Combining more. The headline reading of the FLAM is: 50 weak signals with $\text{IC} = 0.05$ (and high effective independence) produce $\text{IR} = 0.05 \cdot \sqrt{50} \approx 0.354$, which is **3.5× better than a single strong signal with $\text{IC} = 0.10$** (which gives $\text{IR} = 0.10 \cdot \sqrt{1} = 0.10$). The asymmetry — that breadth dominates skill once you've reached a basic competence threshold — is the entire reason large hedge funds have hundreds of analysts each running a small signal rather than three "star" PMs each running one big bet.

**Archive.** [`roan-fundamental-law-active-mgmt-2026-05-26.md` §A, §E claim #1, claim #7](_archive/roan-fundamental-law-active-mgmt-2026-05-26.md).

**Tier-A mapping.** Grinold (1989); Grinold & Kahn (1999, ch. 6). The numerical example is essentially the textbook FLAM example.

**Course use.** Quoted (with Tier-A citation) in §5 and §6. This is the framing claim that motivates building a multi-strategy book at all — a single stat-arb strategy is one signal; the book of five-or-six is what gets to a defensible Sharpe.

---

### Q12. "What's the most common reason a backtest's Sharpe overstates live performance?"

**Claim (from RohOnChain — Markov Hedge Fund Method, walk-forward discipline).** Lookahead. The framework refuses to use any data that postdates the current decision point — the transition matrix at time $t$ is built only from labels up to $t - 1$. Most retail backtests use lookahead inadvertently (rolling means with a centred window, normalisers trained on the full sample, etc.) and routinely report Sharpes 50%–200% above what the strategy actually delivers live.

**Archive.** [`roan-markov-hedge-fund-method-2026-05-26.md` §E claims #4 and #10](_archive/roan-markov-hedge-fund-method-2026-05-26.md).

**Tier-A mapping.** López de Prado (2018, ch. 7) on purged k-fold cross-validation, which generalises this exact principle. Bailey, Borwein, López de Prado & Zhu (2014) on "pseudo-mathematics" in finance.

**Course use.** Cited prominently in §6.3 (purged k-fold) and §6.5 (deflated Sharpe). The walk-forward discipline that the framework operationalises is exactly the purged-k-fold discipline that §6 formalises — same principle, different presentation.

---

## C.2 What's *not* in this appendix

Two kinds of claims are deliberately excluded:

1. **Claims that contradict Tier-A literature.** None were found in the RohOnChain archive that meets this bar — the framework material aligns with canonical literature. If a future archive entry contradicts Tier-A, it goes in the archive file with verdict `CONTRADICTS_TIER_A` and stays out of the course body entirely.
2. **Claims that are unverifiable.** The "Neural Networks" thread referenced in the search log ([`_archive/x-search-attempt-2026-05-26.md` §3](_archive/x-search-attempt-2026-05-26.md)) is gated and its content could not be retrieved. Until a verbatim copy is recovered, nothing from that thread is integrated.

## C.3 How this appendix gets updated

This appendix is a living document. The protocol for adding a new entry:

1. Capture the source thread / post in a new `_archive/roan-<topic>-<YYYY-MM-DD>.md` file using the existing archive files as a template (header table → verbatim text or paraphrase → §E claims extraction table with Tier-A mapping → §F promotion plan → §G what-does-not-promote).
2. Map each claim to its strongest Tier-A source. Add the Tier-A citation to the relevant chapter's §X.Y citations block. Update [`appendix-b-sources.md` §B.3](appendix-b-sources.md) with a row for the new archive file.
3. Add a Q&A entry to this appendix for each claim that meets the promotion bar (verdict `AGREES_WITH_TIER_A` or `EXTENDS_TIER_A` with a defensible mapping). Skip claims that are unverifiable or that contradict Tier-A literature.
4. If a claim becomes operationally load-bearing in a chapter body, add a `!!! note "Practitioner note (from RohOnChain archive)"` callout under the relevant section, citing back to the archive file by path.

The point of the appendix's structure is that Tier-C lore is never the *sole* support for any course claim — every entry above maps to Tier-A literature. The practitioner threads are valuable for their operational sharpness, not for their authority.
