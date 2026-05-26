# 6. Backtesting honestly

> **Status: outline.** This chapter is a stub. Will be fleshed out in a follow-up session once §1–§5 are stable and the user has had a chance to read them.

## 6.1 Why honest backtesting is hard

Backtests are routinely curve-fit. The three most common ways:

1. **Look-ahead bias.** Strategy uses data that wouldn't have been available at decision time. (E.g., "today's close" in a strategy that runs at noon.)
2. **Survivorship bias.** Universe is filtered to assets that exist today, omitting delisted / failed ones.
3. **Multiple-testing bias.** Tried 1,000 strategies, reported the best 3, didn't disclose the other 997.

## 6.2 Event-driven beats vectorised

Sketched in [STAT_ARB_PLAN.md §6](../../../docs/STAT_ARB_PLAN.md). Live and backtest must run the same strategy code. Difference is only the source of `BarEvent` and the destination of `Order`.

## 6.3 Purged k-fold cross-validation

Per **MLDP18** (López de Prado, 2018). Naïve k-fold leaks information across folds because samples within an embargo window of the test fold contain training-set labels. Purged k-fold drops those samples. **TODO:** worked example + code-shape.

## 6.4 The fee / slippage models (revisited from §4.4)

**TODO:** how to calibrate Level-2 slippage from a live run; how to recognise when Level-3 (order-book reconstruction) is required.

## 6.5 Reporting honestly

**TODO:** Sharpe and Sortino with confidence intervals (not point estimates); max drawdown distribution rather than point estimate; the "deflated Sharpe ratio" from MLDP18 to penalise multiple-testing.

## 6.6 Citations

- **MLDP18**: López de Prado, M. (2018). *Advances in Financial Machine Learning.* Wiley.
- **Bailey, D. H., & López de Prado, M. (2014).** *The deflated Sharpe ratio.* The Journal of Portfolio Management, 40(5), 94–107.
