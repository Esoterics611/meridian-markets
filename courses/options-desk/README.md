# Long-Horizon Options — A Working Course

An mkdocs-based course on long-horizon options investing: income, insurance, and capital efficiency with options held for weeks to months — theory, math, and code, end-to-end. Third course next to [`courses/market-making`](../market-making) and [`courses/stat-arb`](../stat-arb); it trains the Meridian **Long-Horizon Options Desk** (`docs/OPTIONS_DESK.md` in the repo root — each strategy chapter maps to one live book). No payoff-diagram folklore, no "income secrets"; every claim cited, desk measurements quoted with sample sizes.

## Run locally

```bash
pip install -r requirements.txt
cd courses/options-desk
mkdocs serve   # http://127.0.0.1:8000
```

## Build static site

```bash
mkdocs build   # outputs to courses/options-desk/site/
```

## Conventions

- **Math** in MathJax via `pymdownx.arithmatex` — `$x$` for inline, `$$x$$` for display.
- **Diagrams** in Mermaid via `pymdownx.superfences` — ```` ```mermaid ... ``` ```` blocks.
- **Code blocks** are TypeScript-first; shapes marked **[repo]** are quoted from the running engine (`src/derivatives/`), the rest are the desk-plan shapes the O-E build chain implements.
- **Sources** live in `docs/appendix-b-sources.md` and `docs/00-charter-and-sources.md`. Desk journal entries (#12, #42, #96, …) are cited as evidence with their sample sizes stated.

## Chapter status

- [x] §0 Course charter & sources
- [x] §1 What long-horizon options investing actually is
- [x] §2 The pricing engine — BS, Greeks, inverse options
- [x] §3 The variance risk premium — the structural edge
- [x] §4 Selling puts & the wheel
- [x] §5 Collars — buying the drawdown bound
- [x] §6 Delta-hedged short vol — bands, error, the ladder
- [x] §7 The term structure — calendars & rolldown
- [x] §8 Skew — the smile as a tradable object
- [x] §9 Tail hedging — the honest cost of insurance
- [x] §10 Capital efficiency — synthetics & stock replacement
- [x] §11 Portfolio construction — Greeks budgets & stress-as-sizing
- [x] §12 Validating slow strategies — the gate problem
- [x] §13 The Meridian options desk — the build map
- [x] Appendix A — Code-shape catalogue
- [x] Appendix B — Source notebook
