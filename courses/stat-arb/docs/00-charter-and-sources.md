# 0. Course charter & sources

## 0.1 Why this course exists

Meridian Markets' [PHASED_PLAN.md](../../../PHASED_PLAN.md) commits to a 12-month audited NAV before opening any fund product (Phase 3 → Phase 4). Statistical arbitrage is the cheapest strategy book that produces the supporting artifacts: cointegration tests, mean-reversion estimation, multi-strategy risk attribution, daily NAV machinery. Building it carefully — and **documenting it as we go** — is the difference between "we have backtests" and "we have an audited track record an LP will accept."

This course is the documentation layer of that build. It runs ahead of the code, so the engineering plan is grounded in math we can defend.

## 0.2 What this course is NOT

- **Not a textbook.** No proof of every claim. Cited where the proof is.
- **Not a "secrets revealed" pitch.** Stat arb is a 30-year-old field; nothing in it is secret. If something looks too good, it has a hidden assumption — flagged explicitly in §1.
- **Not investment advice.** First-party engineering material for Meridian Markets only.

## 0.3 Source-collection method

Every claim in this course should be traceable to one of three tiers:

| Tier | Description | Examples |
|---|---|---|
| **A — Foundational literature** | Peer-reviewed papers or textbooks. Verified citations. | Engle & Granger (1987), Johansen (1991), Avellaneda & Lee (2010), Bertram (2010), López de Prado (2018) |
| **B — Reference implementations** | Open-source code we can read. URLs verified before citing. | `mlfinlab`, `arbitragelab`, `zipline`, `pysystemtrade`, `jesse-ai/jesse` — **URLs pending WebFetch verification next session** |
| **C — Practitioner commentary** | Blog posts, X threads, podcasts. Useful for code-shape intuition; never load-bearing. Always marked unverified until the source is fetched and cross-checked against Tier A. | The [@RohOnChain](https://x.com/RohOnChain) X threads — verified 2026-05-26, archived in [`_archive/`](appendix-c-practitioner-lore.md). |

**Promotion rule.** A Tier-C source is never used as the sole support for a claim. It can illustrate something Tier A already proves. If a Tier-C source contradicts Tier A, Tier A wins.

## 0.4 Outstanding source-verification asks — resolved 2026-05-26 (Session 3)

The user-mentioned "rohn / roan" X handle was confirmed as **@RohOnChain** (display name "Roan"). Two substantive threads were archived and promoted to Tier-C verified status; see §0.5 below and [Appendix B §B.3](appendix-b-sources.md) for the verification ledger. One additional thread (the "Neural Networks" thread) was located but its body was gated at fetch time — it remains uncited in the course body.

## 0.5 The RohOnChain archive (verified Tier-C)

!!! success "Verified source — cited alongside Tier-A material per §0.3"
    Handle: [`@RohOnChain`](https://x.com/RohOnChain) (display name "Roan", ≈ 47.3K followers, bio: *"building my life around quant systems in prediction markets and crypto on chain"*). Verified by direct user confirmation 2026-05-26 plus cross-referencing against a third-party companion repo (`jackson-video-resources/markov-hedge-fund-method`, 211 ⭐, MIT-licensed, explicit Roan attribution).

    **Two threads archived:**

    1. **Markov Hedge Fund Method** — observable Markov regime detection (Bull / Sideways / Bear) with optional HMM upgrade, walk-forward backtesting, JSON composition contract. Captured verbatim from the public companion repo. Archive: [`_archive/roan-markov-hedge-fund-method-2026-05-26.md`](_archive/roan-markov-hedge-fund-method-2026-05-26.md). Cited in §2.9, §3.6, §5.3, §6.5, Appendix C.

    2. **Fundamental Law of Active Management / "50 weak signals"** — operationalises $\text{IR} = \text{IC} \cdot \sqrt{N_{\text{eff}}}$, the effective-$N$ correction, signal orthogonalisation, and Kelly-with-edge-uncertainty sizing. Captured as paraphrase (original X thread gated; verbatim retrieved second-hand from third-party write-ups). Archive: [`_archive/roan-fundamental-law-active-mgmt-2026-05-26.md`](_archive/roan-fundamental-law-active-mgmt-2026-05-26.md). Cited in §2.8, §5.2, §6.5, §6.7, Appendix C.

    **Promotion discipline.** All 20 claims extracted from the two archives were mapped to Tier-A literature (Hamilton 1989, Rabiner 1989, Grinold 1989, Grinold & Kahn 1999, Clarke et al. 2002, Bailey & López de Prado 2014, López de Prado 2018, Asness et al. 2013). Per §0.3's promotion rule, none of the practitioner claims is the *sole* support for any course assertion — each is cited alongside its Tier-A mapping. The two archive files exist as primary record (so the course retains its own copy if the X timeline rots) and as Tier-C citation target.

    **One thread not promoted:** the "Neural Networks" thread (`https://en.rattibha.com/thread/2052043443766194272`) had its body gated at fetch time. Title and lead are visible; body is not. Documented in [`_archive/x-search-attempt-2026-05-26.md` §3](_archive/x-search-attempt-2026-05-26.md). Not integrated into the course body.

## 0.6 Verified sources used in this course

(Full citations in [Appendix B](appendix-b-sources.md). Quick-list here so the rest of the course can reference them by short tag.)

- **EG87** — Engle & Granger, "Co-Integration and Error Correction" (Econometrica, 1987). The foundational two-step cointegration procedure.
- **J91** — Johansen, "Estimation and Hypothesis Testing of Cointegration Vectors in Gaussian Vector Autoregressive Models" (Econometrica, 1991). The multi-variate cointegration test.
- **AL10** — Avellaneda & Lee, "Statistical Arbitrage in the U.S. Equities Market" (Quantitative Finance, 2010). PCA + OU residuals — the canonical "modern" stat-arb formulation.
- **B10** — Bertram, "Analytic Solutions for Optimal Statistical Arbitrage Trading" (Physica A, 2010). Closed-form OU entry/exit thresholds.
- **MLDP18** — López de Prado, *Advances in Financial Machine Learning* (Wiley, 2018). Purged k-fold CV; correct ML methodology for time series.

Tier-B (open-source repos) and Tier-C (practitioner) sources live in [Appendix B](appendix-b-sources.md) with their verification status.
