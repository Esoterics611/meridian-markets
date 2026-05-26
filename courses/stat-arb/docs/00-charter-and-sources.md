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
| **C — Practitioner commentary** | Blog posts, X threads, podcasts. Useful for code-shape intuition; never load-bearing. **Always marked unverified until the source is fetched and cross-checked against Tier A.** | The "rohn / roan" X thread the user referenced — **[TODO: verify]** |

**Promotion rule.** A Tier-C source is never used as the sole support for a claim. It can illustrate something Tier A already proves. If a Tier-C source contradicts Tier A, Tier A wins.

## 0.4 Outstanding source-verification asks

The user mentioned recently-shared "secrets from hedge funds" on X by a user named "rohn / roan" (exact handle uncertain). I cannot WebFetch from this session, so I cannot verify either the handle or the content. The next session must:

1. **Get the actual X handle** from the user — current best guess is `@rohn` or `@roan` but neither is confirmed; could also be `@rohan…`, `@ronh…`, etc.
2. **Fetch the thread(s)** — capture the URL, archive a copy (X content rots fast), extract the claims.
3. **Map each claim to a Tier-A source.** If it doesn't map, treat it as folklore — interesting, not citable.
4. **Update the relevant chapter section** with the verified citation; remove the `[TODO: verify]` marker.

Until then, all chapters cite only Tier A and (pending verification) Tier B sources. The X thread is mentioned by name in §0.5 and Appendix B with explicit unverified status.

## 0.5 The X thread (unverified — placeholder)

!!! warning "Unverified source — do not cite as fact"
    A practitioner thread on X (formerly Twitter) by a user the team recalls as **"rohn"** or **"roan"** was reportedly sharing operational details from buyside stat-arb desks. **The handle, thread URL, and content are all currently unverified.**

    **Likely useful for** (based on what such threads typically cover, not what this specific thread says):

    - **Universe construction** — how desks filter the cointegration-candidate set to a tractable size; common heuristics like sector-bucketing, volume floors, and recency filters.
    - **Spread-staleness diagnostics** — practical signals that a previously-cointegrated pair has drifted regime (correlation half-life dropping, ADF p-value rising).
    - **Execution heuristics** — passive vs aggressive order placement in the entry vs exit window; the asymmetry that comes from holding-cost discipline.
    - **Funding-rate carry hooks** — for crypto-specifically, when funding skew is the strategy vs the friction.

    **Next-session task:** verify the handle, fetch the thread, map each claim to Tier-A literature in §2–§5. Until then, none of the above is asserted as the thread's content — it's a checklist of what to *look for* when the source is recovered.

## 0.6 Verified sources used in this course

(Full citations in [Appendix B](appendix-b-sources.md). Quick-list here so the rest of the course can reference them by short tag.)

- **EG87** — Engle & Granger, "Co-Integration and Error Correction" (Econometrica, 1987). The foundational two-step cointegration procedure.
- **J91** — Johansen, "Estimation and Hypothesis Testing of Cointegration Vectors in Gaussian Vector Autoregressive Models" (Econometrica, 1991). The multi-variate cointegration test.
- **AL10** — Avellaneda & Lee, "Statistical Arbitrage in the U.S. Equities Market" (Quantitative Finance, 2010). PCA + OU residuals — the canonical "modern" stat-arb formulation.
- **B10** — Bertram, "Analytic Solutions for Optimal Statistical Arbitrage Trading" (Physica A, 2010). Closed-form OU entry/exit thresholds.
- **MLDP18** — López de Prado, *Advances in Financial Machine Learning* (Wiley, 2018). Purged k-fold CV; correct ML methodology for time series.

Tier-B (open-source repos) and Tier-C (practitioner) sources live in [Appendix B](appendix-b-sources.md) with their verification status.
