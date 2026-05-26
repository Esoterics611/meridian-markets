# Roan / @RohOnChain — Markov Hedge Fund Method (verbatim archive)

| Field | Value |
|---|---|
| Handle | `@RohOnChain` |
| Display name | Roan |
| Followers (at fetch) | ≈ 47,300 |
| Bio | "building my life around quant systems in prediction markets and crypto on chain" |
| Thread anchor (X) | `https://x.com/RohOnChain/status/2049153122027900948` (sub-tweet referenced from the companion repo; the canonical written-up form is the GitHub README + onboarding prompt) |
| Companion repo | `https://github.com/jackson-video-resources/markov-hedge-fund-method` (211 stars at fetch; 128 forks) |
| Repo author / videographer | Lewis Jackson — installs Roan's framework on camera; framework credit explicit in README |
| License | MIT |
| Date archived | 2026-05-26 |
| Fetched from | `https://raw.githubusercontent.com/jackson-video-resources/markov-hedge-fund-method/main/README.md` (verbatim) + `…/main/markov-hedge-fund-method.md` (verbatim) + `…/main/skills/regime/SKILL.md` (verbatim) |
| X timeline | gated (HTTP 402); body recovered from the public companion repo which reproduces Roan's framework with attribution |
| Promotion verdict | **Tier-C verified.** Substantive practitioner content. Maps to Hamilton (1989) regime-switching literature in Tier A. |

---

## A. The original "Quant Series video 1" framing

From the repo README:

> Skill from **video 1 of the Quant Series**: *How To Use The Hedge Fund Method To Win Every Single Trade*.
>
> Framework by **Roan** ([@RohOnChain](https://x.com/RohOnChain)) — I'm the guy installing it on camera.

> It answers one question for **any asset**: what regime are we in, how sticky is it, and what does that imply for risk and direction?
>
> - Labels every day Bull / Bear / Sideways via a rolling-return rule (default 20-day, ±5%)
> - Builds a 3×3 transition matrix from the asset's history (maximum-likelihood)
> - Forecasts n-steps ahead by raising the matrix to powers (Chapman-Kolmogorov)
> - Computes the long-run stationary distribution (baseline regime mix)
> - Emits a signed signal: `bull_prob − bear_prob` → direction + conviction
> - Runs a walk-forward backtest (no lookahead) → reports Sharpe + max drawdown
> - Optionally fits a Hidden Markov Model via `hmmlearn` (graceful degrade if it can't compile)

> It takes **either a ticker** (`--ticker BTC-USD`, fetched via `yfinance`) **or
> your own CSV** (`--csv my_prices.csv`, just a date + close column) — so it drops
> into whatever data pipeline you already run, on whatever asset you trade.

## B. The full one-shot onboarding prompt (verbatim)

Reproduced from `https://raw.githubusercontent.com/jackson-video-resources/markov-hedge-fund-method/main/markov-hedge-fund-method.md`. Heading-by-heading; the prompt is a Claude Code agent install script, so the operational steps are part of the framework spec. Light reformatting only — code fences and lists preserved exactly.

> # Install the Markov Hedge Fund Method quant skill into Claude Code
>
> The skill ships a Python module that:
>
> - Fetches daily OHLCV for any ticker via `yfinance` (free, no key).
> - Labels each day as Bull / Bear / Sideways from a 20-day rolling return.
> - Builds the **transition matrix** via maximum-likelihood counting.
> - Forecasts n-step ahead by raising the matrix to powers (Chapman-Kolmogorov).
> - Solves for the **stationary distribution** (the long-run regime mix).
> - Runs a **walk-forward backtest** — re-estimates the matrix at every timestep using only data that existed before that day — and reports Sharpe and max drawdown.
> - **Optionally** fits a **Hidden Markov Model** via `hmmlearn` (Baum-Welch + Viterbi). If `hmmlearn` fails to compile on Windows without MSVC build tools, the HMM layer is skipped cleanly and the observable model still works.
>
> The first run on SPY 10y prints the transition matrix, the stationary distribution, and the walk-forward Sharpe + max drawdown on screen. After that you can ask Claude to run the skill on any ticker.
>
> This is Roan's framework (@RohOnChain). I'm installing it as a Claude Code skill so you can use it tonight.

### The Python regime module (verbatim — `regime.py`)

```python
"""Observable Markov regime model.
Labels each day Bull (1), Bear (-1), or Sideways (0) using a rolling
return threshold, then builds a 3x3 transition matrix via MLE counting,
solves for the stationary distribution, and runs a walk-forward backtest.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

STATES = ["Bear", "Sideways", "Bull"]  # index 0, 1, 2

def label_regimes(close: pd.Series, window: int = 20, threshold: float = 0.02) -> pd.Series:
    """Label each day as Bull / Bear / Sideways from rolling return.
    Bull   : rolling return > +threshold
    Bear   : rolling return < -threshold
    Sideways: otherwise
    """
    rolling_return = close.pct_change(window)
    labels = pd.Series(1, index=close.index, dtype=int)  # default Sideways
    labels[rolling_return > threshold] = 2  # Bull
    labels[rolling_return < -threshold] = 0  # Bear
    return labels.dropna()

def build_transition_matrix(labels: pd.Series) -> np.ndarray:
    """MLE estimate of the 3x3 transition matrix from a sequence of labels."""
    n = 3
    counts = np.zeros((n, n), dtype=float)
    arr = labels.to_numpy()
    for i in range(len(arr) - 1):
        counts[arr[i], arr[i + 1]] += 1
    row_sums = counts.sum(axis=1, keepdims=True)
    row_sums[row_sums == 0] = 1.0  # avoid divide-by-zero on empty rows
    return counts / row_sums

def stationary_distribution(P: np.ndarray) -> np.ndarray:
    """Left eigenvector of P with eigenvalue 1, normalised to sum to 1."""
    eigvals, eigvecs = np.linalg.eig(P.T)
    idx = np.argmin(np.abs(eigvals - 1.0))
    vec = np.real(eigvecs[:, idx])
    vec = np.abs(vec)
    return vec / vec.sum()

def n_step_forecast(P: np.ndarray, n: int) -> np.ndarray:
    """Chapman-Kolmogorov: P^n is the n-step transition matrix."""
    return np.linalg.matrix_power(P, n)

def signal_from_matrix(P: np.ndarray, current_state: int) -> float:
    """Signed signal: P(next=Bull|current) - P(next=Bear|current).
    Positive -> long, negative -> short, magnitude -> conviction.
    """
    return float(P[current_state, 2] - P[current_state, 0])

def walk_forward_backtest(
    close: pd.Series,
    labels: pd.Series,
    min_train: int = 252,
) -> dict:
    """Walk-forward: at each day t, fit the matrix on labels up to t-1,
    derive the signal from the current state, hold for one day, score.
    No lookahead. No tuning.
    """
    daily_returns = close.pct_change().dropna()
    common_index = labels.index.intersection(daily_returns.index)
    labels = labels.loc[common_index]
    daily_returns = daily_returns.loc[common_index]

    if len(labels) < min_train + 30:
        return {"sharpe": float("nan"), "max_drawdown": float("nan"), "n_trades": 0}

    strategy_returns = []
    for t in range(min_train, len(labels) - 1):
        P_t = build_transition_matrix(labels.iloc[:t])
        current_state = int(labels.iloc[t])
        signal = signal_from_matrix(P_t, current_state)
        position = float(np.sign(signal))
        next_day_return = float(daily_returns.iloc[t + 1])
        strategy_returns.append(position * next_day_return)

    sr = np.array(strategy_returns, dtype=float)
    if sr.std(ddof=1) == 0 or not np.isfinite(sr.std(ddof=1)):
        sharpe = float("nan")
    else:
        sharpe = float(sr.mean() / sr.std(ddof=1) * np.sqrt(252))

    equity = (1.0 + sr).cumprod()
    running_max = np.maximum.accumulate(equity)
    drawdown = (equity - running_max) / running_max
    max_dd = float(drawdown.min()) if len(drawdown) else float("nan")

    return {"sharpe": sharpe, "max_drawdown": max_dd, "n_trades": int(len(sr))}
```

### The HMM extension (verbatim — `hmm_extension.py`)

```python
"""Optional Hidden Markov Model layer. Imports hmmlearn lazily so the
observable model still works if hmmlearn failed to install."""

from __future__ import annotations

import numpy as np
import pandas as pd

def fit_hmm(returns: pd.Series, n_components: int = 3, random_state: int = 42):
    """Fit a Gaussian HMM on daily returns. Returns (model, hidden_states).
    Caveat: Baum-Welch finds local maxima. For production work, fit with
    several random_state values and keep the best by log-likelihood.
    """
    try:
        from hmmlearn import hmm  # lazy import
    except ImportError:
        return None, None

    X = returns.dropna().to_numpy().reshape(-1, 1)
    model = hmm.GaussianHMM(
        n_components=n_components,
        covariance_type="diag",
        n_iter=200,
        random_state=random_state,
    )
    model.fit(X)
    hidden_states = model.predict(X)
    return model, hidden_states
```

### The runner output shape

> ```
> Transition matrix (rows = from, cols = to):
>                 Bear  Sideways      Bull
>        Bear  XX.XX%   XX.XX%   XX.XX%
>    Sideways  XX.XX%   XX.XX%   XX.XX%
>        Bull  XX.XX%   XX.XX%   XX.XX%
>
> Persistence diagonal:
>   Bear -> Bear: XX.XX%
>   Sideways -> Sideways: XX.XX%
>   Bull -> Bull: XX.XX%
>
> Stationary distribution (long-run regime mix):
>        Bear: XX.XX%
>    Sideways: XX.XX%
>        Bull: XX.XX%
>
> Walk-forward backtest (re-estimating matrix at every step, no lookahead)...
>   Sharpe (annualised, walk-forward): X.XXX
>   Max drawdown:                       -XX.XX%
>   Trades evaluated: ~2000
> ```

## C. The JSON contract for composition (verbatim — `SKILL.md`)

The skill exposes a JSON contract that, in Roan's framing, is meant to *layer onto* an existing strategy rather than replace it. Three composition patterns are documented:

> ### (a) Regime confirmation on an existing momentum/strategy
>
> ```python
> if my_strategy_says_long and r["signal"] > 0:
>     enter_long()          # momentum + regime agree → take it
> elif my_strategy_says_long and r["signal"] <= 0:
>     skip()                # momentum says go, regime says don't → stand down
> ```

> ### (b) Stationary distribution as a tail-risk / position-size filter
>
> ```python
> bear_baseline = r["stationary_distribution"]["bear"]
> size = base_size * (1.0 - bear_baseline)      # heavier bear regime → smaller bets
> # or hard gate: if bear_baseline > 0.40: size = 0   # too tail-heavy to trade
> ```

> ### (c) Standalone signal
>
> ```python
> position = r["signal"]        # +0.6 → 60% long; -0.4 → 40% short; ~0 → flat
> ```

The JSON object's top-level fields (from the contract table) are: `source`, `rows`, `date_start`, `date_end`, `params`, `states`, `current_regime`, `next_state_probabilities`, `signal`, `transition_matrix`, `persistence_diagonal`, `stationary_distribution`, `walk_forward`, `hmm`, `framework`, `disclaimer`.

## D. Defaults the author calls out

- Rolling window: **20 trading days.**
- Bull / Bear threshold on rolling return: **±5%** (in the README and Pine indicator); **±2%** in the original onboarding prompt's `threshold` default. The repo notes the divergence and offers `--threshold 0.02` to reproduce the tighter labelling.
- Walk-forward minimum training window: **252 trading days** (one year).
- HMM components: **3** (matches the observable Bull / Sideways / Bear states; latent states are ordered by mean return so they're interpretable).
- HMM caveat in author's own words: *"Baum-Welch finds local maxima. For production work, fit with several random_state values and keep the best by log-likelihood."*

## E. Claims extraction

Each substantive claim from the verbatim text above gets a row. Topic is the chapter the claim lands in if it survives mapping; verdict per the [`00-charter-and-sources.md §0.3`](../00-charter-and-sources.md) tier rules.

| # | Claim (paraphrase) | Topic | Tier-A mapping | Verdict |
|---|---|---|---|---|
| 1 | A 3-state Markov chain (Bull / Sideways / Bear) over rolling returns captures enough of the regime structure to be useful for trading — you don't need a 10-state model or a deep network. | §2.Y, §3.X, §5 | Hamilton (1989), Ang & Bekaert (2002) — 2-to-3-state regime-switching is the canonical practitioner-grade decomposition; higher-order models routinely overfit. | **AGREES_WITH_TIER_A** — promote with Hamilton citation. |
| 2 | Transition matrices should be estimated by maximum-likelihood counting (count pair-of-states transitions, divide by row sums), not by fancier estimators. | §2.Y, Appendix A | Hamilton (1989, §22); Tsay (2010, *Analysis of Financial Time Series*, ch. 4) — MLE counting is consistent and asymptotically efficient under stationarity. | **AGREES_WITH_TIER_A** — citable. |
| 3 | The stationary distribution of the transition matrix is a useful "is this asset structurally tail-heavy?" signal. A high baseline-Bear share means size down. | §5 | Hamilton (1989) — the stationary distribution gives unconditional regime probabilities; Ang & Bekaert (2002) operationalise the same for cross-asset allocation. | **EXTENDS_TIER_A** — the *operational use* as a sizing input is practitioner detail; the math is Tier A. Practitioner-note callout in §5. |
| 4 | Walk-forward Sharpe is the only honest single-number summary of a regime-switching strategy; in-sample Sharpe lies. | §6 | López de Prado (2018, ch. 7) — the entire "embargoed / purged" methodology is built on exactly this principle. | **AGREES_WITH_TIER_A** — adds nothing new, but the practitioner *insistence* is valuable. |
| 5 | HMM (latent-state) regime detection is strictly better than observable-state where the data supports it, but Baum-Welch finds local maxima — fit multiple random seeds. | §3.X | Rabiner (1989) — the canonical HMM tutorial; the local-maxima warning is in §III.C of that paper. | **AGREES_WITH_TIER_A** — citable, with caveat preserved. |
| 6 | The framework composes as a confirmation layer (vetoing trades that fight the prevailing regime), a sizing filter (stationary bear share scales position), or a standalone signal (signed `bull_prob − bear_prob`). | §3.X, §5 | No direct Tier-A mapping for the composition patterns themselves — this is engineering, not theorem. | **EXTENDS_TIER_A** — Appendix C lore; can illustrate §5 with a Practitioner-note callout. |
| 7 | A 20-day rolling-return window and ±5% threshold is a default, not a tuned hyperparameter. The framework is meant to be retuned per asset. | §2.X | Avellaneda & Lee (2010) — the "tune per universe" stance is implicit in their PCA-window choice and explicit in their §3.2. | **AGREES_WITH_TIER_A** — citable. |
| 8 | Regime persistence (the diagonal of the transition matrix) is the most useful single number on the matrix — high persistence means trends; low persistence means choppy markets. | §2.Y | Hamilton (1989) — persistence is the natural interpretation of the diagonal; Lo & MacKinlay (1988) on "trending vs choppy" maps to the same intuition. | **AGREES_WITH_TIER_A** — citable. |
| 9 | A signed signal of `bull_prob − bear_prob` is a cleaner expression of "direction with conviction" than a raw probability of any one state. | §3.X | No direct Tier-A — this is the standard practitioner formulation but uncited in academia in this exact shape. | **EXTENDS_TIER_A** — Appendix C lore. |
| 10 | The framework refuses to fit anything via lookahead — at every step, only data prior to that step is used. | §6 | López de Prado (2018, ch. 7) — purged k-fold CV is the same principle generalised to ML targets. | **AGREES_WITH_TIER_A** — strengthens §6. |
| 11 | The HMM states should be labelled in order of mean daily return (lowest = Bear, highest = Bull), not by raw index — otherwise the labels are arbitrary across random seeds. | §3.X | Standard Rabiner (1989) — but the *labelling convention* is purely practitioner. | **EXTENDS_TIER_A** — Appendix C lore. |
| 12 | If `hmmlearn` won't compile on a given machine (Windows without MSVC), the observable model alone is "still useful" — degrade gracefully rather than refuse to run. | (Operational note) | No Tier-A mapping; software-engineering claim. | **EXTENDS_TIER_A** — Appendix C lore. |

## F. Promotion plan into the course

- **§2.Y "Spread-staleness diagnostics"** picks up claim #1 (regime detection is the right operational answer to "has my cointegrated pair broken?") and claim #8 (persistence diagonal as a "is this asset trending or choppy?" diagnostic). Cited alongside Hamilton (1989).
- **§3.X "Reading the OU fit"** picks up claims #5, #6, #9, #11 — HMM as the "next layer" when observable-state regime detection isn't enough; signed signals; labelling discipline.
- **§5 (risk)** picks up claim #3 — stationary-distribution as a sizing input — as a Practitioner-note callout under §5.3 (per-venue caps would benefit from a regime-baseline filter).
- **§6 (backtesting)** picks up claims #4 and #10 — walk-forward as the only honest single-number summary; lookahead refusal as a design principle.
- **Appendix C** gets the operational claims (#6 composition patterns, #7 retune-per-asset, #11 labelling convention, #12 graceful degrade) as Q&A entries.

## G. What deliberately does NOT promote

- The author's claim that this is "the hedge fund method to win every single trade" — that's video-title language, not a defensible claim. Hedge funds use regime detection as **one signal among many**, not as a winning-trade oracle. The framework's actual rigor (the MLE transition matrix, the walk-forward) is well-founded; the marketing framing is not. The course never repeats the "win every single trade" line.
- The default `--years 10` for the SPY demo. SPY 10y in 2026 spans 2016 → 2026, which captures one big bull regime and one COVID dislocation but no proper bear regime; the resulting stationary distribution under-represents bear. The framework is sound; the SPY-10y demo is unrepresentative. Course mentions this in §6 as an example of *defaults that flatter the strategy.*
