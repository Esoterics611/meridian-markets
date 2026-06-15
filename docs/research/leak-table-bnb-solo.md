# MM leak table — bnb-solo
Window: 2026-06-15T05:55:00.000Z → 2026-06-15T07:36:03.243Z · log: run-20260615-085919-mm10h.log
Windowed split: LIVE snapshot · per-fill markouts: mm_fill_markout @ 1s/5s/30s/60s/300s

**Desk:** net −83 (realised +1, unreal −86, fees −2) over 1.6h · books-sum net −138 · hedge-leg P&L measured +56 (implied +56)
**Hedge:** 1 orders · $88,785 churned · est cost $24 · 0 track / 0 flip / 1 open · zombie lines 0

## Hedge legs — measured (mm_hedge_nav, window Δ per leg)

| leg | P&L | funding | fees | last residual | last notional |
|---|---|---|---|---|---|
| BTC | +55.6 | +0.0 | +26.6 | −112 | −88702 |

## Hedge quality (mm_hedge_quality, latest in window)

| book | leg | β cfg | β live | R² | basis share |
|---|---|---|---|---|---|
| BNB | BTC | 0.92 | 0.62 | 0.29 | 61% |

## Hedge variance reduction (F1.6) — σ of 5-min P&L, primary vs primary+leg

| leg | books | σ primary $/√hr | σ hedged $/√hr | reduction | fees | verdict |
|---|---|---|---|---|---|---|
| BTC | BNB | 173.3 | 184.3 | -6% | +26.6 | FLATTEN-ONLY candidate (no variance cut for the fees) |

## Per-book identity — net = fillEdge + warehouseMTM + funding − fees ($)

| book | net | fillEdge | warehouse | funding | fees | spread | adverse | wedge | maxDD% | worst5m | conc | fills | vpin | mk1s | mk300s |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| BNB | −138 | −55 | −86 | +1 | −2 | +33 | +35 | −52 | 0.30 | −159 | 50% | 4 | 0.00 | −2.6 | +0.9 |

## Alignment split — A = sign(q)·sign(flow), markout @ 300s (F4 calibration)

| book | A+ fills | A+ bps | A+ $ | A− fills | A− bps | A− $ |
|---|---|---|---|---|---|---|
| BNB | 2 | −1.4 | +11.7 | 1 | +2.7 | +0.3 |

## Per-hour strip — which hours pay (markout @ 300s)

| hour (UTC) | desk netΔ | fills | ⌀abs(flow) | ⌀vpin | ⌀σ | mk bps | mk $ |
|---|---|---|---|---|---|---|---|
| 2026-06-15T06 | +0.0 | 3 | 1.00 | 0.00 | 1.0e-4 | +0.8 | +0.1 |
| 2026-06-15T07 | −82.9 | 1 | 1.00 | 0.00 | 1.0e-4 | +1.2 | +11.8 |

## Microstructure cuts

- Markout @ 300s by queue tercile (1 = front): T1 +3.2bps (n=2) · T2 −4.0bps (n=1) · T3 +1.2bps (n=1)
- Top-of-hour (±3min, funding prints): no fills vs rest +0.9bps (n=4)

## Ranked leaks ($, largest first)

1. BNB warehouse MTM: −86
2. BNB fill edge (picked off): −55
3. hedge churn (est taker cost): −24
