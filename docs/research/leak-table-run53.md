# MM leak table — run53
Window: 2026-06-11T08:46:00.000Z → 2026-06-11T12:43:00.000Z · log: run-20260611-114514-mm10h.log
Snapshot: server down — windowed split unavailable (gap)

**Desk:** net −973 (realised −928, unreal +13, fees +58) over 3.9h · books-sum net −1316 · implied hedge-leg P&L +343
**Hedge:** 12 orders · $173,778 churned · est cost $47 · 10 track / 1 flip / 1 open · zombie lines 0

## Per-book identity — net = fillEdge + warehouseMTM + funding − fees ($)

| book | net | fillEdge | warehouse | funding | fees | spread | adverse | wedge | maxDD% | worst5m | conc | fills | vpin |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| xyz:CL | −707 | −62 | −618 | +0 | +27 | n/a | n/a | n/a | 0.93 | −626 | 57% | n/a | n/a |
| xyz:SKHX | −440 | −632 | +209 | +0 | +17 | n/a | n/a | n/a | 0.82 | −273 | 28% | n/a | n/a |
| xyz:SPCX | −357 | −5 | −345 | +0 | +7 | n/a | n/a | n/a | 0.57 | −380 | 59% | n/a | n/a |
| xyz:NVDA | −134 | +26 | −154 | +0 | +5 | n/a | n/a | n/a | 0.30 | −64 | 17% | n/a | n/a |
| kPEPE | −102 | +37 | −143 | +0 | −4 | n/a | n/a | n/a | 0.21 | −432 | 60% | n/a | n/a |
| xyz:GOLD | −91 | +6 | −92 | +0 | +4 | n/a | n/a | n/a | 0.25 | −89 | 31% | n/a | n/a |
| PURR | −0 | −0 | −0 | −0 | −0 | n/a | n/a | n/a | 0.00 | −0 | 35% | n/a | n/a |
| FARTCOIN | +14 | −23 | +35 | +0 | −3 | n/a | n/a | n/a | 0.16 | −85 | 28% | n/a | n/a |
| xyz:TSLA | +28 | −3 | +31 | +0 | +0 | n/a | n/a | n/a | 0.03 | −19 | 50% | n/a | n/a |
| xyz:ORCL | +472 | −128 | +612 | +0 | +12 | n/a | n/a | n/a | 0.37 | −244 | 45% | n/a | n/a |

## Ranked leaks ($, largest first)

1. xyz:SKHX fill edge (picked off): −632
2. xyz:CL warehouse MTM: −618
3. xyz:SPCX warehouse MTM: −345
4. xyz:NVDA warehouse MTM: −154
5. kPEPE warehouse MTM: −143
6. xyz:ORCL fill edge (picked off): −128
7. xyz:GOLD warehouse MTM: −92
8. xyz:CL fill edge (picked off): −62
9. hedge churn (est taker cost): −47
10. xyz:CL fees paid: −27
11. FARTCOIN fill edge (picked off): −23
12. xyz:SKHX fees paid: −17
13. xyz:ORCL fees paid: −12
14. xyz:SPCX fees paid: −7
15. xyz:SPCX fill edge (picked off): −5

## Gaps (not computable from today's capture)

- Windowed spread/adverse for FINISHED runs: the engine's windowed attribution is not persisted (mm_book_state has 0 for fast books) — live snapshot only.
- Markout by book×side×hour: per-fill markout records are aggregated in-memory, not persisted per hour.
- Queue tercile at fill, top-of-hour toxicity (±3min funding prints): not logged yet.
- HIP-3 (xyz:*) funding: per-dex funding unwired — funding term is 0 by construction, not measured.
- Hedge leg realised P&L: in-memory only (DR-2); implied here as desk-net − books-sum.
