# 0. Course charter & sources

!!! abstract "Where this chapter fits"
    **Read first.** This chapter defines the source-tiering rule that every later citation relies on. Without it, the "Tier-A / Tier-B / Tier-C" labels in [§2–§7](01-introduction.md) and the [appendices](appendix-b-sources.md) lose their meaning.
    **Continue with:** [§1 — what stat arb is](01-introduction.md) for the framing, then [§2 cointegration](02-cointegration.md).

## 0.1 Why this course exists

Statistical arbitrage is one of the most over-promised topics in quantitative finance. On any given week the internet will hand you a "cointegrated pairs strategy that returned 47% in backtest" and ask you to take it on faith. Most of those strategies do not survive ten minutes of careful examination — they are curve-fit, survivorship-biased, transaction-cost-optimistic, or all three.

There is also a real, working version of the field. Its results are less spectacular than the marketing material but they are *reproducible*. The papers behind it date from the 1980s to the present and are mostly readable. The open-source implementations are mature. The operational discipline of a desk that compounds capital on these strategies for years is a set of habits, not a set of secrets.

This course tries to bridge the two camps honestly. It assumes you already know the marketing material is mostly noise. It points you at the parts of the field that are real, names the load-bearing results, and walks through them in enough detail that you can implement, test, and operate a pairs-trading or mean-reversion book without lying to yourself about what it does. The voice is deliberately flat: no exclamation marks, no "secrets," no shortcuts.

The course was originally written as the math-and-code-shape foundation for a real prop-trading book — the operational discipline below is the discipline that book actually uses. It has been generalised for public release: every chapter stands alone, the proprietary references have been stripped, and the strategy skeletons in §2 and §3 are the textbook canonical forms with no hidden parameters.

## 0.2 What this course is NOT

- **Not a textbook.** A textbook would prove every claim. We cite where the proof is and tell you the truth about which proofs are worth reading. You should read [Avellaneda & Lee (2010)](appendix-b-sources.md#b1-tier-a-foundational-literature-verified) end-to-end at some point; you can safely skim Engle & Granger (1987) once you've used the test ten times.
- **Not a "secrets revealed" pitch.** Stat arb is a thirty-year-old field. Nothing in it is secret. If a chapter, blog, or course tells you it has *the* trick that makes a textbook strategy profitable, it has a hidden assumption it isn't telling you about. The honest read is that the strategies are public; the *operational* discipline is what makes them produce returns; the *infrastructure* discipline is what makes the operations sustainable. We cover all three.
- **Not investment advice.** This is engineering and methodology material. It will help you understand a field; it will not tell you what to put your savings into. Run your own backtests on your own data with your own risk parameters, and if you are deploying actual capital, talk to a regulated professional first.
- **Not a finished work.** The course is an actively maintained document. Where we say "this is the conservative middle of practitioner ranges" or "URLs pending verification" we mean it — the source-vetting process is itself part of the discipline, not a polish layer.

## 0.3 Source-collection method

Every claim in this course should be traceable to one of three tiers. The tiering matters because the most common way to be wrong in quant finance is to read one practitioner blog post, treat it as gospel, and never check whether the underlying claim survives a peer-reviewed treatment.

| Tier | Description | Examples | What it can support |
|---|---|---|---|
| **A — Foundational literature** | Peer-reviewed papers or textbooks. Verified citations with full bibliographic detail. The proof of the underlying mathematical claim lives here. | Engle & Granger (1987), Johansen (1991), Avellaneda & Lee (2010), Bertram (2010), López de Prado (2018) | Any claim. These are the load-bearing citations. |
| **B — Reference implementations** | Open-source code we can read. URLs verified before citing. The *implementation* of a Tier-A result lives here, with all the corner cases the paper glossed over. | `mlfinlab`, `arbitragelab`, `statsmodels`, `zipline`, `pysystemtrade`, `jesse-ai/jesse` | "Here is one way to implement claim X." Cannot support a claim about *what is true* — only "what one project did." |
| **C — Practitioner commentary** | Blog posts, X threads, podcasts, conference talks. Useful for code-shape intuition and operational sharpness; never load-bearing on its own. Always marked unverified until the source is fetched and cross-checked against Tier A. | The [@RohOnChain](https://x.com/RohOnChain) X threads — verified 2026-05-26, archived in [`_archive/`](appendix-c-practitioner-lore.md). | "Here is operational lore that's worth knowing." Only cited when paired with a Tier-A mapping that supports the underlying claim. |

**Promotion rule.** A Tier-C source is never used as the sole support for a claim in this course. It can illustrate something Tier A already proves, or operationalise something Tier A states abstractly, but if it contradicts Tier A then Tier A wins. The reason is concrete: a peer-reviewed paper has been scrutinised by trained reviewers; a thread on X has not. Both can be right; only one has been checked.

**Why this matters in practice.** A lot of the noise in this field comes from confusing the *operational* sharpness of a practitioner source with the *mathematical* authority of a peer-reviewed source. A practitioner who runs a pairs-trading book may have excellent intuition for "this is when the fit breaks" without being able to write down the formal hypothesis test that catches it. A peer-reviewed paper may have the formal test but not the intuition. The two together are stronger than either alone, but only if you keep straight which is which.

A worked example: §5.2 of this course cites a practitioner sharpening of the Kelly criterion (the $f_{\text{empirical}} = f_{\text{Kelly}} \cdot (1 - \text{CV}_{\text{edge}})$ form). The underlying *mathematics* — Kelly itself — is Kelly (1956); the *shrinkage* argument is Thorp (2006); the *specific functional form* with CV-of-edge is a practitioner refinement. The course retains the textbook default (quarter-Kelly) and presents the practitioner form as the upgrade path, which is exactly the discipline the promotion rule describes.

## 0.4 How to consume the rest of the book

The chapters are designed to be read in order, but each chapter's "Where this chapter fits" abstract names what it depends on and what depends on it, so you can chart your own path. Three usage patterns:

**The full read.** §0 → §1 → §2 → §3 → §4 → §5 → §6 → §7, then the appendices as reference. Roughly twelve to twenty hours of careful reading, plus whatever time you spend implementing the code shapes and running your own backtests. This is the path that takes a smart newcomer to working-quant proficiency.

**The fast-orient.** §1 and §7 together give the cost / benefit picture: what stat arb actually is, and what the operational envelope looks like. Two hours of reading, no math required. Use this if you're vetting whether the whole programme is worth your engineering time.

**The reference-lookup.** Use the chapter map in [the home page](index.md) to find the specific topic, jump in. Every chapter's first section is a self-contained "what is this and why does it matter," so you can drop in without reading the predecessors. Cross-chapter links resolve to the section level so you can follow the trail.

## 0.5 The RohOnChain archive (verified Tier-C)

A particular case study in the source-tiering rule. Tier-C material from [@RohOnChain](https://x.com/RohOnChain) (display name "Roan", ≈ 47.3K followers, bio: *"building my life around quant systems in prediction markets and crypto on chain"*) appears throughout the course because the threads materially sharpen specific operational details — the persistence-diagonal-of-the-transition-matrix check in §2.9, the multi-seed-HMM-fit discipline in §3.6, the orthogonalised-effective-$N$ argument in §6.5. Every claim is paired with its Tier-A foundation:

!!! success "Verified source — cited alongside Tier-A material per §0.3"
    Handle: [`@RohOnChain`](https://x.com/RohOnChain) (display name "Roan"). Verified 2026-05-26 by direct user confirmation plus cross-referencing against a third-party companion repo (`jackson-video-resources/markov-hedge-fund-method`, 211 ⭐, MIT-licensed, explicit Roan attribution).

    **Two threads archived:**

    1. **Markov Hedge Fund Method** — observable Markov regime detection (Bull / Sideways / Bear) with optional HMM upgrade, walk-forward backtesting, JSON composition contract. Captured verbatim from the public companion repo. Archive: [`_archive/roan-markov-hedge-fund-method-2026-05-26.md`](_archive/roan-markov-hedge-fund-method-2026-05-26.md). Cited in §2.9, §3.6, §5.3, §6.5, Appendix C.

    2. **Fundamental Law of Active Management / "50 weak signals"** — operationalises $\text{IR} = \text{IC} \cdot \sqrt{N_{\text{eff}}}$, the effective-$N$ correction, signal orthogonalisation, and Kelly-with-edge-uncertainty sizing. Captured as paraphrase (original X thread gated; verbatim retrieved second-hand from third-party write-ups). Archive: [`_archive/roan-fundamental-law-active-mgmt-2026-05-26.md`](_archive/roan-fundamental-law-active-mgmt-2026-05-26.md). Cited in §2.8, §5.2, §6.5, §6.7, Appendix C.

    **Promotion discipline.** All 20 claims extracted from the two archives were mapped to Tier-A literature (Hamilton 1989, Rabiner 1989, Grinold 1989, Grinold & Kahn 1999, Clarke et al. 2002, Bailey & López de Prado 2014, López de Prado 2018, Asness et al. 2013). Per §0.3's promotion rule, none of the practitioner claims is the *sole* support for any course assertion — each is cited alongside its Tier-A mapping. The two archive files exist as primary record (so the course retains its own copy if the X timeline rots) and as Tier-C citation target.

    **One thread not promoted:** the "Neural Networks" thread (`https://en.rattibha.com/thread/2052043443766194272`) had its body gated at fetch time. Title and lead are visible; body is not. Documented in [`_archive/x-search-attempt-2026-05-26.md` §3](_archive/x-search-attempt-2026-05-26.md). Not integrated into the course body.

The case study generalises: any Tier-C source you find — a blog post, a tweet, a podcast clip — should go through the same promotion process before you let it shape your strategy. Find the underlying Tier-A claim it's operationalising; if there isn't one, treat the practitioner claim as a *hypothesis to test*, not as a result.

## 0.6 Verified sources used in this course

(Full citations in [Appendix B](appendix-b-sources.md). Quick-list here so the rest of the course can reference them by short tag.)

- **EG87** — Engle & Granger, "Co-Integration and Error Correction" (Econometrica, 1987). The foundational two-step cointegration procedure.
- **J91** — Johansen, "Estimation and Hypothesis Testing of Cointegration Vectors in Gaussian Vector Autoregressive Models" (Econometrica, 1991). The multi-variate cointegration test.
- **AL10** — Avellaneda & Lee, "Statistical Arbitrage in the U.S. Equities Market" (Quantitative Finance, 2010). PCA + OU residuals — the canonical "modern" stat-arb formulation.
- **B10** — Bertram, "Analytic Solutions for Optimal Statistical Arbitrage Trading" (Physica A, 2010). Closed-form OU entry/exit thresholds.
- **MLDP18** — López de Prado, *Advances in Financial Machine Learning* (Wiley, 2018). Purged k-fold CV; the correct methodology for ML on time-series data.

Tier-B (open-source repos) and Tier-C (practitioner) sources live in [Appendix B](appendix-b-sources.md) with their verification status.
