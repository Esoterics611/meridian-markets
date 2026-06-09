# The run → training loop (every run trains the next)

**Binding intent (Ronnie, 2026-06-09):** each paper run is not a one-off — it is a *training step*.
Every run emits data; that data updates the parameters the next run uses; the next run is
pre-registered, fired, scored, and feeds the one after it. The desk should improve **monotonically
and honestly across runs the way an LLM improves across training steps** — and system dev should keep
pushing the loop toward being *automatic*. This doc is the method.

## The analogy (and where it holds / breaks)

| LLM training | Meridian MM desk | Where it lives |
|---|---|---|
| Training data (a batch) | one run's captured data (fills, NAV, flow, toxicity) | `mm_nav`, the DeskEvent tape, `docs/research/flow-shadow-*.jsonl`, the run log |
| Loss / reward signal | desk **realised** P&L + per-book maxDD + adverse-selection markout | `mm-run-review` skill (reads `mm_nav`) |
| Weights | the run's parameters (γ, κ, spread floor, β-map, hedge cost mult, F3 scales, bias gate) | `scripts/start-desk.sh` env + `app-config.factory.ts` defaults |
| Gradient step | the param update each script computes from the last run | the fitters below |
| Validation set (anti-overfit) | the OOS / purged-k-fold / survivorship gates + **pre-registration** | `NEXT_RUN_PREREG.md`, `scripts/oos-candidates.ts` |
| Overfitting | a "finding" that only appears after adding a coin/horizon mid-run | the standing rule in `NEXT_RUN_PREREG.md` |

**Where the analogy breaks (stay honest):** the market is non-stationary — last run's optimum is a
*prior*, not a converged weight; β and edge **drift with regime**, so we re-fit every run rather than
accumulate. And the sample is tiny vs an LLM corpus — one 10h run is one noisy batch, so we move
params in small, *pre-registered* steps and never chase a single window. The loop's job is to stop us
fooling ourselves, not to "converge" to a fixed config.

## The loop (one turn)

1. **PRE-REGISTER** the next run in `docs/NEXT_RUN_PREREG.md`: frozen universe, the one variable under
   test, and the success metric **before** firing (the anti-p-hacking step). Today: **Run A′**.
2. **RUN** it: `bash scripts/start-desk.sh` + `bash scripts/launch-mm-10h.sh`. The run is configured
   *only* from the registered params; every control is ON and visible (no silent defaults — DR-0).
3. **CAPTURE** (happens automatically during the run):
   - `mm_nav` — durable per-book + desk equity / realised / unrealised / fees / funding / maxDD curve.
   - DeskEvent tape — every fill (with realised), risk-verdict change, **hedge rebalance**, lifecycle.
   - `docs/research/flow-shadow-<ts>.jsonl` — the directional signal, measure-only (zero P&L), i.e. the
     *labeled training set* for the next bias decision.
   - log lines — `F3 toxicity:` (did the adverse defence fire?), `desk delta hedge ON … target:` (β-map).
4. **SCORE** with the `mm-run-review` skill — realised-first (DR-6), never read the multi-MB log whole.
   Append the numbers + verdict to `QUANT_JOURNAL.md`. Did the registered metric pass?
5. **UPDATE the params from the data** (the gradient step — each artifact drives a specific knob):

   | Artifact from the run | Fitter | Param it updates (next run) |
   |---|---|---|
   | HL candles (regime drift) | `scripts/hedge-beta-fit.ts` | `MM_HEDGE_BETA_MAP` (alt→major β) |
   | `flow-shadow-*.jsonl` | `scripts/flow-bias-markout.ts` | the directional **bias gate** (enable a coin's lean only if its forward-return IC clears the threshold — the OOS validation set) |
   | `mm_nav` + the L2 tape | `scripts/mm-l2-tune.ts` / `gamma-kappa-sweep.ts` | γ, κ, `MM_MIN_HALF_SPREAD_BPS` |
   | run review (fill rate vs hedge cost) | by hand for now | `MM_HEDGE_COST_SPREAD_MULT`, `MM_HEDGE_BAND_USD` |
   | run review (F3 widen counts vs adverse-Δ) | by hand for now | `MM_F3_MIN/MAX_SCALE` |

6. **FOLD the update back** into `scripts/start-desk.sh` defaults (and `app-config.factory.ts` when a
   value graduates from "tuned" to "the honest default") + record the source run, so the config is
   always *derived from measured data*, never guessed. Then GOTO 1.

## How to read each run as training signal

- **Realised, not net.** Transient unrealised longs into an up-move are not learning — they are luck
  that mean-reverts (the recurring #41/#44 trap). The reward is **realised** P&L.
- **Did the defences fire?** A run where F3 never widened or the hedge never rebalanced taught us
  nothing about them — instrument-first, then credit (DR-3/DR-2). Check the `F3 toxicity:` counts and
  `.hedge.hedgePnlUsd` ≠ 0 before concluding anything about either.
- **One variable per turn.** If two knobs changed, the run can't attribute the result. The profiles in
  `RUN_THE_DESK.md` are single-knob A/Bs for exactly this reason.

## Pushing toward automatic (the system-dev target)

The loop above is run by hand today; the direction of travel is to **close it in code**:
- **Now:** the fitters exist (`hedge-beta-fit`, `flow-bias-markout`, the sweeps) + the review skill +
  pre-registration discipline. Capture is automatic; the human runs the fitters and edits the config.
- **Next (small):** a `scripts/learn-from-run.ts` that, given the last run's `mm_nav` + shadow capture,
  runs the fitters, prints a diff of the proposed next-run env (β-map, bias gate, cost mult) and a
  draft `NEXT_RUN_PREREG.md` entry — a *suggested gradient step* the human approves.
- **Later (bigger):** a supervised "trainer" loop (a cron/agent) that chains run → review → re-fit →
  pre-register → run unattended for days, **guarded by the OOS/realised gates** so it can't overfit
  itself into a blow-up — the genuinely LLM-training-shaped version. Build toward this; never remove the
  gates that keep it honest.
