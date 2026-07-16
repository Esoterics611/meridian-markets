# Meridian Desk Brief — 2026-07-16, EOD

**Headline:** One strategy is live and compounding cleanly (carry, 11 legs, DD 0.00% at
snapshot). Everything else the desk has built — MM, regime/directional, prediction markets,
VRP — is validated-or-partially-validated engineering sitting idle. That is the single biggest
inefficiency on the desk right now: capability built, not running.

## Engineering

**Shipped today (PR #38):**
- `acquirePairFill` — pair-coordinated maker execution replacing independent single-leg
  fills: re-peg every tick, one-tick delta safety, fee-aware voluntary-cross gate (opens are
  maker-or-don't-trade). Found and fixed a race trap live (fast leg always wins, expensive leg
  always pays) with a leader/hedge rule — fee floor 3.5 → 1.75bps/leg.
- `HyperliquidSpotClient` — HL-native spot pairs, unlocking HYPE (a deployable stream Binance
  can't hedge). Verified HL's spot fee schedule against the live docs directly rather than
  assuming it mirrored perps — it doesn't (no maker rebate on spot).
- Supervised daily runner for the M2 differential board (the manual cadence had stalled twice
  on human memory).
- **A real ops bug, found the hard way.** Both supervised launchers' `stop` command only
  signaled the top-level `npx` wrapper, three process layers above the actual runner. `stop`
  reported success while the desk kept trading stale code for ~50 minutes. Fixed with `setsid`
  + process-group signaling in both launchers, verified live (`pgid == pid == sid` on the
  restarted process).

**Health check:** tsc clean, 256/257 suites / 1898/1900 tests green. The one red is the
pre-existing telemetry isolation flake — known, not touched, not chased.

**The lesson worth keeping:** "graceful shutdown" had never actually been exercised
end-to-end before today — it looked correct in code review and worked in short smoke tests
(where the process barely had time to matter), but only broke visibly under a real
multi-hour restart. Any `kill -SIGNAL $PID` in a launcher should be treated as unverified
until it's been proven against the actual live process tree, not just the top PID.

## Data

- Full-universe scan: 232 HL perps → 94 gate-pass → 12 deployable counting HYPE (11
  Binance-hedgeable + 1 HL-native).
- M2 funding-differential board: day 1/7, 17/30 pairs harvestable, HL persistently rich vs
  *both* Binance and Bybit on majors — an encouraging early read, but the pre-registration is
  explicit that one or two boards prove nothing; verdict needs 7 consecutive days.
- Fee schedules are now venue- and market-type-specific and verified against live docs (HL
  perp −0.2bps rebate vs HL spot 4/7bps, no rebate) rather than assumed — the kind of detail
  that would have silently overstated the desk's edge if missed.
- Known gaps: kPEPE (k-wrapper unwrap unbuilt), PURR and the rest of the HL-native
  no-Binance-spot tail (queued behind HYPE's forward read), Bybit L2/funding still
  OHLCV-only.

## Infra

- **Live right now:** carry desk (11 legs, persisted to `mm_nav desk='carry'`) + the
  differential-board daily loop. Postgres healthy on :5433.
- **Not running:** everything else — MM desk, the regime/Take-Sides directional book, the ORV
  probability-desk calibration collector, the VRP satellite. All built, all idle.
- Trading-plant Phase A (IBus/NATS, `md-plant`) is live for the HIP-4/Deribit vertical, but
  the carry desk still calls venues directly — Binance/funding feeds onto the bus is the
  remaining Phase A item, not yet load-bearing for anything running today.
- Persistence verified accurate: DB truth (`mm_nav`) matches the log's desk-level aggregate to
  the dollar.

## Strategies

| Desk | State | Read |
|---|---|---|
| **Carry (funding)** | **LIVE** — 11 legs, $1.1M notional | 4 legs (NEAR/AAVE/XPL/UNI) carrying since 07-02/03 with real accumulated funding ($253/$228/$210/$266); 7 fresh entries this restart. maxDD 0.00% at this snapshot. This is the demo curve. |
| **Funding differential (M2)** | Measuring, not trading | Day 1/7. Promising shape, no verdict yet — do not open a leg early. |
| **Market-making** | Built, dormant | Last validated read: adverse selection closed on rebate books, κ=0 confirmed by data (flow doesn't lead price on HL — throttle-only, don't rebuild the directional thesis). Zero capital deployed right now. |
| **Regime / Take-Sides directional** | Built, dormant | Negative book-level read at its own gate (#80); demoted to a benchmark track (P16), supervised launcher exists, not running. |
| **Probability desk (ORV)** | Built, parked | −$78.65 skew lesson; trading correctly parked behind a Brier calibration gate. The calibration collector itself is free, zero-position data collection that should be running continuously and hasn't been. |
| **VRP satellite** | Built, blocked | One RV-estimator artifact found (a window-boundary bug); fix is small (EWMA), not yet applied — so it's not running rather than not working. |
| **Equities stat-arb** | Validated, weak | ~0.06 Sharpe, survivorship-bound. Correctly deprioritized. |
| **Crypto taker stat-arb** | Killed | Cointegration cliff. Don't revisit without new evidence. |

## Next steps — ranked

1. **Restart the ORV calibration collector.** Highest-value/lowest-risk item on the table:
   zero position risk, pure data, idle since #97/#98 when it should be accumulating toward the
   ≥100-settle Brier gate continuously. **Started today** — `scripts/launch-orv-calibration.sh`
   (new supervised launcher, same setsid pattern as the carry desk and differential board).
2. **E7 allocator wiring** (tiered weights + beta-hedge) — the last open item on the carry
   desk's own P1 list, and carry is the strategy actually earning right now, so improving its
   capital allocation has the most direct leverage.
3. **VRP EWMA fix**, then let it join the supervised run as the ≤20%-capital satellite it was
   designed as — small fix, unlocks what the record calls the largest validated-but-unexploited
   edge on the desk.
4. **Keep the M2 board streak alive to day 7**, then take the verdict — no action needed
   beyond not breaking the loop.
5. **HL-native tail expansion** (PURR, others) once HYPE's forward read has a few days behind
   it — don't scale a pattern on one entry.
6. Lower priority: kPEPE k-wrapper, MM desk redeployment — both are real but neither is
   starved for capital or data the way #1–#3 are; better to turn on the idle-but-built engines
   than build more surface area.
