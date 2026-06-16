# Regime Directional Book — the standalone "take sides" strategy

> **Status:** P1 BUILT (2026-06-16), P2–P4 designed. The book core + the consensus gate +
> the directional stop ship offline and unit-tested on `feat/mm-profit-pivot-plan`. This is
> the **standalone** expression of "taking sides" — distinct from the axed *market-maker*
> ([DIRECTIONAL_MM_STRATEGY.md](DIRECTIONAL_MM_STRATEGY.md)), which expresses a view by
> skewing quotes. Here the view is expressed as an **outright, sized, stopped position**.
> Paper-only, realised-first, OOS-gated (CLAUDE.md §7/§10.1).

---

## 1. Why — and why *standalone*

The Profit Pivot (Journal #66–#72) established two things: passive un-edged market-making is
negative-EV for us, and the one game we *can* play is **holding** — funding carry is the first
honest positive-residual read. But carry is delta-neutral by design: it deliberately takes **no**
directional view. The operator's ask is the complement: a book that **does** take a side — but only
when a *statistically obvious*, OOS-validated regime signal says to, and that sits flat otherwise.

The desk already had most of the machinery for this, built for the *axed maker*: an `IBiasSource`
seam with an honesty `validated` flag, concrete signals (funding / flow / momentum / house view), a
full OOS forward-return gate, and the `InventoryBook` P&L engine. What was missing is the **consumer**
that turns a validated view into an *outright* position. Expressing the view as a standalone book
(rather than a quote skew) is simpler to reason about, cleanly separable in attribution, and matches
the operator's framing: *"not a bot — managed in our engine — that evaluates regime changes and takes
conservative, risk-averse trades on statistically obvious chances."*

**Honesty caveat (binding):** a blind directional bet is "a leveraged way to lose." The entire value
of this book is the gate that lets *only a validated* view size a position. Nothing here manufactures
alpha; it sizes, stops, and exits a view the data already earned.

---

## 2. The strategy in one paragraph

Each tick, read a **consensus bias** — a blend that is non-zero only when ≥k independent,
individually-OOS-validated signals agree in sign. If the consensus is strong (`|bias| ≥ bEnter`) and
the regime monitor isn't flagging stand-aside, **open an outright position** sized by conviction
(`baseNotional × min(|bias|, OOS-IC cap)`), long or short per the sign. **Hold** it (collecting funding
on the held side) while the view persists. **Flatten** it the instant any of three things happens: the
**directional stop** breaches (a wrong view is cut), the view **decays/flips** below the exit band, or
the **regime monitor stands the book aside**. Sit flat the rest of the time.

---

## 3. The rules (as built — `src/market-making/directional/regime-directional-book.ts`)

The book is **pure + clock-free** (the caller passes `nowMs` + a tick), exactly like
`FlowRegimeMachine`, so it is fully replayable/unit-testable. Per `update(tick)`:

```
effB = effectiveBias(reading)        # 0 unless reading.validated — THE gate (single enforcement point)

1. STOP (preempts all):  inv≠0 AND unrealised < −stopFrac·|notional|  ⇒ flatten, trigger 'loss-stop'
2. STAND-ASIDE:          tick.standAside                              ⇒ flatten / no entry, 'stand-aside'
3. SIGNAL → target:
   flat:                 |effB| ≥ bEnter ? sizedUnits(sign, conviction) : 0
   holding, |effB|<bExit OR sign==0:                                  ⇒ 0   ('decay')
   holding, sign flipped: |effB| ≥ bEnter ? flip-to-opposite : 0      ⇒     ('flip' / 'decay')
   holding, same side, |effB| ≥ bExit:                                ⇒ HOLD (no resize churn)
```

- **Conviction sizing** (`sizedUnits`): `conviction = min(|bias|, biasMagnitudeCap(IC,k,hardCap))`
  when a tick carries the OOS IC, else `|bias|`; `notionalUsd = min(base·conviction, maxNotional)`.
- **Directional stop** (`stopBreached`): mark-to-market loss beyond `stopFrac × |position notional|`.
  Evaluated **first**, so a blown view is cut by the *stop*, not coincidentally by decay — the STEP −1
  coherence requirement (CLAUDE.md §10.1) is structural, not incidental.
- **Hysteresis** (`bExit < bEnter`, enforced in the ctor): once in a position, size is fixed at entry
  and held until an exit condition — no continuous re-sizing, so the book doesn't churn on noise.
- **Funding accrual**: a long PAYS `rate·notional·Δh` when funding is positive, a short RECEIVES it —
  the carry bonus when the chosen side is also the funding-paid side.
- **Tape**: every entry/exit/stop emits a `DeskEvent` (`fillEvent` with the trigger; a `controlEvent`
  on the loss-stop) via an optional `onEvent` hook — same auditable feed as the MM desk.

### 3a. The consensus gate (`consensus-bias-source.ts`)

`ConsensusBiasSource(sources[], { minAgree, vetoOnConflict })` implements `IBiasSource`. It wraps N
constituent sources and, using `effectiveBias` (which zeroes any unvalidated reading), returns:
fewer than `minAgree` validated same-sign votes ⇒ **neutral**; any opposing validated vote (with
`vetoOnConflict`) ⇒ **neutral** (stand aside on internal disagreement); otherwise the **mean of the
agreeing biases**. This is the literal *"take sides only when funding + trend align"* rule — and it
inherits each signal's OOS gate rather than re-implementing it.

---

## 4. What it reuses (no rebuild — CLAUDE.md §6/§7)

| Need | Reused from |
|---|---|
| Signal + `validated` honesty flag | `bias/bias-source.interface.ts` (`effectiveBias` is the one enforcement point) |
| Concrete signals | `bias/funding-bias-source.ts`, `bias/flow-bias-source.ts`, `bias/manual-bias-source.ts` |
| OOS gate (purged k-fold + deflated-Sharpe + IC + verdict + size cap) | `bias/oos/forward-return-ic.ts` |
| Position + P&L (avg-cost, mark, realised/unrealised, fees) | `inventory/inventory-book.ts` |
| Event tape (`/api/market-making/events`, `/demo` Activity) | `events/desk-event.ts` |
| Regime inputs (funding/basis/vol) — P3 | `funding/funding-carry.ts`, `cross-venue/*`, `risk/flow-regime.ts` |

---

## 5. Risk controls (the directional exposure is real, so gate it)

1. **Directional stop** — the hard backstop; flattens before the slow exits. Default 2% of notional.
2. **Conviction sizing** — low / barely-validated conviction ⇒ small or zero position; never let the
   directional band exceed the desk's 2% maxDD budget.
3. **Decay/flip exit** — a faded, flipped, or de-validated view is exited, not ridden.
4. **Stand-aside** — the regime monitor (P3) flattens on basis blowout / vol spike / stale feed.
5. **Per-symbol allow-list** — only symbols whose signal is `VALIDATED` today (the P2 gate) are
   eligible; re-gate before every session (regimes shift over weeks — the BNB lesson, #72).

---

## 6. Acceptance criteria (P1 — all locked by spec, green 2026-06-16)

- A neutral / unvalidated reading **never opens** a position (the swap-seam safe default; no regression).
- A validated strong view opens an outright position on the correct side, **monotonic** in conviction,
  capped by the OOS IC when supplied.
- The directional stop flattens a losing position and **preempts** the still-strong signal.
- A decayed / flipped / stand-aside view exits to flat; a same-side in-band view **holds** (no churn).
- Funding accrues with the correct sign and is included in total P&L.
- `tsc` + `jest src/market-making/directional src/market-making/bias` green (10 suites / 70 tests).

---

## 7. Phased plan

> **Execution:** the per-session copy-paste prompts (with the trader UI/cockpit spec) live in
> [REGIME_DIRECTIONAL_PLAYBOOK.md](REGIME_DIRECTIONAL_PLAYBOOK.md) — paste one block per session.

1. **P1 — the book + consensus gate + stop (DONE).** Offline, unit-tested, paper-first.
2. **P2 — `scripts/regime-bias-oos.ts`.** Per symbol, build `(signal, forwardReturn)` pairs from real
   history and run `oosForwardReturnIc` + `verdictFor` → the per-symbol **VALIDATED board** + the
   pre-registered success metric. Only VALIDATED symbols trade live. (Analogue of `funding-carry-oos.ts`.)
3. **P3 — `regime-monitor.ts` + tape wiring.** Per-symbol regime state from funding (`staticCarry`),
   basis (`CrossVenueFairValue`), and vol/flow (`FlowRegimeMachine`); fire a `DeskEvent` on every
   regime transition (the "monitor regime changes" deliverable, on `/demo`). Drives the book's
   `standAside`; the same funding-regime read later tightens the carry gate (the BNB fix — shared spine).
4. **P4 — `scripts/regime-book-live.ts`.** Gate first, open conviction-sized paper positions, mark each
   tick, apply the stop + stand-aside, accrue funding, emit events, persist the equity curve to `mm_nav`,
   print a **realised-first** verdict. Forward-paper track record = the demo. (Template: `funding-carry-live.ts`.)

---

## 8. What this does and does NOT claim

- **It does** give the desk a conservative, validated way to *take a side* — sized by conviction,
  cut by a stop, exited on regime change — reusing the engine's existing honesty machinery end-to-end.
- **It does NOT** manufacture alpha. If no signal validates OOS, the book sits flat and trades nothing —
  which, per the mission (honesty is the whole game), is the correct and truthful outcome.
