# F4 Stage B κ-gate — does flow lead the forward mid-move?  (run-20260614-125055)

Window `2026-06-14T09:52:00Z` → `2026-06-14T14:09:00Z` · headline horizon **60s** · min-n 30
Regression: `r = markout_bps·sideSign` (raw fwd mid-move, bps) ~ `flow`  ·  slope = κ_raw (bps/unit-flow)

## Per (book, horizon)

| book | horizon | n | κ_raw (bps/f) | t | IC | hit% | verdict |
|---|---|---|---|---|---|---|---|
| **POOLED** | 1s | 543 | 0.02 | 0.13 | 0.120 | 59 | GREY |
| **POOLED** | 5s | 543 | 0.03 | 0.18 | 0.106 | 58 | GREY |
| **POOLED** | 30s | 543 | -0.13 | -0.61 | 0.045 | 55 | GREY |
| **POOLED** | 60s | 543 | -0.04 | -0.15 | 0.026 | 53 | GREY |
| **POOLED** | 300s | 543 | -0.27 | -0.52 | 0.004 | 56 | GREY |
| ADA | 1s | 26 | -0.90 | -1.04 | -0.139 | 43 | GREY |
| ADA | 5s | 26 | -1.27 | -1.29 | -0.133 | 45 | GREY |
| ADA | 30s | 26 | -2.32 | -1.72 | -0.154 | 44 | GREY |
| ADA | 60s | 26 | -2.33 | -1.46 | -0.114 | 46 | GREY |
| ADA | 300s | 26 | -3.82 | -1.56 | -0.205 | 50 | GREY |
| DOGE | 1s | 38 | -0.15 | -0.60 | -0.022 | 55 | GREY |
| DOGE | 5s | 38 | 0.20 | 0.73 | 0.132 | 67 | GREY |
| DOGE | 30s | 38 | 0.73 | 1.72 | 0.288 | 64 | GREY |
| DOGE | 60s | 38 | 0.50 | 0.93 | 0.079 | 55 | GREY |
| DOGE | 300s | 38 | 0.29 | 0.14 | 0.022 | 55 | GREY |
| FARTCOIN | 1s | 128 | -0.07 | -0.20 | 0.026 | 50 | GREY |
| FARTCOIN | 5s | 128 | 0.10 | 0.22 | 0.099 | 53 | GREY |
| FARTCOIN | 30s | 128 | 0.09 | 0.15 | 0.003 | 53 | GREY |
| FARTCOIN | 60s | 128 | -0.16 | -0.19 | -0.030 | 49 | GREY |
| FARTCOIN | 300s | 128 | 0.28 | 0.18 | 0.015 | 47 | GREY |
| SOL | 1s | 1 | n/a | n/a | n/a | 100 | GREY |
| SOL | 5s | 1 | n/a | n/a | n/a | 100 | GREY |
| SOL | 30s | 1 | n/a | n/a | n/a | 0 | GREY |
| SOL | 60s | 1 | n/a | n/a | n/a | 100 | GREY |
| SOL | 300s | 1 | n/a | n/a | n/a | 0 | GREY |
| SUI | 1s | 52 | -0.15 | -0.47 | 0.030 | 53 | GREY |
| SUI | 5s | 52 | -0.07 | -0.19 | 0.048 | 52 | GREY |
| SUI | 30s | 52 | 0.40 | 0.58 | 0.051 | 52 | GREY |
| SUI | 60s | 52 | 1.45 | 2.04 | 0.371 | 58 | GREEN |
| SUI | 300s | 52 | 2.99 | 2.15 | 0.262 | 58 | GREEN |
| kPEPE | 1s | 11 | 1.51 | 1.74 | 0.625 | 57 | GREY |
| kPEPE | 5s | 11 | 1.96 | 2.28 | 0.688 | 57 | GREY |
| kPEPE | 30s | 11 | 0.05 | 0.05 | 0.072 | 60 | GREY |
| kPEPE | 60s | 11 | 0.51 | 0.33 | 0.072 | 56 | GREY |
| kPEPE | 300s | 11 | 0.05 | 0.02 | 0.033 | 44 | GREY |
| xyz:CL | 1s | 159 | 0.32 | 1.52 | 0.259 | 67 | GREY |
| xyz:CL | 5s | 159 | 0.33 | 1.35 | 0.152 | 62 | GREY |
| xyz:CL | 30s | 159 | -0.23 | -0.55 | 0.021 | 52 | GREY |
| xyz:CL | 60s | 159 | -0.07 | -0.14 | 0.016 | 48 | GREY |
| xyz:CL | 300s | 159 | 0.37 | 0.38 | 0.045 | 54 | GREY |
| xyz:GOLD | 1s | 128 | -0.17 | -2.66 | -0.117 | 68 | RED |
| xyz:GOLD | 5s | 128 | -0.14 | -2.55 | -0.057 | 66 | RED |
| xyz:GOLD | 30s | 128 | -0.17 | -2.29 | -0.069 | 68 | RED |
| xyz:GOLD | 60s | 128 | -0.11 | -1.07 | -0.097 | 63 | GREY |
| xyz:GOLD | 300s | 128 | -0.07 | -0.30 | -0.012 | 70 | GREY |

## Verdict @ 60s (the pre-registered horizon)

- POOLED (all books): GREY — no significant lead (κ_raw -0.04 bps/f, t -0.15, n 543). κ stays 0.
- ADA: GREY — no significant lead (κ_raw -2.33 bps/f, t -1.46, n 26 < min-n). κ stays 0.
- DOGE: GREY — no significant lead (κ_raw 0.50 bps/f, t 0.93, n 38). κ stays 0.
- FARTCOIN: GREY — no significant lead (κ_raw -0.16 bps/f, t -0.19, n 128). κ stays 0.
- SOL: GREY — no significant lead (κ_raw n/a bps/f, t n/a, n 1 < min-n). κ stays 0.
- **SUI: GREEN** — κ_raw 1.45 bps/f (t 2.04, IC 0.371, n 52). Suggested live κ ≈ 7.27e-5 (½-shrunk, PROVISIONAL — needs a live A/B).
- kPEPE: GREY — no significant lead (κ_raw 0.51 bps/f, t 0.33, n 11 < min-n). κ stays 0.
- xyz:CL: GREY — no significant lead (κ_raw -0.07 bps/f, t -0.14, n 159). κ stays 0.
- xyz:GOLD: GREY — no significant lead (κ_raw -0.11 bps/f, t -1.07, n 128). κ stays 0.

## Recommendation

**Gate NOT cleared desk-wide.** POOLED @ 60s is flat (GREY: κ_raw -0.04 bps/f, t -0.15). The lone per-book GREEN(s) — SUI — are HYPOTHESES, not a green light: among 8 books × 5 horizons (~40 tests) a few fire at |t|≥2 by chance. Do NOT arm κ on them. Flag each as a watch-book and require a dedicated higher-n confirmation run before any lean. κ stays 0.

Watch-book candidates (NOT armed — provisional κ if ever confirmed):
```
SUI|7.272e-5
```
