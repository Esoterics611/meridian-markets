# Market Making — A Working Course

> Theory, math, and code for the strategy family that pays *the other half* of the rent on modern quant desks. The companion to [statistical arbitrage](../stat-arb/index.md) — same flat voice, same citation discipline, same refusal to ship equity curves as proof.

## Who this is for

You are the same reader as the stat-arb course's reader. Smart, patient, comfortable in code. You don't need a PhD; you do need:

- **Linear algebra and probability at undergraduate level.** Conditional expectation, Bayes' rule, Brownian motion at the level of "I've seen Itô's lemma once."
- **Comfort with stochastic processes.** Not deep — the level of a one-term graduate course or a self-study read of Shreve I/II up to chapter 4. The OU process is the bridge between stat arb and market making; if you read §3 of the stat-arb course, you have what you need.
- **Comfort reading code.** TypeScript for the code shapes; Python (`numpy`, `pandas`, `nautilus_trader`) where the canonical reference implementation lives there.
- **Patience with the field's culture.** Market making is at least as old as stat arb. The math is settled (Glosten-Milgrom 1985, Kyle 1985, Avellaneda-Stoikov 2008 are the three load-bearing papers). What changes year-to-year is the venue plumbing.

If you read every chapter, work the exercises, and run an honest LOB replay backtest, you come out the other side with the working knowledge of a junior quoter on a market-making desk. That's the bar.

## What this course actually is

The complete working syllabus for one strategy family — *electronic market making* — covered the way the field teaches itself in practice. Every chapter follows the same shape:

1. **What it is** — one paragraph, plain language.
2. **Math sketch** — the minimum equations you need to implement it.
3. **When it works / when it breaks** — the empirical edges of the result.
4. **Code shape** — TypeScript interfaces and pure functions you can type into a project.
5. **Sources** — papers, repos, practitioner threads.

It is **not** a textbook. It is also **not** a "we'll show you Citadel Securities' secret quote-sizing rule" pitch. The math is in the public literature; the edge is in latency, queue position, risk discipline, and the operational stack the math sits inside.

## How it relates to the stat-arb course

Stat arb and market making are the two systematic-quant strategy families that pay the rent on modern desks. They share infrastructure (the execution layer, the risk layer, the backtest layer) but the *signal* and the *operational rhythm* are different:

| | Stat arb | Market making |
|---|---|---|
| **The bet** | A spread reverts | The spread (bid-ask) compensates inventory + adverse selection |
| **Holding period** | Hours to weeks | Milliseconds to minutes |
| **Edge source** | Universe filtering + regime detection | Latency, queue position, inventory control |
| **What kills you** | Cointegration break | Toxic flow, adverse selection, inventory blow-up |
| **Capital efficiency** | Moderate | High (if you're fast); low (if you're not) |
| **Op tempo** | Hourly review | Microsecond-level monitoring |

If you've read the stat-arb course's §4 (execution) and §5 (risk), you've seen most of the infrastructure; this course adds the **microstructure layer** below them and the **inventory-aware quoting layer** above.

## How to read this

| You are... | Start here | Then read |
|---|---|---|
| Brand new — never read the stat-arb course | [stat-arb §1](../stat-arb/01-introduction.md) | come back, then read §1, §2, §3 in order |
| Have read stat-arb | [§1](01-introduction.md) | §2 → §3 in order |
| Software engineer, want the code shape | [§4 execution](04-execution.md) → [Appendix A](appendix-a-code-shapes.md) | §3 backwards for the math |
| Already a quant; want the operational discipline | [§5 risk](05-risk.md) | §7 production, §6 backtesting |
| Kicking the tyres — should I invest a weekend? | [§1](01-introduction.md) | [§7](07-production.md) — the cost / benefit picture |

## Chapter map

| # | Chapter | What you'll be able to do after reading it |
|---|---|---|
| 0 | [Course charter & sources](00-charter-and-sources.md) | Apply the same source-tiering rule the stat-arb course used; tell a Tier-A paper from a Tier-C tweet. |
| 1 | [What market making actually is](01-introduction.md) | Define market making in one paragraph. Name the three components of the bid-ask spread. Recognise the five most common ways a market-making strategy fails. |
| 2 | [Microstructure foundations](02-microstructure.md) | Read a limit order book. State Glosten-Milgrom and Kyle in one sentence each. Decompose a quoted spread into order-processing, inventory, and adverse-selection components. |
| 3 | [Avellaneda-Stoikov & inventory-aware quoting](03-avellaneda-stoikov.md) | Derive the Avellaneda-Stoikov optimal quotes, explain the inventory-skew term, and recognise the model's failure modes. |
| 4 | [Execution & queue position](04-execution.md) | Place a quote that earns rebates and holds queue position. Decide when to cancel-and-replace vs hold. Wire the venue abstraction so a backtest doesn't lie. |
| 5 | [Risk, inventory, kill switches](05-risk.md) | Set inventory limits, adverse-selection circuit breakers, and toxicity gates. Know which fire automatically and which require an operator. |
| 6 | [Backtesting & LOB replay](06-backtesting.md) | Run an LOB-replay backtest that respects queue position. Calibrate a fill-probability model. Recognise the three most common backtest pathologies before they ship. |
| 7 | [From paper to production](07-production.md) | Take a quoter from shadow mode to minimum-capital live to full allocation along a published ramp, with named acceptance bands. |
| A | [Code-shape catalogue](appendix-a-code-shapes.md) | Recognise the recurring TypeScript patterns the chapters lean on. |
| B | [Source notebook](appendix-b-sources.md) | Look up any citation in the course. |

## What you will *not* get from this course

- **A profitable quoter you can run on Monday.** Same answer as the stat-arb course. The math is public; the edge is the infrastructure around it.
- **Backtest plots.** LOB-replay backtests can be made to look like anything. We teach the *method* in §6 and trust you to run your own.
- **Latency-arms-race material.** This course assumes you're trading on a venue and exchange tier where you are *not* the fastest participant. The math we teach (Avellaneda-Stoikov, Glosten-Milgrom decomposition, inventory skew) is the math that matters when you're competing on quote quality and inventory management rather than on co-located FPGAs. If you want to learn the latency game, you need a different course and a different employer.
- **Anything you can't audit.** Every step is traceable to a paper or a repo we've kept a copy of.

## Why we wrote it this way

Market making is older than stat arb. The math is more settled, the operational stack is more demanding, and the operational tempo is brutal. Most published material falls into one of two camps: textbooks that prove every theorem and ship no code (Cartea–Jaimungal–Penalva is the honorable exception), or marketing courses that ship every claim and prove nothing. This course is the third camp — the math you actually need to implement, the code shape that survives contact with production, and an honest accounting of the limits of the result.

The voice is deliberately flat. If a chapter sounds like a textbook you've seen before, that's because the underlying math has not changed in twenty years.
