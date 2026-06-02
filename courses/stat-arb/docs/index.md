# Statistical Arbitrage — A Working Course

> Theory, math, and code for the strategy family that pays the rent on modern quant desks. No marketing voice, no "secrets revealed," and no curve-fit equity charts. The point is to make you genuinely dangerous, not to sell you a course.

## Who this is for

You're a smart newcomer with a working brain and some patience. Maybe a software engineer who reads quant papers on weekends. Maybe a graduate student in stats / physics / CS curious about whether the financial markets really are the playground people claim. Maybe you've traded a little, made some money, lost some money, and want to understand why.

You don't need a PhD in mathematics. You do need:

- **Linear algebra at undergraduate level.** OLS regression, eigenvalues, basic matrix calc. We assume you've seen the normal equations at least once.
- **Probability and statistics at undergraduate level.** Mean, variance, normal distribution, hypothesis testing, p-values. We won't re-derive the central limit theorem.
- **Comfort reading code.** Code samples are TypeScript; the math we cite is in Python (`statsmodels`, `numpy`, `mlfinlab`) because the canonical open-source implementations live there.
- **Patience with the field's culture.** Stat arb is decades old. Most of the "discoveries" you'll read about online are either wrong, illusions of an in-sample backtest, or open secrets the field worked out in the 1990s. This course is built to skip past that noise.

If you read every chapter, work the exercises in your own code, and run an honest backtest on a small universe of your own choosing, you will come out the other side with the working knowledge of a junior quant on a pairs-trading or mean-reversion desk. That's the bar.

## What this course actually is

It is the **complete** working syllabus for one strategy family — *statistical arbitrage* — covered the way the field teaches itself in practice. Every chapter follows the same shape:

1. **What it is** — one paragraph, plain language, no jargon you haven't earned.
2. **Math sketch** — the minimum equations you need to implement it. Each symbol is named; each step is justified.
3. **When it works / when it breaks** — the empirical edges of the result. Where you should trust it; where the literature is honest about the limits.
4. **Code shape** — TypeScript interfaces and pure functions you can actually type into a project. The shape is opinionated; the math is canonical.
5. **Sources** — papers, repos, practitioner threads. Every chapter ends with a citations block, and every claim in the body is traceable to one of them.

It is **not** a textbook. We don't prove every claim — we cite where the proof is, and we tell you the truth about which proofs are worth reading and which are surprisingly readable. It is also **not** a magic-strategy-revealed pitch; if anyone tells you their stat-arb course will make you rich on default parameters, they are either lying or have not run a calibrated backtest. The strategies in §2 and §3 are real; the **defaults are skeletons**. The edge is the discipline you put around the skeletons.

## How to read this

| You are... | Start here | Then read |
|---|---|---|
| New to quant trading entirely | [§0 — charter & sources](00-charter-and-sources.md) | §1, §2, §3 in order. Stop when §2 stops making sense and come back. |
| A software engineer who wants the codebase shape | [§1](01-introduction.md) for framing | [§4 execution](04-execution.md) → [Appendix A](appendix-a-code-shapes.md). The code patterns repeat. |
| Already a quant; want the operational discipline | [§6 backtesting](06-backtesting.md) | [§7 production](07-production.md), [§5 risk](05-risk.md). |
| Just kicking the tyres — should I invest a weekend? | [§1](01-introduction.md) | [§7](07-production.md). Together they're the cost / benefit picture. |

## Chapter map

| # | Chapter | What you'll be able to do after reading it |
|---|---|---|
| 0 | [Course charter & sources](00-charter-and-sources.md) | Tell a Tier-A peer-reviewed source from a Tier-C practitioner thread, and know which one wins when they disagree. |
| 1 | [What stat arb actually is](01-introduction.md) | Define stat arb in one paragraph. Name the four standard families. Recognise the five most common ways a strategy fails. |
| 2 | [Cointegration & pairs trading](02-cointegration.md) | Run an Engle-Granger test in your sleep. Build a defensible cointegrated-pair universe from a basket of candidates. Know when a cointegration is "going stale" before P&L tells you. |
| 3 | [Ornstein-Uhlenbeck mean reversion](03-ou-process.md) | Fit an OU process to a spread, derive Bertram's optimal entry/exit thresholds, and read the resulting parameters to detect a regime change. |
| 4 | [Execution & venue abstraction](04-execution.md) | Wire a strategy into an execution layer that doesn't lie to your backtest. Place orders that are passive on entry and aggressive on exit, and explain why. |
| 5 | [Risk, sizing, circuit breakers](05-risk.md) | Size a position by fractional Kelly with appropriate shrinkage. Build a drawdown gate and a kill switch. Know which circuit breakers fire automatically and which ones require an operator. |
| 6 | [Backtesting honestly](06-backtesting.md) | Run a purged k-fold cross-validation, report a deflated Sharpe ratio, calibrate a slippage model against live fills, and recognise the three most common backtest pathologies before they ship. |
| 7 | [From paper to production](07-production.md) | Take a strategy from shadow mode to minimum-capital live to full allocation along a published ramp, with named acceptance bands at every step. |
| 8 | [More strategies — baskets & funding carry](08-more-strategies.md) | Generalise from two-leg pairs to N-leg baskets (Johansen weights) and to funding/carry spreads. |
| 9 | [Testing the lessons in Meridian Markets](09-testing-in-meridian.md) | Run every lesson against the real engine — paper-trade on live data and read the validation harness output. |
| 10 | [Stat-arb in equities](10-equities-stat-arb.md) | Build a money-making same-sector equity pair: the factor model behind the spread, the signal/sizing hedge-ratio split, the short-borrow/dividend cost stack, and the daily-bar trade-count constraint that decides whether it validates. |
| A | [Code-shape catalogue](appendix-a-code-shapes.md) | Recognise the ten recurring TypeScript patterns the chapters lean on, with Jest test shapes for each. |
| B | [Source notebook](appendix-b-sources.md) | Look up any citation in the course; check the Tier-B repo URLs and licenses. |
| C | [Practitioner lore](appendix-c-practitioner-lore.md) | Read the practitioner threads that informed the chapter body, mapped onto their Tier-A foundations. |

## What you will *not* get from this course

- **A profitable strategy you can run on Monday.** That's a marketing offer, not an honest one. Strategies in textbooks lose money to fees and slippage on default parameters; the edge is in the universe filtering, regime detection, and execution discipline that we cover *around* the skeletons. The skeletons are skeletons on purpose.
- **Backtest plots.** Backtest plots in stat-arb courses are routinely curve-fit and routinely lie. We show you the *method* for an honest backtest in [§6](06-backtesting.md); you run your own. Anyone showing you their backtest equity curve as proof should be asked to also show you the 47 backtests they didn't show you.
- **Authoritative magic numbers.** Where the literature suggests a default (e.g. ADF p < 0.05 for cointegration, quarter-Kelly for sizing) we say so and cite. Where the default is arbitrary — z-score threshold of 2, refit cadence of "weekly" — we say *that*, too, and we use §6's sensitivity-sweep machinery to measure how much it matters.
- **Anything you can't audit.** Every step is traceable to a paper, a repo, or a practitioner archive that we've kept a copy of. If you disagree with us, you can read the source and argue back.

## Why we wrote it this way

Statistical arbitrage is a thirty-year-old field. The math is settled; the operational discipline is what separates desks that compound capital from desks that get a great year, a terrible year, and then quietly close. Most published material falls into one of two camps: textbooks that prove every theorem and ship no code, or marketing courses that ship every claim and prove nothing. This course is the third camp — the math you actually need to implement, the code shape that survives contact with production, and an honest accounting of the limits of the result.

The voice is deliberately flat. No exclamation marks, no "secrets," no "the one weird trick the desks don't want you to know." If a chapter sounds like a textbook you've seen before, that's because the underlying math has not changed in a generation — and pretending otherwise is the first step toward losing money.

## A note on practitioner sources

A small fraction of the course's operational sharpness comes from public practitioner threads — specifically the archive of work by [@RohOnChain](https://x.com/RohOnChain) (display name "Roan"), captured into the course's own [`_archive/`](_archive/) directory so it survives even if the original threads are taken down. Every practitioner claim is paired with its Tier-A peer-reviewed mapping (see [§0.3](00-charter-and-sources.md#03-source-collection-method)) — practitioner material illustrates, peer-reviewed material proves. Where the two disagree, peer-reviewed material wins.

The detailed Q&A version of the practitioner material is in [Appendix C](appendix-c-practitioner-lore.md); the archive files themselves live in [`docs/_archive/`](_archive/x-search-attempt-2026-05-26.md).
