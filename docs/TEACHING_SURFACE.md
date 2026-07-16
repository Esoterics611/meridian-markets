# The Teaching Surface — stable URLs, ids & modes (binding)

*2026-07-16, UI_REWRITE_PLAN_III P3. This is the contract between this repo and the
Builder Academy curriculum (the mendy-hq sister repo): its prompt seeds and session
anchors point at the surfaces below, and tutors re-check anchors before a session —
this doc is the other half of that deal: **we don't break these silently.** Renaming
anything here is a breaking change to the curriculum; call it out in the session log
and give the old → new mapping. Adding is always fine.*

## Pages (the live surfaces a lesson can anchor on)

| URL | What a student sees |
|---|---|
| `/` | the launcher — every console, honestly labelled |
| `/learn` | the academy hub: courses · learning path · tours · glossary |
| `/markets` | the live market terminal: candles, L2 depth ladder, spread, our quotes/fills |
| `/desk/mm` | the market-making console: quotes, inventory, P&L attribution |
| `/desk/statarb` | the pairs console: z / β / regime + the pair charts |
| `/desk/carry` | the funding-carry desk: liveness, realised-first, accrual charts |
| `/desk/markout` | the pick-off read: per-book markout curves |
| `/risk` | drawdown vs budget, exposure, verdicts, kill switches |
| `/exec` | the fund view: two honest equity curves |
| `/research` | the KEEP/CUT findings board + runbook |
| `/courses/market-making/…`, `/courses/stat-arb/…` | the two mkdocs courses, same-origin (chapter files as in `courses/*/docs/`, `.html`) |

## Modes (query params any lesson link may carry)

- **`?learn=1`** — switches learn mode ON (persists via localStorage; `?learn=0` off).
  Adds the page intro strips + captions. Off = pixel-identical operator view.
- **`?tour=1`** — auto-starts the page's guided tour (where one exists: `/desk/mm`,
  `/markets`, `/risk`). Tours skip steps whose targets are missing — they degrade,
  never break.

## The explain layer

- Every ⓘ is an `<explain-tip eid="…">`; the drawer content is served by
  **`GET /learn/explain/:id`**. The **ids** are the stable vocabulary — the full set
  lives in `src/ui/render/explain-registry.ts` (spec-enforced: every "read more"
  resolves). Current groups: market basics · market making · stat-arb · risk & P&L ·
  carry & funding.
- The on-site glossary renders every entry at `/learn` (anchor per term:
  `/learn#term-<id>`, e.g. `/learn#term-adverse-selection`).

## Data endpoints a lesson may curl (read-only, JSON)

| Endpoint | Serves |
|---|---|
| `GET /api/market-data/l2?symbol&venue` | one L2 depth frame (the ladder's data) |
| `GET /markets/chart?symbol&venue&hours` | the market ChartSpec (candles+volume+overlays) |
| `GET /desk/mm/chart?book=` · `/desk/carry/chart?book=` · `/desk/statarb/chart?pair=` | the desk ChartSpecs |
| `GET /api/market-making/snapshot` · `/events` · `/nav` | the MM desk's live state / tape / durable curve |
| `GET /api/carry/state` | the carry desk's checkpointed state |

## House rules that protect the surface

- Honest states are part of the lesson: FEED DOWN, DB OFF, "not built", "not served
  yet" are rendered truthfully — a tutor can rely on failure states being visible.
- Everything is PAPER; no surface here can spend real money (CLAUDE.md §1).
- This repo never reads from mendy-hq at runtime — the coupling is these URLs, only.
