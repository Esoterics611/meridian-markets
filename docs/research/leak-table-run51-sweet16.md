# MM leak table — run51-sweet16
Window: 2026-06-10T22:20:00.000Z → 2026-06-11T02:15:00.000Z · log: run-20260611-012606-mm10h.log
Snapshot: server down — windowed split unavailable (gap)

**Desk:** net −1491 (realised −1084, unreal −393, fees +13) over 3.7h · books-sum net −1960 · implied hedge-leg P&L +469
**Hedge:** 53 orders · $1,383,291 churned · est cost $373 · 46 track / 6 flip / 1 open · zombie lines 0

## Per-book identity — net = fillEdge + warehouseMTM + funding − fees ($)

| book | net | fillEdge | warehouse | funding | fees | spread | adverse | wedge | maxDD% | worst5m | conc | fills | vpin |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| xyz:BRENTOIL | −1455 | −277 | −1128 | +0 | +50 | n/a | n/a | n/a | 1.61 | −279 | 14% | n/a | n/a |
| HYPE | −1319 | −373 | −1126 | +1 | −179 | n/a | n/a | n/a | 1.76 | −458 | 15% | n/a | n/a |
| xyz:SILVER | −850 | −742 | −56 | +0 | +52 | n/a | n/a | n/a | 1.25 | −259 | 15% | n/a | n/a |
| ADA ⚠stale-state | −496 | n/a | n/a | +0 | −2 | n/a | n/a | n/a | 0.96 | −308 | 21% | n/a | n/a |
| SOL ⚠stale-state | −279 | n/a | n/a | +0 | −13 | n/a | n/a | n/a | 0.55 | −177 | 17% | n/a | n/a |
| DOGE ⚠stale-state | −211 | n/a | n/a | +0 | −1 | n/a | n/a | n/a | 0.28 | −49 | 13% | n/a | n/a |
| xyz:XYZ100 ⚠stale-state | −148 | n/a | n/a | +0 | +1 | n/a | n/a | n/a | 0.28 | −91 | 24% | n/a | n/a |
| SUI ⚠stale-state | −108 | n/a | n/a | +0 | −9 | n/a | n/a | n/a | 0.55 | −177 | 16% | n/a | n/a |
| xyz:SP500 ⚠stale-state | −13 | n/a | n/a | +0 | +3 | n/a | n/a | n/a | 0.23 | −53 | 16% | n/a | n/a |
| xyz:GOLD ⚠stale-state | +76 | n/a | n/a | +0 | +6 | n/a | n/a | n/a | 0.34 | −100 | 19% | n/a | n/a |
| xyz:NVDA ⚠stale-state | +90 | n/a | n/a | +0 | +8 | n/a | n/a | n/a | 0.23 | −66 | 18% | n/a | n/a |
| xyz:TSLA ⚠stale-state | +210 | n/a | n/a | +0 | +6 | n/a | n/a | n/a | 0.28 | −88 | 13% | n/a | n/a |
| FARTCOIN ⚠stale-state | +317 | n/a | n/a | +0 | −7 | n/a | n/a | n/a | 0.24 | −126 | 29% | n/a | n/a |
| PURR ⚠stale-state | +382 | n/a | n/a | +0 | −1 | n/a | n/a | n/a | 0.15 | −94 | 33% | n/a | n/a |
| kPEPE ⚠stale-state | +525 | n/a | n/a | +0 | −2 | n/a | n/a | n/a | 0.26 | −91 | 31% | n/a | n/a |
| xyz:CL ⚠stale-state | +1320 | n/a | n/a | +0 | +101 | n/a | n/a | n/a | 0.25 | −89 | 30% | n/a | n/a |

## Ranked leaks ($, largest first)

1. xyz:BRENTOIL warehouse MTM: −1128
2. HYPE warehouse MTM: −1126
3. xyz:SILVER fill edge (picked off): −742
4. hedge churn (est taker cost): −373
5. HYPE fill edge (picked off): −373
6. xyz:BRENTOIL fill edge (picked off): −277
7. xyz:CL fees paid: −101
8. xyz:SILVER warehouse MTM: −56
9. xyz:SILVER fees paid: −52
10. xyz:BRENTOIL fees paid: −50
11. xyz:NVDA fees paid: −8
12. xyz:TSLA fees paid: −6
13. xyz:GOLD fees paid: −6
14. xyz:SP500 fees paid: −3
15. xyz:XYZ100 fees paid: −1

## Gaps (not computable from today's capture)

- Windowed spread/adverse for FINISHED runs: the engine's windowed attribution is not persisted (mm_book_state has 0 for fast books) — live snapshot only.
- Markout by book×side×hour: per-fill markout records are aggregated in-memory, not persisted per hour.
- Queue tercile at fill, top-of-hour toxicity (±3min funding prints): not logged yet.
- HIP-3 (xyz:*) funding: per-dex funding unwired — funding term is 0 by construction, not measured.
- Hedge leg realised P&L: in-memory only (DR-2); implied here as desk-net − books-sum.
