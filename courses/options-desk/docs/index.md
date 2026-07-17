# Long-Horizon Options — A Working Course

> Theory, math, and code for the third strategy family on the desk: **options held for weeks to months**, where the *structure* — not reaction speed — carries the risk discipline. The companion to [market making](../../market-making/docs/index.md) and [statistical arbitrage](../../stat-arb/docs/index.md) — same flat voice, same citation discipline, same refusal to ship equity curves as proof.

## Who this is for

The same reader as the other two courses. Smart, patient, comfortable in code. You don't need a PhD; you do need:

- **Probability at undergraduate level.** Expectation, variance, the normal distribution, and enough comfort with Brownian motion to read Black-Scholes without flinching. If you worked through stat-arb §3 (the OU process), you're over-prepared.
- **The gamma-theta reflex, or the willingness to build it.** One identity — $\Theta \approx -\tfrac{1}{2}\Gamma S^2\sigma^2$ — organizes this entire field. Chapter 2 derives it; every later chapter uses it.
- **Comfort reading code.** TypeScript for the code shapes; the working engine this course is grounded in is real and cited by file path.
- **Patience with slow feedback.** Market making tells you in hours whether you're wrong. A 30-day option cycle tells you twelve times a year. Chapter 12 is about the discipline that gap demands — it is the most important chapter in the course.

If you read every chapter, work the examples, and internalize the sizing discipline, you come out with the working knowledge of a junior trader on an options overlay desk — the person trusted to run the wheel and the collar book, not yet the person setting the vega budget. That's the bar.

## What this course actually is

The complete working syllabus for **long-horizon options investing** — the strategy family institutional desks run as "overlay," "overwriting," or "defensive equity" mandates, taught the way the field actually works. Every chapter follows the same shape:

1. **What it is** — one paragraph, plain language.
2. **Math sketch** — the minimum equations you need to implement it.
3. **When it works / when it breaks** — the empirical edges of the result.
4. **Code shape** — TypeScript interfaces and pure functions you can type into a project.
5. **Sources** — papers, indices, practitioner books.

It is **not** a payoff-diagram tour, and it is **not** an "income secrets" pitch — the internet is drowning in both. Selling options is not free money; it is being *paid a measurable premium to warehouse a measurable risk*, and the entire craft is in the measuring, the sizing, and the honesty of the accounting. The one structural edge in this field — the variance risk premium — is public knowledge with four decades of literature. What separates desks that survive from accounts that blow up is everything around it.

## How it relates to the other two courses

Three strategy families, three op tempos, one infrastructure:

| | Stat arb | Market making | Long-horizon options |
|---|---|---|---|
| **The bet** | A spread reverts | The bid-ask spread compensates inventory + adverse selection | Implied vol exceeds realized; convexity is mispriced at the wings |
| **Holding period** | Hours to weeks | Milliseconds to minutes | Weeks to months |
| **Edge source** | Universe filtering + regime detection | Latency, queue position, inventory control | The variance risk premium + structure selection + sizing |
| **What kills you** | Cointegration break | Toxic flow, inventory blow-up | The fat left tail: one vol spike returning years of theta |
| **Risk control lives in** | The stop and the re-fit | The re-quote (milliseconds) | **The structure, chosen at entry** |
| **Feedback cadence** | Days | Hours | Months — see chapter 12 |

The third column is the odd one out in a specific way: it is the only family where the risk discipline can be made **provable at entry** (a credit spread's max loss is a number on the fill ticket; a collared position cannot breach its floor). That property is why this desk exists on a mandate whose first commandment is *conserve equity*.

## How to read this

| You are... | Start here | Then read |
|---|---|---|
| New to options entirely | [§2 pricing](02-pricing-engine.md) — slowly | §1, §3, then §4–§6 in order |
| Have read the MM course | [§1](01-introduction.md) | §3 (the VRP is the through-line), then in order |
| Retail options seller wanting rigor | [§3 VRP](03-variance-risk-premium.md) | §4 (the wheel done honestly), §9, then **§12 twice** |
| Already a vol trader; want the desk design | [§11 portfolio](11-portfolio-construction.md) | §12, §13, Appendix A |

The chapter sequence is deliberate: instrument (§2) → edge (§3) → the income books (§4–§6) → the relative-value books (§7–§8) → the insurance and efficiency overlays (§9–§10) → the desk (§11–§13). Each strategy chapter trains one live book on the Meridian desk; the mapping is in [§13](13-the-meridian-options-desk.md).
