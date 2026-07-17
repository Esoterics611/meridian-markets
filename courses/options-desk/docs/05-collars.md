# 5 · Collars — buying the drawdown bound

## What it is

A collar is a long position in the underlying, a long OTM put (the floor), and a short OTM call that pays for it (the ceiling). It is the only structure in this course whose risk statement is a **contract, not a statistic**: at the put's expiry the position cannot be worth less than the put strike, regardless of what the market did. For a desk whose binding mission is *minimize drawdown and show steady, conserved returns*, the collared core is not one strategy among many — it is the mission rendered as an instrument. This chapter is about building it honestly, which mostly means confronting the well-documented fact that naive protection is a wealth shredder, and engineering around that with the financing leg and the roll discipline.

## Math sketch

### The structure and the bound

Long spot $S$, long put at $K_p < S$, short call at $K_c > S$, same expiry. Terminal value per unit:

$$V_T = S_T + \max(K_p - S_T, 0) - \max(S_T - K_c, 0) \in [K_p,\; K_c]$$

The floor $K_p$ and ceiling $K_c$ hold **at expiry, by arithmetic**. The desk's standard shape: core BTC, **90d 10Δ put** (floor ~20–25% below spot at crypto vols), financed by **30d 25Δ calls** rolled monthly — three call cycles paying for each put cycle, because the smile usually makes short-dated 25Δ calls the most efficient premium source per unit of upside surrendered.

**The path nuance, stated because honesty:** the bound is per put cycle at expiry, not continuous. Mark-to-market can dip below the floor intraperiod (the put hasn't paid out yet), and across a *roll boundary* the new floor is struck off the new, lower spot. A collar bounds each 90-day episode; it does not freeze the high-water mark forever. The tear-sheet reports both: the realized bound per cycle (a construction check — any breach is a book bug) and the cross-cycle path.

### What the floor costs (the honest line)

The literature's warning is Israelov (2017), "Pathetic Protection": systematically buying index puts is so expensive relative to delivered protection that a simply *deleveraged* equity position (own less, hold cash) has historically given more drawdown reduction per unit of forgone return. The mechanism: you buy the richest wing of the smile (§8), you pay the wide quoted spread of illiquid wings, and most puts expire worthless by design. **Any collar book that doesn't quote this paper is selling you something.**

The collar's answer, term by term:

- **The call leg pays for the put leg.** Expected net carry of the desk's shape at the course's standard smile: put ≈ 1.4–2.0% of notional per 90d, three 25Δ call cycles collect ≈ 2.5–3.5%; the *design* range is net −2 to −6%/yr **and can flip positive when the crypto smile inverts** — unlike equities, crypto skew spends real time with calls richer than puts (FOMO regimes, §8), during which the collar is paid to exist. The book measures its own net carry per cycle; the number is a tear-sheet line, not an assumption.
- **The upside surrender is the real cost** and is reported as such: three decades of equity-collar studies (and simple arithmetic) say the ceiling binds more often than the floor. A collar is a *distribution trade* — you are selling the right tail to buy off the left tail. On this desk that is exactly the mandate; on a max-return mandate it would be malpractice.

### Strike governance (mechanical, from the tape)

Both strikes are chosen by delta from the live chain (10Δ put / 25Δ call as design priors), with two overrides measured off the desk's surface tape: widen the put to 5Δ when the put wing's quoted spread exceeds its 90d median by 2× (don't pay panic prices for the floor — the old put still stands until roll), and lift the call to 15Δ when call skew z ≥ +2 (§8: when the market pays FOMO prices for upside, sell it the expensive strike, keep more range). No other discretion exists in the book.

## When it works / when it breaks

**Works:** exactly when the mission needs it — crash episodes (the floor pays; the desk's worst 90d window is bounded at entry) and choppy bear markets (the call leg compounds while the core bleeds within a known range). And *presentationally*: a paper desk demonstrating "AI agents run a low-drawdown book" earns more credibility from one provable floor than from any Sharpe ratio, because the floor is checkable by construction (§12's cheapest gate).

**Breaks:** (1) **The grind-up.** A relentless bull tape pins the position at the ceiling repeatedly; the collar lags spot by the surrendered tail and the book *looks* foolish for quarters at a time. This is the strategy working as designed and must be pre-registered as such, or month-nine pressure will quietly widen the ceiling at the top (the classic failure). (2) **The whipsaw across rolls** — spot crashes into a put expiry (floor pays), rebounds violently just after the new lower-struck collar is set (ceiling binds): a V-bottom monetizes the floor and then caps the recovery. Mitigation is partial (stagger the put ladder across two expiries); mostly this is a known, bounded cost of owning bounded risk. (3) **Wing liquidity** — 10Δ 90d crypto puts can quote 3–5 vol points wide; the cost model charges the real half-spread from the tape (§0's honesty rule), and if the tape says the floor is uneconomic at size, the honest output is a smaller collared core, said out loud.

## Code shape

```typescript
export interface CollarConfig {
  putTenorDays: number;        // 90
  putTargetDelta: number;      // 0.10 (abs) — the floor strike, chosen from the live chain
  callTenorDays: number;       // 30 — three financing cycles per put cycle
  callTargetDelta: number;     // 0.25
  rollPutAtDte: number;        // 30 — roll the floor before its gamma week
  maxPutSpreadVolPts: number;  // refuse to pay a panic wing: fall back to 5Δ or defer roll
}

export interface CollarCycleReport {
  floorUsd: number;            // K_put × qty — the provable bound for this cycle
  worstMarkUsd: number;        // realized trough (may dip below floor intraperiod — reported, expected)
  expiryValueUsd: number;      // MUST be ≥ floorUsd: a construction check, spec-enforced (§12.4)
  netCarryUsd: number;         // calls collected − puts paid, the honest cost line
  ceilingBounds: number;       // how many call cycles pinned — the surrendered-upside count
}

/** The construction check that makes the floor a spec, not a hope. */
export function assertFloorHeld(r: CollarCycleReport): void {
  if (r.expiryValueUsd < r.floorUsd - 1e-6) throw new Error(`collar floor breached: book bug, not market risk`);
}
```

## Sources

- Israelov (2017), "Pathetic Protection: The Elusive Benefits of Protective Puts" — the case against naive floors; required reading before running this book.
- Israelov & Klein (2016), "Risk and Return of Equity Index Collars" — the distribution-trade framing and the historical cost of the ceiling.
- Bennett, *Trading Volatility* — collar/put-spread-collar variations and skew-aware strike selection.
- Meridian: `docs/OPTIONS_DESK.md` §2-O2 (the book spec: DD-bound construction check as the pre-registered metric); §8 of this course for the skew signals that govern the strikes.
