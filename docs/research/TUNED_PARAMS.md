# Tuned market-making parameters — the winners' book

> **What this is.** The desk's record of the **best (γ, κ, floor) per coin** found by the L2 queue-aware tuner (`scripts/mm-l2-tune.ts`), so future sessions reuse a *verified* calibration instead of the engine defaults. The tuner prints winners to the console; **you record them here** (it doesn't auto-save). One row = one coin, judged on a real L2 tape at the venue's maker fee, drawdown-compliant.
>
> **How to use a row:** launch the book with those params (see [OPERATIONS_MANUAL.md](../OPERATIONS_MANUAL.md) §3/§5). γ and κ go in the launch `params`; the **floor** is the server's `MM_MIN_HALF_SPREAD_BPS` (env-only — set it in `.env` and restart).

| Coin | γ (gamma) | κ (kappa) | floor (bps) | maker-net | maxDD | source tape / date | notes |
|---|---|---|---|---|---|---|---|
| **BTC** | 0.0005 | 1 | 5 | **+$345 / 2h / $1M** | 0.53% | `wsflow1` (2026-06-04, ~2h, real WS flow) — Journal #23 | first net-positive honest-fill read at the −0.2bps rebate; n=1 window, directional not deployable |
| ETH | — | — | — | *stand aside* | — | wsflow1 | no profitable calibration on that window |
| SOL | — | — | — | *stand aside* | — | wsflow1 | no profitable calibration on that window |
| XRP | _tbd_ | | | | | hl-discovery capture (in progress) | discovery candidate (σ≈ETH, funding −19% APR) |
| DOGE | _tbd_ | | | | | hl-discovery capture | discovery candidate |
| ASTER | _tbd_ | | | | | hl-discovery capture | discovery candidate |
| BNB | _tbd_ | | | | | hl-discovery capture | discovery candidate |

**Defaults (for reference):** γ=0.0025, κ=2, floor=1bps (`MM_GAMMA` / `MM_KAPPA` / `MM_MIN_HALF_SPREAD_BPS`).

**Honesty rule:** a single tape is n=1. Re-capture across ≥2–3 sessions/regimes before trusting a row live; a row that only wins on one window stays marked *directional*.
