# MM leak table — run52
Window: 2026-06-11T05:45:00.000Z → 2026-06-11T08:35:00.000Z · log: run-20260611-084841-mm10h.log
Snapshot: server down — windowed split unavailable (gap)

**Desk:** net +64 (realised +101, unreal −29, fees +7) over 2.7h · books-sum net +298 · implied hedge-leg P&L −235
**Hedge:** 42 orders · $728,962 churned · est cost $197 · 34 track / 7 flip / 1 open · zombie lines 0

## Per-book identity — net = fillEdge + warehouseMTM + funding − fees ($)

| book | net | fillEdge | warehouse | funding | fees | spread | adverse | wedge | maxDD% | worst5m | conc | fills | vpin |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| ADA | −204 | −9 | −197 | −0 | −3 | n/a | n/a | n/a | 0.40 | −273 | 53% | n/a | n/a |
| SOL | −159 | −23 | −140 | +0 | −4 | n/a | n/a | n/a | 0.31 | −72 | 18% | n/a | n/a |
| xyz:TSLA | −110 | +1 | −109 | +0 | +3 | n/a | n/a | n/a | 0.33 | −57 | 15% | n/a | n/a |
| xyz:SP500 | −85 | +13 | −97 | +0 | +1 | n/a | n/a | n/a | 0.12 | −42 | 25% | n/a | n/a |
| kPEPE | −35 | +95 | −134 | −0 | −4 | n/a | n/a | n/a | 0.32 | −82 | 18% | n/a | n/a |
| PURR | −5 | −22 | +16 | +0 | −0 | n/a | n/a | n/a | 0.05 | −34 | 36% | n/a | n/a |
| xyz:XYZ100 | +15 | +23 | −8 | +0 | +1 | n/a | n/a | n/a | 0.05 | −5 | 48% | n/a | n/a |
| DOGE | +49 | +1 | +47 | −0 | −0 | n/a | n/a | n/a | 0.06 | −21 | 23% | n/a | n/a |
| xyz:CL | +58 | −21 | +92 | +0 | +13 | n/a | n/a | n/a | 0.15 | −51 | 18% | n/a | n/a |
| xyz:NVDA | +92 | +23 | +72 | +0 | +2 | n/a | n/a | n/a | 0.09 | −16 | 41% | n/a | n/a |
| xyz:GOLD | +93 | +4 | +90 | +0 | +2 | n/a | n/a | n/a | 0.10 | −23 | 34% | n/a | n/a |
| SUI | +257 | +12 | +244 | −0 | −1 | n/a | n/a | n/a | 0.06 | −13 | 23% | n/a | n/a |
| FARTCOIN | +333 | −12 | +345 | −1 | −1 | n/a | n/a | n/a | 0.42 | −162 | 24% | n/a | n/a |

## Ranked leaks ($, largest first)

1. ADA warehouse MTM: −197
2. hedge churn (est taker cost): −197
3. SOL warehouse MTM: −140
4. kPEPE warehouse MTM: −134
5. xyz:TSLA warehouse MTM: −109
6. xyz:SP500 warehouse MTM: −97
7. SOL fill edge (picked off): −23
8. PURR fill edge (picked off): −22
9. xyz:CL fill edge (picked off): −21
10. xyz:CL fees paid: −13
11. FARTCOIN fill edge (picked off): −12
12. ADA fill edge (picked off): −9
13. xyz:XYZ100 warehouse MTM: −8
14. xyz:TSLA fees paid: −3
15. xyz:NVDA fees paid: −2

## Gaps (not computable from today's capture)

- Windowed spread/adverse for FINISHED runs: the engine's windowed attribution is not persisted (mm_book_state has 0 for fast books) — live snapshot only.
- Markout by book×side×hour: per-fill markout records are aggregated in-memory, not persisted per hour.
- Queue tercile at fill, top-of-hour toxicity (±3min funding prints): not logged yet.
- HIP-3 (xyz:*) funding: per-dex funding unwired — funding term is 0 by construction, not measured.
- Hedge leg realised P&L: in-memory only (DR-2); implied here as desk-net − books-sum.
