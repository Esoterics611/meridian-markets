# Appendix B — Source notebook

Every citation in the course resolves here. Sources are tiered (see [§0.3](00-charter-and-sources.md)).

## B.1 Tier A — foundational literature (verified)

| Tag | Citation | What it proves |
|---|---|---|
| **EG87** | Engle, R. F., & Granger, C. W. J. (1987). *Co-integration and error correction: representation, estimation, and testing.* Econometrica, 55(2), 251–276. | Two-step cointegration test |
| **J91** | Johansen, S. (1991). *Estimation and hypothesis testing of cointegration vectors in Gaussian vector autoregressive models.* Econometrica, 59(6), 1551–1580. | Multi-variate cointegration |
| **AL10** | Avellaneda, M., & Lee, J.-H. (2010). *Statistical arbitrage in the U.S. equities market.* Quantitative Finance, 10(7), 761–782. | Modern PCA + OU stat-arb formulation |
| **B10** | Bertram, W. K. (2010). *Analytic solutions for optimal statistical arbitrage trading.* Physica A, 389(11), 2234–2243. | OU optimal entry/exit thresholds |
| **MLDP18** | López de Prado, M. (2018). *Advances in Financial Machine Learning.* Wiley. | Purged k-fold CV; deflated Sharpe ratio; honest methodology |
| **AC01** | Almgren, R., & Chriss, N. (2001). *Optimal execution of portfolio transactions.* Journal of Risk, 3, 5–40. | Market-impact / slippage modelling |
| **K56** | Kelly, J. L. (1956). *A new interpretation of information rate.* Bell System Technical Journal, 35, 917–926. | Original Kelly |
| **T06** | Thorp, E. O. (2006). *The Kelly criterion in blackjack, sports betting, and the stock market.* | Shrinkage argument for fractional Kelly |
| **J06** | Jorion, P. (2006). *Value at Risk: The New Benchmark for Managing Financial Risk* (3rd ed.). McGraw-Hill. | VaR methodology |

## B.2 Tier B — reference implementations (URLs pending verification)

**Status:** the next session must `WebFetch` each URL, confirm it resolves, and note the license + last-commit-date in this table. Until then, all entries are `unverified`.

| Repo | URL (recall — verify) | What to read | License (recall — verify) | Verified? |
|---|---|---|---|---|
| `hudson-and-thames/mlfinlab` | `https://github.com/hudson-and-thames/mlfinlab` | Cointegration, fractional differentiation, purged CV | BSD-3 | ❌ |
| `hudson-and-thames/arbitragelab` | `https://github.com/hudson-and-thames/arbitragelab` | Engle-Granger, Johansen, Bertram, copula pairs | Mixed (may now be commercial) | ❌ |
| `statsmodels/statsmodels` | `https://github.com/statsmodels/statsmodels` | `tsa.stattools.adfuller`, `tsa.vector_ar.vecm` | BSD-3 | ❌ |
| `quantopian/zipline` | `https://github.com/quantopian/zipline` | Event-driven backtest loop | Apache-2 | ❌ |
| `robcarver17/pysystemtrade` | `https://github.com/robcarver17/pysystemtrade` | Stages composition; position-sizing | GPL-3 (read-only; do not copy code) | ❌ |
| `jesse-ai/jesse` | `https://github.com/jesse-ai/jesse` | Strategy lifecycle hooks; live/backtest parity | MIT | ❌ |
| `freqtrade/freqtrade` | `https://github.com/freqtrade/freqtrade` | Hyperopt; strategy/backtest separation | GPL-3 (read-only) | ❌ |
| `nautilustrader/nautilus_trader` | `https://github.com/nautilustrader/nautilus_trader` | Modern event-driven; venue abstraction | LGPL-3 | ❌ |
| `tradytics/eiten` | `https://github.com/tradytics/eiten` | Portfolio optimization | GPL-3 (read-only) | ❌ |
| QuantConnect Lean | `https://github.com/QuantConnect/Lean` | C# event-driven engine | Apache-2 | ❌ |

## B.3 Tier C — practitioner commentary (unverified)

### The "rohn / roan" X thread — [TODO: verify]

!!! danger "Unverified — placeholder only"
    The user mentioned that a practitioner on X (handle approximately **"rohn"** or **"roan"** — exact spelling uncertain) recently shared what they characterised as "secrets from hedge funds" on stat arb. **No handle, URL, or content has been verified in this session.**

    **Why it's not cited anywhere in the course body yet:** practitioner Twitter threads are Tier C; per §0.3 they cannot be the sole support for any claim. They are useful for code-shape intuition and operational lore that academic papers don't cover (e.g. "what does the daily universe-screening routine actually look like at a buyside desk").

    **What the next session needs to do:**

    1. **Get the actual handle** from the user. Candidates the assistant could guess at — `@rohn`, `@roan`, `@rohan…`, `@rohank…`, `@ronh…`, etc. — should NOT be invented; ask the user directly.
    2. **WebFetch the thread(s).** Capture the URL. Archive a copy (X content rots fast; threads get edited or deleted).
    3. **Map each claim to a Tier-A source.** A practitioner claim that lines up with Avellaneda-Lee or López de Prado gets cited *alongside* the Tier-A reference. A claim that doesn't map is folklore — note it as such, don't load-bear on it.
    4. **Update the relevant chapter** with the verified citation; remove the `[TODO: verify]` markers in §0.5, this section, and anywhere else.

    **What we will NOT do:**

    - Invent the handle.
    - Invent the thread's content based on what such threads typically discuss.
    - Cite the thread as established fact in the course body.

### Other practitioner sources

**TODO:** as the next session vets the X thread, add other useful Tier-C sources here. Candidates to research: Marcos López de Prado's QuantResearch newsletter, Robert Carver's blog (`qoppac.blogspot.com`), Ernie Chan's blog (`epchan.blogspot.com`), the QuantConnect community forum. **None of these is currently verified.**

## B.4 Verification ledger

| Date | Source | Action | Outcome |
|---|---|---|---|
| 2026-05-26 | All Tier-B entries | Initial draft from training-data recall | Marked unverified |
| 2026-05-26 | "rohn / roan" thread | User-mentioned, not yet researched | Marked unverified; placeholder only |

(This ledger gets a new row every time a source is verified or rejected in a future session.)
