# Session #63 — F4 Stage A: the flow-reactive risk throttle. Detailed session analysis

> Dedicated single-session analysis (operator request, 2026-06-12). What was built, why each
> piece is shaped the way it is, what the calibration sweep measured, and exactly why the
> result ships **default-OFF**. Companion artifacts: the code on
> `feat/mm-desk-diagnostics-and-guide`, the sweep table
> [research/flow-throttle-sweep.md](research/flow-throttle-sweep.md), Journal #63, and the
> design of record [FLOW_REACTIVE_QUOTING.md](FLOW_REACTIVE_QUOTING.md) §1–§3.

---

## 1. The brief, and the one deliberate deviation

The session prompt was F4 **Stage A only** from MASTER PLAN II: build the flow-reactive
**risk throttle** (κ = 0 — no directional re-centering anywhere), supersede the S4 binary
sweep gate, calibrate θ_enter/θ_exit/dwell by replay on the 14h fine tapes, and ship with
the PART V observability discipline. Stage B (the κ·f·g re-centering term) stays gated on
per-book markout-on-flow regressions over `mm_fill_markout` — data that does not exist in
volume yet.

**The deviation (operator-approved up front):** the F0–F3 validation run has *not* happened
(no leak table newer than run55 exists in `docs/research/`), so this session built F4-A on
top of unvalidated-but-shipped F0–F3 instead of waiting. Consequences handled explicitly:

- **run55 stays the baseline** for every comparison.
- **F2's requote hysteresis stayed OFF** in the sweep config (`MM_REQUOTE_MIN_BPS=0`) — its
  arming decision belongs to the validation run, not to me.
- The next live run will now be validating F0–F3 **and** carrying F4 machinery (default-OFF,
  so it adds observability, not behaviour) — multiple things at once, accepted this time.

## 2. What the S4 gate got wrong, and what replaced it

The S4 `SweepRegimeDetector` (Journal #56) was a **binary** quote-pull: |flow EWMA| > 0.65
AND same-sign drift ≥ 5bps ⇒ pull both quotes. Run55's verdict was that this is
**wrong-shaped**, not just mistuned: kPEPE bled through **3 loss-stops with ZERO gate
engagements** while its triggers fired marginally at 0.65–0.76. A binary gate at a high
threshold protects nothing below the threshold and forfeits all spread above it.

The replacement, `FlowRegimeMachine` (`src/market-making/risk/flow-regime.ts`), changes the
*shape* in three ways:

1. **Graduated, not binary.** A defence ramp `g = clip((persist − 3)/(10 − 3), 0, 1)` scales
   every response. One informed print does nothing (persist gate); sustained flow ramps the
   defence in smoothly. On a flow flip, `g` decays ×0.7/tick instead of snapping — the front
   reversing is itself information.
2. **Toxicity ≠ |flow|. Toxicity = flow against inventory.** The control variable is
   `A = sign(q)·sign(f)`, the spec's second non-negotiable prior. The same |f| = 0.8 tape is
   a *threat* when it pushes inventory further underwater (A<0) and an *exit* when it takes
   inventory off (A>0). S4 could not see the difference; the new machine is built around it.
3. **The strongest action is reserved for the one shape that warrants it.** FLATTEN-ONLY
   (toxic side pulled entirely, reducing side tightened to shed) is reachable **only** from
   DEFENSIVE with A<0 and *sustained* |f| > θ_high. HARVEST (A>0) structurally cannot reach
   it — the hard invariant, enforced in the transition guard, counted
   (`flattenEntriesNotAligned`), unit-tested, and asserted by the sweep script (it
   `exit(1)`s on any violation).

The regime machine (states NORMAL / DEFENSIVE / HARVEST / FLATTEN-ONLY) carries hysteresis
(enter 0.40 / exit 0.25) and a minimum dwell (3s) so it cannot chatter. §3's HALT state was
deliberately **not** modelled here: vol-spike/stale-feed kills are already owned by the risk
gate, loss-stop, and feed watchdog — duplicating them in the flow machine would create two
owners for one decision.

Per-regime responses (all κ=0 — pure throttle):

| regime | spread (sym) | toxic side | safe side | sizes |
|---|---|---|---|---|
| NORMAL | 1 | 1 | 1 | full |
| DEFENSIVE (A≤0) | ×(1+0.5·T·g) | ×(1+1.0·T·g) | ×(1+0.25·T·g) | toxic side cut to floor 0.2 |
| HARVEST (A>0) | 1 | **not widened** (it's the reducing side — flow is the exit) | mild widen | full (we want those fills) |
| FLATTEN-ONLY | 1 | **pulled** (size 0) | tightened ×(1−0.5·g) | reduce-only |

A subtle point worth recording: in HARVEST the "toxic" side (the side flow is hitting) *is*
the reducing side, so §2.3's harvest override (don't widen it) and §2.4's no-size-cut are
the same statement — let flow flatten you. In FLATTEN-ONLY (A<0) the toxic side *is* the
adding side, which is why pulling it is safe and right.

## 3. Where it plugs in — the seam decisions

Three choices define the integration, and each was made to compose with F0–F3 rather than
entangle:

- **Per-side responses ride new `QuoteContext` fields** (`bid/askHalfSpreadScale`,
  `bid/askSizeScale`) applied **universally in `buildQuotePair`** — not inside GlftQuoter.
  Every quoter gets the throttle for free; F3's concentration size-cut (computed by the
  quoter) and F4's flow size-cut (computed by the machine) compose **multiplicatively**
  without either knowing the other exists. F4 owns flow; F3's conc controls own inventory —
  the boundary the prompt demanded, kept by construction. Size scale 0 reuses F3's
  reduce-only plumbing (both engines already treat `sizeUnits = 0` as "side not quoted").
- **The symmetric widen multiplies the F3 `FlowToxicityScaler`** on `ctx.spreadScale`
  (`(toxScale ?? 1) × throttle.spreadScale`). They answer different questions — F3: "is this
  tick's flow unusual vs its own average?"; F4: "is sustained flow running against my
  inventory?" — and the product is the natural composition of two independent widen reasons.
- **The machine lives in `buildFastEngine`** (market-making.module.ts), the single shared
  builder both `makeBook` and `rebuildBook` call — the #47 rehydrate-trap lesson applied:
  a desk restart cannot silently lose the throttle. It sits where `SweepRegimeDetector` sat
  conceptually (the fast path: real aggressor flow + `vpinProvider` + the shared inventory
  book) but *inside* the engine's quote step, because unlike S4's after-the-fact quote pull,
  the throttle must shape the quote *as it is built*.

Supersession is enforced by config, not convention: `MM_REGIME_GATE` is now a selector —
`off` | `sweep` (legacy S4, class + spec kept for history) | `flow` — so **no two flow gates
can run at once**. The historical `MM_REGIME_GATE=true` maps to `flow`: anyone arming "the
regime gate" gets the superseding machine.

Offline = live: `LobReplayHarness` takes the same `FlowRegimeConfig` and constructs the same
class, which is what made the calibration sweep meaningful.

## 4. Observability (PART V) — what a run can now prove

- **Every regime transition** emits a log line + durable tape event **with the triggering
  numbers**: `f, persist, T, A, g, q, θ_enter/exit/high`. `CONTROL ▸` for transitions,
  `BLOCKED ▸` for FLATTEN-ONLY entry (it suppresses a side). Change-driven by the machine
  itself — it physically cannot spam per-tick. Events land in the ring buffer (`/demo`
  Activity feed) and `mm_desk_event` (kinds `control`/`blocked` already persist).
- **A per-interval `F4 flow:` summary line** in `MmNavCron` (the F2/F3 pattern):
  per book `regime f T A g [n/d/h/fl ticks, flatten entries, viol]`. The invariant is
  auditable from the log alone: `grep 'F4 flow'` and check every `viol=0`.
- **Live gauges**: `MmBookSnapshot.flow` (regime/f/T/A/g/persist + lifetime counters) via
  `metrics().flow` — the UI and the leak table can read whether the throttle was engaged.

## 5. The calibration sweep — numbers and the honest read

`scripts/mm-flow-sweep.ts` replayed the five 14h ~1.1s-cadence tapes
(`hl-fine-20260605-{BTC,ETH,SOL,BNB,DOGE}`) through the **live F3-era config** (γ=0.005,
skewMult 6, inv frac 0.10, F3 widen-only 1.0–3.0, conc 0.5/0.85/gain 2, loss-stop 0.01% +
15min cooldown, micro-price depth 5, HL maker rebate) — baseline vs
θ ∈ {0.30/0.18, 0.40/0.25, 0.50/0.35} × dwell {3s, 8s}. Full table:
[research/flow-throttle-sweep.md](research/flow-throttle-sweep.md). The shape of the result,
per coin (adverse sign: **+ = loss to us**):

| coin | what happened | read |
|---|---|---|
| BTC | net −148…+49 vs base; adverse **worse** (+27…+30); stops 13→15/12 | deltas are **stop-path divergence**, not defence: the θ≥0.4 variants touched ~81 of ~45k ticks yet swung net $148 — one changed fill cascades through queue position and loss-stop timing |
| ETH | **+0 everywhere** (throttle engaged 309 def/408 harvest ticks at θ=0.3) | engaged but outcome-neutral: defensive windows never crossed a fill boundary |
| SOL | **+0 everywhere**, fills identical (2147) | same |
| BNB | −9…0 | noise |
| DOGE | adverse −1, fees −1, net −2…+1; **FLATTEN-ONLY fired 2–4× (all A<0)** | the escalation works on real tape; effect marginal but the right sign |
| all | **invariant: zero A>0 flattens, every variant** | the hard structural guarantee holds outside the unit test |

**Against the F4A gate — "ADVERSE down; SPREAD given up < adverse saved; zero A>0
flattens":** the third clause passes everywhere; the first two do **not** clear. Adverse is
flat on 3 coins, marginally better on DOGE, and *worse* on BTC. There is no honest reading
of this table in which the throttle pays for itself on these tapes.

**Why the result is so quiet** — three structural reasons, not excuses:

1. **The June-5 tapes are calm.** The throttle's target shape (a sustained one-sided
   informed sweep against a loaded book) barely occurs: BTC spends 0.05–0.5% of ticks in
   DEFENSIVE at θ≥0.4. A defence calibrated on a window without the disease can only show
   side-effects. This is the same limitation #61 hit ("one window = a read, not a law").
2. **F0–F3 already removed most of what F4 would catch.** The conc controls cap one-sided
   accumulation, the 0.01% loss-stop truncates the warehouse tail, F3 widens into unusual
   flow. F4-A targets the residual −99 fill-edge bucket — the *smallest* leak in the run55
   decomposition (§0.5 of the design doc said exactly this, and the prompt's own gate table
   called F4's P&L "a bonus, not the thesis").
3. **Single-tape path sensitivity swamps small effects.** Queue-aware replay is
   path-dependent: a few widened ticks change one fill, which changes inventory, which moves
   a loss-stop, which rewrites the next hour. ±$150 on one 14h window is inside that noise
   for a 0.5%-of-ticks intervention. Distinguishing a real ±$30 edge needs many windows or
   a live A/B — not more grid points on this tape.

## 6. The shipping decision

The #53/#61 precedent applied: **machinery + evidence, honest defaults.**

- `MM_REGIME_GATE` default **`off`** (config + `start-desk.sh`). Note what this *actually*
  changes live: the previous start-desk default was `true` = the **S4 gate**, which run55
  proved engaged zero times — so going to `off` removes a dead knob, it does not remove a
  working defence. Arming the new machine is one env: `MM_REGIME_GATE=flow`.
- θ defaults ship as **0.40/0.25, dwell 3s** — the sweep's pick in the weak sense that the
  grid is outcome-flat on 4/5 tapes and 0.40/0.25 is mid-grid with DOGE's only positive
  cells; they replace the S4 0.65/5bps priors as *measured-on-tape* values, with the
  explicit caveat that the tape couldn't separate them.
- The hard invariant is now enforced in **three independent places**: the transition guard,
  the unit test, and the sweep script's exit-1 assert.

## 7. What would change the verdict (the path to default-ON)

1. **A tape with the disease.** Capture an HL L2+trades window through a real directional
   day (a CPI print, a >3% hourly move) and re-run the sweep — the throttle's value is
   conditional on the regime existing.
2. **Live shadow evidence.** Run the desk with `MM_REGIME_GATE=flow` on a small book (or
   read the `F4 flow:` lines with the gate off — the machine still measures when wired) and
   compare engaged-window markouts vs calm windows from `mm_fill_markout`.
3. **Stage B's data.** Once `mm_fill_markout` has volume, the per-book markout-on-flow
   regression both gates the directional κ term *and* directly measures whether fills taken
   during DEFENSIVE windows were in fact worse — the cleanest test of whether the throttle
   throttles the right thing.

## 8. Inventory of changes

**New:** `src/market-making/risk/flow-regime.ts` (+spec, 12 tests),
`scripts/mm-flow-sweep.ts`, `docs/research/flow-throttle-sweep.{md,json}`, this doc.
**Modified:** `quote-pair.ts` (per-side ctx scales in buildQuotePair, +4 tests),
`l2-live-fill-engine.ts` (flowMachine cfg, F3×F4 composition, metrics().flow, +2 tests),
`lob-replay.ts` (cfg.flow + flowStats, +2 tests), `mm-book.ts` (snapshot.flow),
`market-making.module.ts` (makeFlowMachine + CONTROL/BLOCKED wiring in buildFastEngine;
sweep detector now `regimeGate==='sweep'` only), `mm-nav.cron.ts` (f4Summary line),
`app-config.{interface,factory}.ts` (selector + 13 MM_FLOW_* knobs), `start-desk.sh`
(default off + knob block + rationale comment). SweepRegimeDetector + spec kept unchanged
(history; selectable via `MM_REGIME_GATE=sweep`).

**Honest status:** F4 Stage A is *built, tested, observable, calibrated as far as the
available tape allows, and OFF.* Nothing in the live desk's behaviour changes until an
operator arms it; what changed is that the desk can now *see* the flow state it was
previously blind to, and the next directional window will be measured instead of argued.
