# 0 · Course charter & sources

## The promise

Every claim in this course is one of three things, and is labeled as which:

1. **A theorem or identity** — derivable from stated assumptions (put-call parity, the delta-hedged P&L decomposition). These are true the way arithmetic is true.
2. **An empirical regularity with citations** — the variance risk premium, the expensiveness of index puts, the return profile of put-writing indices. These have decades of data behind them and can still stop working.
3. **A desk measurement** — a number produced by the Meridian engine on real market data, cited to its journal entry (e.g. "#12: BTC IV 37.1 vs RV 31.2"). These are the most honest numbers in the course *and* the thinnest samples. Both facts are stated wherever they appear.

What you will not find: payoff diagrams presented as strategy, backtests without cost models, the phrase "generate income" used as if the income were riskless, or any suggestion that a 90% win rate means anything without the size of the 10%.

## The one-sentence version of the whole course

**Option sellers are paid a persistent, measurable premium to warehouse convexity risk; the entire craft is sizing that trade so the fat left tail — which will arrive — is survivable, and accounting for it so honestly that the tail's arrival is boring.**

## Notation

| Symbol | Meaning |
|---|---|
| $S$ | spot price of the underlying |
| $K$ | strike |
| $T$, $\tau$ | expiry date; time to expiry in years |
| $\sigma$ | volatility (annualized, as a fraction: 0.37 = "37 vol") |
| $\sigma_i$, $\sigma_r$ | implied and realized volatility |
| $C$, $P$, $V$ | call, put, and generic option value |
| $\Delta, \Gamma, \Theta, \nu$ | delta, gamma, theta, vega (per the standard definitions in §2) |
| $N(\cdot)$, $\varphi(\cdot)$ | standard normal CDF and PDF |
| "25Δ put" | the put whose delta is −0.25 — the standard way desks name strikes, because deltas are comparable across expiries and vol levels while strikes are not |
| "vol point" | 0.01 of annualized vol: IV 37 vs RV 31 is a 6-vol-point spread |

Time is measured in **years** inside every formula and in **days** in every trading conversation; the conversion ($\tau = \text{days}/365$) is where beginners' numbers go wrong by a factor of 19.

## The load-bearing sources

The field is old and the math is public. Four books and a half-dozen papers carry most of the weight; the full annotated list is [Appendix B](appendix-b-sources.md).

**Books** — Natenberg, *Option Volatility and Pricing* (the practitioner's canon; strike selection and Greek intuition); Sinclair, *Volatility Trading* and *Positional Option Trading* (the quantitative practitioner's versions — closest in spirit to this course); Bennett, *Trading Volatility* (the sell-side encyclopedia: term structure, skew, dividends, everything); Hull, *Options, Futures and Other Derivatives* (the reference for §2's derivations).

**Papers** — Bakshi & Kapadia (2003) on delta-hedged gains and the negative volatility risk premium; Carr & Wu (2009) on variance risk premia; Coval & Shumway (2001) on expected option returns; Whaley (2002) on the CBOE PUT index; Israelov & Nielsen (2014, 2015) on covered calls; Israelov (2017), "Pathetic Protection," on protective puts; Figlewski (1989) and Whalley & Wilmott (1997) on hedging error and hedge bands; Santa-Clara & Saretto (2009) on margin and transaction costs in option strategies.

**Indices as evidence** — CBOE PUT (systematic cash-secured put-writing on SPX since 1986) and BXM (covered calls): four decades of investable, third-party-computed track record for the core claim of §4. Crypto has no equivalent index — which is exactly why the Meridian desk builds its own scored record (§12–§13).

**The desk's own measurements** — cited as journal entries (#12, #42, #96, …) throughout, with the sample sizes stated. Where a desk measurement and the literature disagree, the course says so and trusts neither by default.

## The honesty rules (inherited from the other two courses)

- Costs are charged in every worked example — for options that means **half the quoted spread in vol points at the actual strike and tenor**, not a flat fee. Long-dated wings are wide; pretending otherwise is the field's favorite self-deception.
- Win rates are never quoted without the loss distribution. A strategy that wins 86.3% of windows (#42) is defined by the other 13.7%.
- Every strategy chapter has a **"when it breaks"** section, and the break case is always a real historical episode, not a hypothetical.
- Sample sizes appear next to every empirical number. "30 days of windows" and "38 years of monthly cycles" are different kinds of evidence and are treated as such.
