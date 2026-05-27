# Statistical Arbitrage — A Working Course

An mkdocs-based course on statistical arbitrage: theory, math, and code, end-to-end. Built so a smart newcomer can read the chapters in order and come out with the working knowledge of a junior quant on a pairs-trading desk. No marketing voice; no curve-fit backtest plots; every claim cited.

## Run locally

```bash
pip install -r requirements.txt
cd courses/stat-arb
mkdocs serve   # http://127.0.0.1:8000
```

## Build static site

```bash
mkdocs build   # outputs to courses/stat-arb/site/
```

## Conventions

- **Math** in MathJax via `pymdownx.arithmatex` — `$x$` for inline, `$$x$$` for display.
- **Diagrams** in Mermaid via `pymdownx.superfences` — ```` ```mermaid ... ``` ```` blocks.
- **Code blocks** are TypeScript-first because that's the codebase's stack; Python references appear where the canonical reference implementation lives there (`statsmodels`, `mlfinlab`).
- **Sources** live in `docs/appendix-b-sources.md` and `docs/00-charter-and-sources.md`. Every claim is traceable to a source; unverified ones are explicitly marked.

## Chapter status

- [x] §0 Course charter & sources
- [x] §1 Introduction — what stat arb actually is
- [x] §2 Cointegration & pairs trading
- [x] §3 Ornstein-Uhlenbeck mean reversion
- [x] §4 Execution & venue abstraction
- [x] §5 Risk, sizing, circuit breakers
- [x] §6 Backtesting honestly
- [x] §7 From paper to production
- [x] Appendix A — Code-shape catalogue
- [x] Appendix B — Source notebook
- [x] Appendix C — Practitioner lore (RohOnChain archive)
