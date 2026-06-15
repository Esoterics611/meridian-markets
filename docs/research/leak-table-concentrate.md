# MM leak table — concentrate
Window: 2026-06-15T01:02:00.000Z → 2026-06-15T05:46:14.324Z · log: run-20260615-040228-mm10h.log
Windowed split: LIVE snapshot · per-fill markouts: mm_fill_markout @ 1s/5s/30s/60s/300s

**Desk:** net −899 (realised −800, unreal −20, fees +77) over 4.7h · books-sum net −964 · hedge-leg P&L measured +11 (implied +65)
**Hedge:** 5 orders · $97,489 churned · est cost $26 · 1 track / 1 flip / 3 open · zombie lines 0

## Hedge legs — measured (mm_hedge_nav, window Δ per leg)

| leg | P&L | funding | fees | last residual | last notional |
|---|---|---|---|---|---|
| BTC | +36.3 | +0.0 | +9.8 | +10 | +3987 |
| ETH | −6.8 | +0.0 | +2.3 | −27 | +7662 |
| XMR | +0.0 | +0.0 | +0.0 | +760 | +0 |
| ZEC | −18.3 | −0.1 | +8.6 | +0 | +28579 |

## Hedge quality (mm_hedge_quality, latest in window)

| book | leg | β cfg | β live | R² | basis share |
|---|---|---|---|---|---|
| BNB | BTC | 0.92 | 0.60 | 0.33 | 77% |
| SOL | ETH | 1.02 | 0.95 | 0.54 | n/a |
| SUI | ETH | 1.29 | 1.10 | 0.31 | 67% |
| XMR | XMR | 1.00 | 1.00 | 1.00 | 0% |
| XRP | BTC | 1.15 | 1.08 | 0.43 | 58% |
| ZEC | ZEC | 1.00 | 1.00 | 1.00 | 0% |

## Hedge variance reduction (F1.6) — σ of 5-min P&L, primary vs primary+leg

| leg | books | σ primary $/√hr | σ hedged $/√hr | reduction | fees | verdict |
|---|---|---|---|---|---|---|
| BTC | BNB XRP | 54.4 | 54.2 | 0% | +9.8 | FLATTEN-ONLY candidate (no variance cut for the fees) |
| ETH | SOL SUI | 48.3 | 46.9 | 3% | +2.3 | FLATTEN-ONLY candidate (no variance cut for the fees) |
| XMR | XMR | 102.6 | 102.6 | 0% | +0.0 | FLATTEN-ONLY candidate (no variance cut for the fees) |
| ZEC | ZEC | 236.9 | 202.5 | 15% | +8.6 | FLATTEN-ONLY candidate (no variance cut for the fees) |

## Per-book identity — net = fillEdge + warehouseMTM + funding − fees ($)

| book | net | fillEdge | warehouse | funding | fees | spread | adverse | wedge | maxDD% | worst5m | conc | fills | vpin | mk1s | mk300s |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| ZEC | −505 | −64 | −392 | +0 | +49 | +133 | +198 | +0 | 0.63 | −213 | 15% | 158 | 0.45 | −1.8 | −4.3 |
| XRP | −247 | +2 | −233 | −0 | +16 | +36 | +34 | −0 | 0.25 | −75 | 20% | 58 | 0.37 | −1.0 | +1.7 |
| SUI | −177 | +1 | −174 | +0 | +5 | +5 | +3 | −0 | 0.23 | −55 | 15% | 69 | 0.44 | −1.8 | −1.0 |
| XMR | −29 | −175 | +157 | −3 | +8 | +46 | +221 | +0 | 0.24 | −104 | 29% | 350 | 0.45 | −1.8 | −2.1 |
| BNB | −6 | +1 | −7 | −0 | −0 | +2 | +1 | −0 | 0.03 | −6 | 8% | 18 | 0.22 | −2.5 | −1.7 |
| SOL | +0 | +0 | +0 | +0 | +0 | +0 | +0 | +0 | 0.00 | +0 | n/a | 0 | 0.56 | n/a | n/a |

## Alignment split — A = sign(q)·sign(flow), markout @ 300s (F4 calibration)

| book | A+ fills | A+ bps | A+ $ | A− fills | A− bps | A− $ |
|---|---|---|---|---|---|---|
| BNB | 9 | −0.4 | −0.1 | 8 | −3.5 | −0.9 |
| SUI | 24 | −4.9 | −6.7 | 43 | +0.9 | −11.3 |
| XMR | 178 | +0.3 | +22.9 | 170 | −4.3 | −288.1 |
| XRP | 27 | +2.8 | −11.7 | 29 | +0.1 | −115.0 |
| ZEC | 77 | −9.2 | +357.7 | 77 | −1.6 | −749.9 |

## Per-hour strip — which hours pay (markout @ 300s)

| hour (UTC) | desk netΔ | fills | ⌀abs(flow) | ⌀vpin | ⌀σ | mk bps | mk $ |
|---|---|---|---|---|---|---|---|
| 2026-06-15T01 | −108.5 | 190 | 0.97 | 0.04 | 1.3e-4 | +5.6 | −127.5 |
| 2026-06-15T02 | −385.8 | 209 | 0.96 | 0.42 | 1.5e-4 | −8.8 | −346.5 |
| 2026-06-15T03 | −184.8 | 254 | 0.95 | 0.44 | 1.3e-4 | −2.5 | −266.2 |

## Microstructure cuts

- Markout @ 300s by queue tercile (1 = front): T1 +8.3bps (n=218) · T2 −9.4bps (n=218) · T3 −5.4bps (n=217)
- Top-of-hour (±3min, funding prints): −9.3bps (n=44) vs rest −1.7bps (n=609)

## Ranked leaks ($, largest first)

1. ZEC warehouse MTM: −392
2. XRP warehouse MTM: −233
3. XMR fill edge (picked off): −175
4. SUI warehouse MTM: −174
5. ZEC fill edge (picked off): −64
6. ZEC fees paid: −49
7. hedge churn (est taker cost): −26
8. hedge leg ZEC (measured): −18
9. XRP fees paid: −16
10. XMR fees paid: −8
11. hedge leg ETH (measured): −7
12. BNB warehouse MTM: −7
13. SUI fees paid: −5
14. XMR funding paid: −3
15. XRP funding paid: −0
