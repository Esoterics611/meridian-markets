# Appendix B · Source notebook

The annotated bibliography — what each source is *for*, in this course's terms. Same rule as the other two courses: nothing is cited that didn't earn its place, and the desk's own journal entries are cited as evidence with their sample sizes attached.

## The four books that carry the field

- **Natenberg, *Option Volatility and Pricing* (2nd ed.)** — the practitioner canon. Chapters 5–9 are §2's Greek intuition; 11–13 are §4's strike-selection craft. Read it for fluency, not for strategy.
- **Sinclair, *Volatility Trading* (2nd ed.)** — the quantitative practitioner's handbook: RV estimators and their efficiency (§3), hedging bands and error (§6), Kelly-style sizing for vol trades (§11's ancestor). The closest book in spirit to this course.
- **Sinclair, *Positional Option Trading*** — the same author at this course's exact horizon: premium selling, structure selection, and management-rule evidence (§4's 50%-take-profit family).
- **Bennett, *Trading Volatility*** — the sell-side encyclopedia: term structure and forward vol (§7), risk reversals and verticals (§8), collar variations (§5). Reference, not cover-to-cover.

Supporting: **Hull** (§2's derivations), **Gatheral, *The Volatility Surface*** (§8's smile dynamics), **Taleb, *Dynamic Hedging*** (§9's wing behavior, §11's scenario-grid case).

## The load-bearing papers

| Paper | What it establishes | Chapter |
|---|---|---|
| Bakshi & Kapadia (2003), "Delta-Hedged Gains and the Negative Market Volatility Risk Premium" | hedged option buyers systematically lose → the VRP exists | §3 |
| Carr & Wu (2009), "Variance Risk Premia" | the premium in 18 of 19 markets; destroyed-in-crises caveat | §3 |
| Carr & Madan (2001), "Towards a Theory of Volatility Trading" | the ½ΓS²(σᵢ²−σᵣ²) decomposition — the desk's central identity | §3 |
| Coval & Shumway (2001), "Expected Option Returns" | option buyers overpay vs any standard risk model | §1 |
| Gârleanu, Pedersen & Poteshman (2009), "Demand-Based Option Pricing" | who pays the premium and why it persists | §1 |
| Whaley (2002), CBOE PUT/BXM studies | four investable decades of put-writing evidence | §1, §4 |
| Israelov & Nielsen (2014), "Covered Call Strategies: One Fact and Eight Myths" | covered call = equity + short vol; "income" debunked | §4 |
| Israelov (2017), "Pathetic Protection" | naive protective puts cost more than they protect | §5, §9 |
| Israelov & Klein (2016), "Risk and Return of Equity Index Collars" | the collar as a distribution trade; the ceiling's historical cost | §5 |
| Santa-Clara & Saretto (2009), "Option Strategies: Good Deals and Margin Calls" | costs/margin eat naive option-selling paper profits | §4, §0 |
| Boyle & Emanuel (1980); Figlewski (1989) | discrete-hedging error: scale and consequences | §6 |
| Whalley & Wilmott (1997) | the asymptotic optimal hedge band (the forgiving cube root) | §6 |
| Derman (1999), "Regimes of Volatility" | term-structure/smile regime behavior | §7, §8 |
| Alexander & Korovilas (2012) and the VIX-ETP literature | the term-structure premium and its levered-short graveyard | §7 |
| Rubinstein (1994), "Implied Binomial Trees" | the post-1987 smirk as a permanent object | §8 |
| Mixon (2011), "What Does Implied Volatility Skew Measure?" | skew as flow/sentiment vs fair crash pricing | §8 |
| Bailey & López de Prado (2014), "The Deflated Sharpe Ratio" | why the fast-strategy gate exists — and why it's unreachable monthly | §12 |
| Politis & Romano (1994), the stationary bootstrap | block resampling that preserves vol clustering | §12 |
| Gneiting & Raftery (2007), proper scoring rules | the calibration leg (Brier) of scored-paper | §12 |

## Practitioner evidence (not papers, still evidence)

- **CBOE PUT and BXM index methodologies + history** — the field's only multi-decade third-party record of systematic option selling; §4's honest ceiling.
- **Spitznagel, *Safe Haven*** — the geometric-compounding case for negative-EV tail insurance; read against Israelov (2017), and note §9 is the synthesis, not a side in the fight.
- **The February 2018 (XIV) and March 2020 short-vol postmortems** — public, well-documented sizing failures of a real premium; §1's graveyard.
- **Tail-fund March-2020 letters (Universa vs category median)** — monetization policy, not put ownership, separated the outcomes; §9's 4× rule.
- **Deribit contract specifications & mark-IV methodology** — the venue conventions §2's engine matches; inverse-settlement mechanics.

## The desk's own record (cited with sample sizes, per the charter)

| Entry | What it measured | Used in |
|---|---|---|
| **#12** | BTC IV 37.1 vs RV 31.2 = +5.9 pts; ETH +3.7; Greeks validated line-by-line vs Deribit | §2, §3 — the desk's founding measurement |
| **#42** | 117 rolling 24h windows / 30 days: short vol won 86.3% | §3, §6, §12 — the premium's distribution *and* its fat-tail fraction |
| **#96** | live overnight: VRP gate honestly OUT all night; the one entry was an RV window artifact (0.511→0.429 in 1 min); ORV's −$78.65 negative-skew lesson, n=6 | §3 (the estimator), §12 (calibration-before-capital) |
| **#98** | md-plant Phase A live on the bus | §13 — the surface collector's substrate |
| PROFIT_PIVOT_II **R6/R7/R9/R10** | the parked-VRP diagnosis; distribution-first triggers; the margin-model gap; "gates are cheap, track records are slow" | §7, §11, §12, §13 |

**The standing caveat, repeated on purpose:** the desk's crypto measurements are weeks of data against the literature's decades. Where this course states a crypto number, the design treats it as a *prior to be re-measured from the surface tape* (Phase O-0), never as settled fact. That discipline — not any single citation above — is the course's actual bibliography.
