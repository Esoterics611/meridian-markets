# MM leak table — run55
Window: 2026-06-11T13:46:37.000Z → 2026-06-11T17:25:44.000Z · log: run-20260611-172435-mm10h.log
Snapshot: server down — windowed split unavailable (gap)

**Desk:** net −879 (realised −123, unreal −538, fees +218) over 3.6h · books-sum net −422 · implied hedge-leg P&L −458
**Hedge:** 56 orders · $1,620,282 churned · est cost $437 · 29 track / 19 flip / 8 open · zombie lines 0

## Per-book identity — net = fillEdge + warehouseMTM + funding − fees ($)

| book | net | fillEdge | warehouse | funding | fees | spread | adverse | wedge | maxDD% | worst5m | conc | fills | vpin |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| ADA | −206 | −16 | −138 | +0 | +53 | n/a | n/a | n/a | 0.25 | −7559 | 94% | n/a | n/a |
| kPEPE | −127 | −2 | −72 | +0 | +52 | n/a | n/a | n/a | 0.16 | −3033717 | 73% | n/a | n/a |
| xyz:GOLD | −79 | +6 | −58 | +0 | +27 | n/a | n/a | n/a | 0.08 | −78 | 99% | n/a | n/a |
| FARTCOIN | −74 | +7 | −71 | +0 | +11 | n/a | n/a | n/a | 0.08 | −30327 | 68% | n/a | n/a |
| xyz:CL | −67 | −51 | +59 | +0 | +76 | n/a | n/a | n/a | 0.27 | −2085 | 89% | n/a | n/a |
| SOL | +25 | +5 | +20 | −0 | +0 | n/a | n/a | n/a | 0.04 | −20416 | 100% | n/a | n/a |
| SUI | +48 | −2 | +61 | −0 | +11 | n/a | n/a | n/a | 0.10 | −222 | 79% | n/a | n/a |
| DOGE | +59 | −46 | +104 | +0 | −1 | n/a | n/a | n/a | 0.05 | −16 | 20% | n/a | n/a |

## Ranked leaks ($, largest first)

1. hedge churn (est taker cost): −437
2. ADA warehouse MTM: −138
3. xyz:CL fees paid: −76
4. kPEPE warehouse MTM: −72
5. FARTCOIN warehouse MTM: −71
6. xyz:GOLD warehouse MTM: −58
7. ADA fees paid: −53
8. kPEPE fees paid: −52
9. xyz:CL fill edge (picked off): −51
10. DOGE fill edge (picked off): −46
11. xyz:GOLD fees paid: −27
12. ADA fill edge (picked off): −16
13. SUI fees paid: −11
14. FARTCOIN fees paid: −11
15. SUI fill edge (picked off): −2

## Gaps (not computable from today's capture)

- Windowed spread/adverse for FINISHED runs: the engine's windowed attribution is not persisted (mm_book_state has 0 for fast books) — live snapshot only.
- Markout by book×side×hour: per-fill markout records are aggregated in-memory, not persisted per hour.
- Queue tercile at fill, top-of-hour toxicity (±3min funding prints): not logged yet.
- HIP-3 (xyz:*) funding: per-dex funding unwired — funding term is 0 by construction, not measured.
- Hedge leg realised P&L: in-memory only (DR-2); implied here as desk-net − books-sum.
