# Statistical Arbitrage — Working Course

mkdocs-based course material backing Meridian Markets' Phase 3 prop-desk build. Not a textbook — a working document tied to the code in `src/stat-arb/` (planned; see `docs/STAT_ARB_PLAN.md`).

## Run locally

```bash
pip install mkdocs-material pymdown-extensions
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
- **Code blocks** are TypeScript-first because that's our stack, with Python references where the source material is.
- **Sources** live in `docs/appendix-b-sources.md` and `docs/00-charter-and-sources.md`. Every claim should be traceable to a source; unverified ones are explicitly marked.

## Status

- [x] Scaffold + nav
- [x] §0 charter + source-collection skeleton
- [x] §1 introduction
- [x] §2 cointegration
- [x] §3 OU mean reversion
- [x] §4 execution
- [x] §5 risk
- [ ] §6 backtesting — outline only
- [ ] §7 production — outline only
- [ ] Appendix A code-shape catalogue — outline only
- [ ] **Verify X-thread sources** — pending user-supplied links

## Open asks for the next session

1. **X-thread links.** This scaffold mentions a "rohn / roan" hedge-fund-secrets thread as unverified. Paste the actual X handle + thread URLs so they can be vetted and cited correctly. Until then, all references to that thread are stubs marked `[TODO: verify]`.
2. **Source vetting.** The next session should `WebFetch` each cited paper / repo / blog and confirm the URL still resolves before promoting any source out of the "unverified" tier in Appendix B.
