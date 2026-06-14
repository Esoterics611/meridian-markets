# Next-session prompt — close the money gaps (written 2026-06-09, after Journal #45a)

Companion to `docs/NEXT_SESSION_HANDOFF.md` (that one is the UI review; **this one is making the
desk profitable + clearing critical open items**). Paste the block below into a fresh session.

---

```
Continue the Meridian MM desk work. Branch: feat/mm-desk-diagnostics-and-guide (PR #19 open,
all committed/pushed, tree clean). This session is about MAKING THE DESK PROFITABLE and clearing
critical open items — NOT the UI review (that's a separate handoff in docs/NEXT_SESSION_HANDOFF.md).

Do NOT re-read the whole repo. Orient from these only:
- tail -n 140 docs/QUANT_JOURNAL.md  (entries #44 → #45a — the consolidation + the four
  "make money" pillars + the +$194M hedge hotfix)
- docs/NEXT_RUN_PREREG.md  (Run A′ — the pre-registered next run + its realised-≥0 gate)
- docs/RUN_TRAINING_LOOP.md  (every run trains the next — the fitter→param map; this is the method)
- docs/RUN_THE_DESK.md  (the canonical config + every knob's effect)
- the mm-run-review skill  (how to score a run: truth is DB mm_nav, NEVER read the multi-MB log whole)

State of play: drawdown control works (per-book maxDD ≤1.5%). The desk is ~flat-to-slightly-negative
on REALISED P&L. The structural blockers are now fixed (hedge runs on the fast path + is paid for in
the spread + is auditable; F3 instrumented; OOS β-map; the $194M mark bug). The remaining problem is
the EDGE: spread capture ≈ adverse selection. The job is to close that gap honestly.

Hard constraints (CLAUDE.md): work in /home/nexus/code/meridian-markets; commit each phase on the
branch with a Co-Authored-By trailer; verify via tsc + jest (do NOT touch the pre-existing
telemetry.module.spec flake — it fails on old commits too); the dev server does NOT run in this
sandbox (npm run start:dev exits 144) so hand me any live/10h run as a smoke step; never read a big
research artifact end-to-end (jq/grep first). Proceed autonomously, don't gate on per-step approval.

Priorities (money gaps + critical open items, in order):

1. ADVERSE SELECTION — the real leak (highest value). Spread ≈ adverse on ~7/8 books. Tasks:
   (a) Instrument the adverse-selection markout DELTA vs an F3-off baseline so we can prove F3
       actually reduces it (today we can only see F3 fired, not that it helped). Add the adverse-Δ
       to the run-review scorecard.
   (b) Wire/sharpen the fitters that tune the defence: gamma-kappa-sweep.ts / scripts/mm-l2-tune.ts
       over a captured L2 tape to find γ/κ/min-half-spread that make spread > adverse on the majors;
       and sweep MM_F3_MIN/MAX_SCALE. Output a concrete recommended config diff (the training-loop
       gradient step), don't just print numbers.
   (c) Sanity-check the hedge-cost-in-spread mult (MM_HEDGE_COST_SPREAD_MULT=0.5): confirm it isn't
       over-widening and starving fills (check fill counts vs an unhedged baseline).

2. PERSIST ATTRIBUTION TO mm_nav (DR-5). Today only realised/unreal/fees/funding survive shutdown,
   so a post-mortem can't locate the realised leak in the DB — the spread/adverse/inventory-carry
   split dies with the process. Add those columns (migration) + write them from the snapshot in
   MmNavCron, and teach the mm-run-review skill to read them. This is what makes priority 1 reviewable.

3. AUTOMATE THE TRAINING LOOP (docs/RUN_TRAINING_LOOP.md §"Pushing toward automatic"). Build
   scripts/learn-from-run.ts: given the last run's mm_nav + the flow-shadow-*.jsonl capture, run the
   fitters (hedge-beta-fit, flow-bias-markout, the γ/κ sweep) and print (i) a proposed next-run env
   diff and (ii) a draft NEXT_RUN_PREREG.md entry — a suggested gradient step I approve. Don't close
   the loop unattended yet; keep the human in it, guarded by the OOS/realised gates.

4. HEDGE GUARDRAILS (defensive — the new fast-path hedge could misbehave at scale). Add a churn
   guard / min-rebalance-interval or hysteresis so the 100ms hedge can't over-trade, and cap/alert on
   hedge turnover. Add a test. (The #45a fix stopped the price-flicker blow-up; this bounds normal churn.)

5. REPO SIMPLIFY / AUDIT PASS (DR-0, the "we're touching everything" cleanup). Hunt remaining
   config-sprawl + dead paths: audit every MM_* default in app-config.factory.ts (each must be the
   honest production value OR explicitly off — no silent no-ops); quarantine/remove the dormant legacy
   treasury/yield modules if truly unused; and properly fix-or-quarantine the telemetry.module.spec
   isolation flake instead of perpetually skipping it. One coherent commit per concern, each with a
   written keep/quarantine/delete reason.

The proof of all of this is a forward Run A′ that posts desk REALISED ≥ 0 with per-book maxDD ≤1.5%,
the hedge non-trivially live, and F3 demonstrably reducing adverse. If realised is still < 0 after
tuning, the answer is more adverse-selection work or a validated directional lean (Run B, gated) —
NOT more coins. Start by reviewing the most recent run with the mm-run-review skill if I've run one;
otherwise begin at priority 1.
```
