# Market Making — A Working Course

An mkdocs-based course on electronic market making: theory, math, and code, end-to-end. Sister course to [`courses/stat-arb`](../stat-arb). Built so a smart newcomer can read the chapters in order and come out with the working knowledge of a junior quoter on a market-making desk. No marketing voice; no curve-fit backtest plots; every claim cited.

## Run locally

```bash
pip install -r requirements.txt
cd courses/market-making
mkdocs serve   # http://127.0.0.1:8000
```

## Build static site

```bash
mkdocs build   # outputs to courses/market-making/site/
```

## Conventions

- **Math** in MathJax via `pymdownx.arithmatex` — `$x$` for inline, `$$x$$` for display.
- **Diagrams** in Mermaid via `pymdownx.superfences` — ```` ```mermaid ... ``` ```` blocks.
- **Code blocks** are TypeScript-first because that's the codebase's stack; Python references appear where the canonical reference implementation lives there (`numpy`, `pandas`, `nautilus_trader`).
- **Sources** live in `docs/appendix-b-sources.md` and `docs/00-charter-and-sources.md`. Every claim is traceable to a source; unverified ones are explicitly marked.

## Chapter status

- [x] §0 Course charter & sources
- [x] §1 Introduction — what market making actually is
- [x] §2 Microstructure foundations (Glosten-Milgrom, Kyle, the LOB)
- [x] §3 Avellaneda-Stoikov & inventory-aware quoting
- [x] §4 Execution & queue position
- [x] §5 Risk: inventory, adverse selection, kill switches
- [x] §6 Backtesting & LOB replay
- [x] §7 From paper to production
- [x] Appendix A — Code-shape catalogue
- [x] Appendix B — Source notebook
