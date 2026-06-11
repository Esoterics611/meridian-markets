# Inventory time-stop sweep — queue-aware replay (S2 task 1)
live GLFT config: γ=0.005 κ=2 skewMult=6 invFrac=0.15 F3 widen-only · grid = age:maxShift

| coin | variant | net $ | realised $ | unreal $ | Δnet vs base | maxDD % | fills | final inv $ | spread $ | adverse $ | fees $ |
|---|---|---|---|---|---|---|---|---|---|---|---|
| BTC | baseline | -2127 | -218 | -1916 | — | 0.85 | 36 | 102711 | 55 | 58 | -7 |
| BTC | T=10m,shift=3bps | -1867 | -154 | -1720 | +260 | 0.78 | 33 | 94118 | 52 | 71 | -7 |
| BTC | T=30m,shift=3bps | -961 | -320 | -662 | +1166 | 0.77 | 107 | 93539 | 76 | 189 | -21 |
| BTC | T=30m,shift=8bps | -730 | -443 | -307 | +1397 | 0.35 | 187 | -59892 | 90 | 28 | -20 |
| ETH | baseline | 899 | 661 | 29 | — | 0.13 | 5055 | 14255 | 343 | 293 | -209 |
| ETH | T=10m,shift=3bps | 1194 | 952 | 29 | +295 | 0.09 | 5101 | 14332 | 353 | 296 | -214 |
| ETH | T=30m,shift=3bps | 899 | 661 | 29 | +0 | 0.13 | 5055 | 14255 | 343 | 293 | -209 |
| ETH | T=30m,shift=8bps | 899 | 661 | 29 | +0 | 0.13 | 5055 | 14255 | 343 | 293 | -209 |
| SOL | baseline | -2637 | 164 | -2838 | — | 1.02 | 793 | 70646 | 181 | 258 | -37 |
| SOL | T=10m,shift=3bps | -4161 | -514 | -3673 | -1524 | 1.52 | 481 | 104782 | 167 | 205 | -26 |
| SOL | T=30m,shift=3bps | -2639 | 204 | -2880 | -2 | 1.02 | 790 | 71690 | 181 | 258 | -37 |
| SOL | T=30m,shift=8bps | -2590 | 211 | -2838 | +47 | 1.01 | 801 | 70639 | 179 | 249 | -37 |
| DOGE | baseline | -118 | -120 | -19 | — | 0.11 | 14964 | -3494 | 53 | 30 | -21 |
| DOGE | T=10m,shift=3bps | -93 | -94 | -19 | +25 | 0.10 | 14396 | -3495 | 55 | 34 | -21 |
| DOGE | T=30m,shift=3bps | -118 | -120 | -19 | +0 | 0.11 | 14964 | -3494 | 53 | 30 | -21 |
| DOGE | T=30m,shift=8bps | -118 | -120 | -19 | +0 | 0.11 | 14964 | -3494 | 53 | 30 | -21 |

Caveats: tapes are 2026-06-04/05 main-dex only (no HIP-3 RWA tape — xyz:* verdict OUT OF SAMPLE);
HYPE tape is 18s-cadence (coarse queue realism); one window per coin = a read, not a law.
