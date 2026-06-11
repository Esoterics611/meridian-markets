# MM leak table — run-a2
Window: 2026-06-10T14:00:00.000Z → 2026-06-10T19:30:00.000Z · log: run-20260610-180741-mm10h.log
Snapshot: server down — windowed split unavailable (gap)

**Desk:** net −670 (realised +477, unreal −1331, fees −187) over 5.4h · books-sum net +514 · implied hedge-leg P&L −1184
**Hedge:** 263 orders · $9,088,016 churned · est cost $2454 · 213 track / 48 flip / 2 open · zombie lines 0

## Per-book identity — net = fillEdge + warehouseMTM + funding − fees ($)

| book | net | fillEdge | warehouse | funding | fees | spread | adverse | wedge | maxDD% | worst5m | conc | fills | vpin |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| SUI ⚠stale-state | −520 | n/a | n/a | +0 | −5 | n/a | n/a | n/a | 1.22 | −414 | 12% | n/a | n/a |
| ETH | −205 | +94 | −355 | −0 | −57 | n/a | n/a | n/a | 0.78 | −438 | 21% | n/a | n/a |
| BTC | −123 | +67 | −263 | +1 | −72 | n/a | n/a | n/a | 0.91 | −369 | 20% | n/a | n/a |
| DOGE ⚠stale-state | −32 | n/a | n/a | +0 | −5 | n/a | n/a | n/a | 0.40 | −193 | 17% | n/a | n/a |
| XRP | −11 | +18 | −39 | −1 | −12 | n/a | n/a | n/a | 0.88 | −379 | 18% | n/a | n/a |
| BNB | +39 | +4 | +34 | +0 | −1 | n/a | n/a | n/a | 0.03 | −251 | 75% | n/a | n/a |
| ADA ⚠stale-state | +504 | n/a | n/a | +0 | −6 | n/a | n/a | n/a | 0.79 | −958 | 29% | n/a | n/a |
| SOL ⚠stale-state | +862 | n/a | n/a | +0 | −29 | n/a | n/a | n/a | 1.33 | −891 | 31% | n/a | n/a |

## Ranked leaks ($, largest first)

1. hedge churn (est taker cost): −2454
2. ETH warehouse MTM: −355
3. BTC warehouse MTM: −263
4. XRP warehouse MTM: −39
5. XRP funding paid: −1
6. ETH funding paid: −0

## Gaps (not computable from today's capture)

- Windowed spread/adverse for FINISHED runs: the engine's windowed attribution is not persisted (mm_book_state has 0 for fast books) — live snapshot only.
- Markout by book×side×hour: per-fill markout records are aggregated in-memory, not persisted per hour.
- Queue tercile at fill, top-of-hour toxicity (±3min funding prints): not logged yet.
- HIP-3 (xyz:*) funding: per-dex funding unwired — funding term is 0 by construction, not measured.
- Hedge leg realised P&L: in-memory only (DR-2); implied here as desk-net − books-sum.
