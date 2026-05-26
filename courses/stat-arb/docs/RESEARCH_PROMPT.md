# Research prompt — run in Claude Code desktop

> Self-contained prompt for a Claude Code desktop session with web access. Paste the body below into a fresh session in this repo. Expected runtime: 30–60 minutes of agent work. Output: a fully-cited stat-arb course replacing the placeholder content currently in `courses/stat-arb/docs/`.

---

## Context for the agent (paste this verbatim)

You are filling in the `courses/stat-arb/` mkdocs course in this repo. The scaffold is in place — chapters §0–§5 have full first drafts, §6/§7 + appendices are outlined. Your job is to **verify, refine, and extend** the material with live web research, then upgrade the mkdocs site to use the `material` theme + Mermaid + MathJax rendering. The unique value-add of this session is **source verification** — replacing every `[TODO: verify]` and "unverified" marker with a real, fetched citation.

**Hard rules:**

1. **Do not invent URLs or claims.** Every Tier-B repo URL in `docs/appendix-b-sources.md` must be confirmed via `WebFetch` before its `❌ unverified` marker is flipped to `✅`. If a URL no longer resolves, mark it `🗑 dead` and find a replacement.
2. **Do not load-bear on the X thread without verification.** See §3 below for the X-thread research protocol.
3. **Tier discipline (per `docs/00-charter-and-sources.md`):** Tier C (practitioner) sources never stand alone — they illustrate something Tier A already proves.
4. **No code changes outside `courses/stat-arb/`** except (a) updating `MEMORY.md` if you discover something worth remembering and (b) updating `docs/SESSION_HISTORY.md` with a new session entry.
5. **Conventions from the repo's CLAUDE.md still bind.** Read it first.

---

## 1. Pre-flight — what's already on disk

```
courses/stat-arb/
  mkdocs.yml                       built with vanilla mkdocs; upgrade to material
  README.md
  docs/
    index.md                       intro
    00-charter-and-sources.md      tier system, X-thread placeholder
    01-introduction.md             one-paragraph definition, four families taxonomy
    02-cointegration.md            EG87, J91, half-life, z-score, code shape
    03-ou-process.md               OU SDE, fitting, B10 thresholds, code shape
    04-execution.md                ITradingVenue interface, cost models, router
    05-risk.md                     Kelly, VaR, drawdown gate, circuit breakers
    06-backtesting.md              OUTLINE ONLY — flesh out
    07-production.md               OUTLINE ONLY — flesh out
    appendix-a-code-shapes.md      OUTLINE ONLY — flesh out
    appendix-b-sources.md          tier-A verified; tier-B unverified; tier-C placeholder
    RESEARCH_PROMPT.md             this file
```

Read every existing chapter before editing. The voice is direct and opinionated — match it. Do not rewrite §1–§5 unless you find an actual error; refine in place and add the verified citations.

---

## 2. Tier-B verification (highest priority — 30 minutes)

For each row in `docs/appendix-b-sources.md` §B.2, do the following with `WebFetch`:

1. **Fetch the URL.** Confirm the repo exists, is public, and is still being maintained (last commit < 24 months).
2. **Confirm the license.** Look at the `LICENSE` file. GPL repos can be read but not have code copied; flag those in the table.
3. **Confirm the specific file paths** referenced in the course body. The course mentions, e.g., `mlfinlab.ml.optimal_mean_reverting.ornstein_uhlenbeck` — fetch that path and confirm it still exists at that name. If it's been renamed/moved, update the citation.
4. **Note the canonical name** if you find one (some repos have been renamed; e.g. `hudson-and-thames/arbitragelab` may now require commercial licensing — check carefully).
5. **Flip the verification flag** in the appendix table from `❌` to `✅` (with the date) or `🗑 dead` with a replacement.

**Specific repos to confirm (do all of them):**

- `hudson-and-thames/mlfinlab` — cointegration, fractional differentiation, purged k-fold CV. Confirm the `mlfinlab.cross_validation` module still has `PurgedKFold`.
- `hudson-and-thames/arbitragelab` — Engle-Granger, Johansen, Bertram. **Critical:** verify whether it's still open-source or has been moved to commercial. If commercial, flag prominently and find an open alternative.
- `statsmodels/statsmodels` — `tsa.stattools.adfuller` and `tsa.vector_ar.vecm.coint_johansen`. Confirm both still exist at those paths.
- `quantopian/zipline` — confirm archived status post-Quantopian shutdown; note any active forks (`stefan-jansen/zipline-reloaded` is the likely active fork — verify).
- `robcarver17/pysystemtrade` — confirm GPL-3.
- `jesse-ai/jesse` — confirm MIT, confirm crypto-focused.
- `freqtrade/freqtrade` — confirm GPL-3.
- `nautilustrader/nautilus_trader` — confirm LGPL-3, confirm active.
- `tradytics/eiten` — confirm GPL-3 and last-commit-date (this one may be abandoned).
- QuantConnect Lean (`QuantConnect/Lean`) — confirm Apache-2, confirm active.

After each verification, refine the chapter that cites the repo with the verified path. E.g., if §2 mentions a `statsmodels` function, replace the bare name with a verified link like `[adfuller](https://www.statsmodels.org/dev/generated/statsmodels.tsa.stattools.adfuller.html)`.

---

## 3. The X-thread research (the user's specific ask — 20 minutes)

The user mentioned that someone on X (handle approximately "rohn" or "roan" — exact spelling uncertain) has been sharing what they characterised as "secrets from hedge funds" relevant to stat arb. **The handle was not confirmed by the user before this session.** Your job is to identify the thread, verify it, and integrate its useful claims.

### 3.1 Identifying the handle

**Do NOT invent a handle.** If you can't identify it, leave the placeholder in `appendix-b-sources.md §B.3` and add a clear "next-session-must-resolve" note.

Search strategy (in order):

1. **Ask the user directly first.** Use `AskUserQuestion` to ask for the actual X handle and one example tweet URL. **This is the cheapest path to ground truth.** If the user provides the handle, skip to §3.2.
2. **If the user can't recall, try `WebSearch`** for terms like `"hedge fund secrets" stat arb X site:x.com rohn`, `"stat arb" "hedge funds" X.com roan`, `pairs trading buyside X rohn`. **Confidence threshold:** only proceed if you find a thread that (a) has a handle resembling "rohn" or "roan", (b) explicitly discusses stat arb / pairs trading / hedge-fund operations, (c) has substantive content (not just a one-liner).
3. **If search produces no high-confidence match, stop.** Update the placeholder in `appendix-b-sources.md §B.3` with a note that "even with active search, no thread was identified matching the user's recollection — request the handle from the user before next session."

### 3.2 Verifying the thread (once identified)

1. **Fetch the thread** via `WebFetch`. Capture the URL, the handle, and the post date.
2. **Archive a copy** by copying the full text into a new file `courses/stat-arb/docs/_archive/rohn-thread-<YYYY-MM-DD>.md` (the underscore prefix keeps it out of the default mkdocs nav). X content rots — this archive is the only durable record.
3. **Extract claims.** Each substantive claim gets a numbered bullet in the archive file: claim text → which §2/§3/§4/§5 topic it relates to → whether it agrees / disagrees / extends Tier-A literature.
4. **Map each claim to a Tier-A source.** A claim that lines up with Avellaneda-Lee (§2), Bertram (§3), Almgren-Chriss (§4), or López de Prado (§6) gets cited alongside the Tier-A reference in the chapter body. A claim that doesn't map but is internally plausible gets a "practitioner lore" callout box in the relevant chapter, explicitly labeled. A claim that contradicts Tier A *and* lacks supporting evidence gets noted in the archive but not in the chapter.
5. **Update `appendix-b-sources.md §B.3`** with the verified citation row: handle, URL, date archived, claims extracted, mapping table.

### 3.3 What NOT to do with the X thread

- Do not cite the thread as the sole support for any claim in the course body. Tier-C rule from §0.3.
- Do not paraphrase claims as fact. If the thread says "most desks use a 5-sigma stop," the course says "one practitioner thread (cited) describes 5-sigma stops; Tier-A literature does not converge on a specific number."
- Do not assume the thread author is right. Hedge-fund X threads are often a mix of real operational lore, sales pitches, and self-promotion. Skepticism by default.

---

## 4. Flesh out §6 and §7 (40 minutes)

Both chapters are outlined. Fill them in following the same shape as §2–§5 (intuition → math → when-it-breaks → code-shape → citations). Specifics:

### §6 — Backtesting honestly

- **§6.1** look-ahead / survivorship / multiple-testing — concrete examples with code-pattern fixes (e.g. "always slice training data by event timestamp, never by row index").
- **§6.3** purged k-fold CV — **fetch** the original López de Prado pseudocode (book is offline but the algorithm is in `mlfinlab.cross_validation.PurgedKFold` — confirmed URL goes here). Worked example with synthetic data + code-shape in TypeScript.
- **§6.5** deflated Sharpe — explain the multiple-testing penalty mathematically; include the closed-form from Bailey & López de Prado (2014).

### §7 — From paper to production

- **§7.5/§7.6** the daily/weekly operational checklists — write them as actual checklists, not prose. What gets checked, by whom, what triggers escalation.
- **§7.7** "what audited NAV actually means" — research what fund auditors (NAV Consulting, SS&C, Sudrania — the three names PHASED_PLAN.md mentions) want from a quant fund operationally. Cite their public service descriptions. The list of artifacts (custody statements, daily price marks, position reconciliation, etc.) goes here.

---

## 5. Appendix A — code-shape catalogue (15 minutes)

Currently outline only. Flesh out each section with concrete TypeScript signatures that match the conventions of `src/yield/` and `src/hedge/` in this repo. Read those modules before writing — the patterns are already established (swap-seam, `I<Thing>` interface, `Mock<Thing>` default, dormant `Real<Vendor>`, bigint price math).

Each section should include:

1. The pattern's name and one-sentence purpose.
2. The TypeScript signature.
3. A 5-line test pattern in Jest matching the repo's existing spec style.
4. A pointer to the existing repo files that demonstrate the same pattern (e.g. "see `src/hedge/mock-hedge-venue.ts` for the same shape in a different domain").

---

## 6. Upgrade mkdocs theme + extensions (10 minutes)

Currently the site is built with vanilla mkdocs + readthedocs theme. Upgrade for nicer rendering:

1. Install deps in a virtual environment:
   ```bash
   cd courses/stat-arb
   python3 -m venv .venv
   source .venv/bin/activate
   pip install mkdocs-material pymdown-extensions
   ```
2. Update `courses/stat-arb/mkdocs.yml` to use:
   - `theme.name: material` with the palette / features block originally drafted (see the git history of `mkdocs.yml` for the original — recover via `git log -p -- mkdocs.yml`).
   - `markdown_extensions` including `pymdownx.arithmatex` (for MathJax `$x$` rendering), `pymdownx.superfences` (for Mermaid diagrams), `pymdownx.highlight`, `pymdownx.details`, `pymdownx.tabbed`.
   - `extra_javascript` for MathJax CDN.
3. Add `requirements.txt` in `courses/stat-arb/` with the pinned versions of mkdocs-material and pymdown-extensions.
4. Run `mkdocs build --strict` and resolve all warnings except the cross-doc-root-link warnings (which are unavoidable given the docs/ layout — leave those).
5. Run `mkdocs serve` and verify in a browser that:
   - Mermaid diagrams in §1, §3, §4, §5 render as actual diagrams.
   - MathJax in §2, §3, §5 renders inline equations.
   - Code blocks have copy buttons.
6. Commit `requirements.txt` + the updated `mkdocs.yml`. Do not commit `.venv/`.

---

## 7. Charts the course needs (research and add)

The current course has Mermaid flowchart diagrams but no actual data charts. Add:

1. **§2.5 — z-score on a real cointegrated pair.** Pick a famous textbook example (Pepsi/Coke, BHP/RIO, or a crypto example like ETH/stETH if you can find clean data). Generate a small Python script in `_charts/` that produces a PNG of the spread + z-score series. Embed the PNG.
2. **§3.3 — OU fit on synthetic data.** Generate a synthetic OU process, fit it, plot the fit-vs-data overlay. PNG.
3. **§5.2 — Kelly fraction vs Sharpe.** A 2D plot showing how the recommended Kelly fraction varies with the strategy's measured Sharpe ratio and shrinkage factor. PNG.

For each PNG: commit the generating script (`_charts/<name>.py`) alongside the image so charts are reproducible. The script should be self-contained — only depend on numpy + matplotlib.

---

## 8. Update repo-level docs

When all of the above is done:

1. **`docs/SESSION_HISTORY.md`** — add a "Session 3 — Stat-arb course research & build-out" entry summarising what was verified, what charts were added, what remains, in the same shape as the existing Session 1 entry.
2. **`MEMORY.md`** — add a `reference` memory pointing future sessions at `courses/stat-arb/` and `docs/STAT_ARB_PLAN.md` as the canonical entry points for Phase 3 work.
3. **One coherent commit on `master`**, then a feature branch for PR if the user requests. Commit message style: see existing repo commits (`git log --oneline -20`).

---

## 9. Done when

- Every Tier-B row in `appendix-b-sources.md` has been verified (✅) or marked dead (🗑) with a replacement.
- The X-thread placeholder is either replaced with a verified citation + archive file, or carries a clear "user must supply handle next session" note backed by a recorded search attempt.
- §6, §7, Appendix A are full first drafts (not outlines).
- The mkdocs site builds with `mkdocs build --strict` using the material theme + pymdownx extensions.
- All three charts in §7 above are committed with their generating scripts.
- `docs/SESSION_HISTORY.md` has a new session entry.
- Single coherent commit on master with the Co-Authored-By trailer.

---

## 10. Anti-goals

- **Do not** add new strategy chapters beyond §2/§3. Funding-carry and basis trade are PHASED_PLAN.md §Phase 3 strategies — their course chapters happen when those strategies are actually implemented.
- **Do not** rewrite `docs/STAT_ARB_PLAN.md`. That's the engineering-side companion to this course; it's the responsibility of the implementation session, not the course-research session.
- **Do not** touch `src/hedge/`, `src/yield/`, or any other module code. Course content only.
- **Do not** invent cool-sounding strategies, claims, or quotes. If a Tier-A source doesn't support a claim and the X thread doesn't verify, the claim doesn't go in.
