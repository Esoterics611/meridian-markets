# 7 · The term structure — calendars & rolldown

## What it is

Implied vol is not one number; it is a curve in tenor. BTC options quote a 7-day vol, a 30-day vol, a 90-day vol, and the shape of that curve — usually upward-sloping ("contango"), occasionally violently inverted — is itself a tradable object. The **calendar spread** (sell one tenor, buy another) isolates the curve's shape from its level: it is the vol-space sibling of the futures roll-yield trade, and the desk's first *relative-value* book — the edge is no longer "IV > RV" but "this point on the curve is rich relative to that one, and the curve mean-reverts." That makes it the first book in the course whose trigger must come **entirely from a measured distribution** — the desk's own surface tape — because unlike the VRP there is no four-decade literature guaranteeing which way the premium points.

## Math sketch

### Forward variance: what the curve actually says

Variances add across time. The curve's honest content at tenors $T_1 < T_2$ is the **forward variance** — what the market charges for vol *between* the two expiries:

$$\sigma_{\text{fwd}}^2(T_1, T_2) = \frac{\sigma_2^2 T_2 - \sigma_1^2 T_1}{T_2 - T_1}$$

Worked example at the course's smile: 7d IV 34, 30d IV 37 → $\sigma_{\text{fwd}}^2 = (0.37^2 \times 0.0822 - 0.34^2 \times 0.0192)/0.0630$ → $\sigma_{\text{fwd}} \approx 37.9$. An upward-sloping curve embeds forward vols *above* every quoted point — the market pays holders of long-dated vol a rolldown, exactly like a contango futures curve pays the short. If forward vol persistently exceeds subsequently-delivered vol, calendar sellers of the rich point earn it; that "if" is precisely what the VIX-futures literature confirmed for equities (the VIX curve's contango premium funded an ETP industry and destroyed its levered short version — same premium, §1's sizing lesson) and what the desk must **measure** for crypto rather than assume.

### The structure and its ratios

The desk's calendar: **short the front straddle, long the back straddle**, entered only when the front is rich relative to the back. Neutralities, in order of what actually binds:

- **Vega ratio:** ATM vega scales like $\sqrt{\tau}$ (§2), so vega-neutral needs $N_{\text{back}} = N_{\text{front}}\sqrt{T_{\text{front}}/T_{\text{back}}}$ — e.g. short 1.0 front (7d) vs long 0.48 back (30d). This immunizes the *level* of the curve and isolates its *slope*: the position profits when front IV falls relative to back, from either side.
- **What cannot be neutralized and must be budgeted:** gamma. The front leg's gamma dwarfs the back's at any vega ratio (gamma scales like $1/\sqrt{\tau}$), so a vega-neutral calendar is **net short gamma near the front strike** — it is a §6 position wearing relative-value clothes, and it inherits §6's stop and the ladder's vega/gamma budget lines (§11). The desk sizes calendars inside the same short-vol budget precisely because in the crash scenario they *are* short vol.

### The trigger: distribution first (the R7 lesson)

The desk's carry plan already paid for this lesson once (PROFIT_PIVOT_II R7: a threshold set a priori from fee math never fired — the measured distribution said the real trigger was elsewhere). The calendar inherits the fix as a design rule:

$$z_t = \frac{(\sigma_{7d}/\sigma_{30d})_t - \mu_{90d\text{-roll}}}{\hat\sigma_{90d\text{-roll}}}, \qquad \text{enter short-front at } z \ge +2,\; \text{exit at } z \le 0 \text{ or front expiry}$$

with $\mu$, $\hat\sigma$ from the desk's own surface tape (≥ 30 days before the threshold is even *set*, per `OPTIONS_DESK.md` Phase O-3), and a cost floor underneath: the z-trigger must clear the measured round-trip spread of *four* option legs in vol points — calendars pay double the single-structure toll, which kills more calendar edges than the signal ever does. If the measured ratio distribution's tails are sub-cost, the pre-registered honest verdict is "calendar carry is not accessible at our costs" — filed like a killed stat-arb pair, not forced.

## When it works / when it breaks

**Works:** event-rich calm — the front pumps around a known date (FOMC, an ETF ruling, an unlock) while the back barely moves; the ratio z-scores past +2; the event passes; the front collapses onto the curve. The mean-reversion here is structural: front IV is anchored to *this week's* realized (fast-decaying information), back IV to the long-run distribution (slow). Crypto's event cadence and its retail-driven front-end bid make the crypto curve's front end plausibly *richer* than equities' — plausibly, pending the tape (that word is doing pre-registered work).

**Breaks:** backwardation is not noise — **an inverted curve is the market pricing an ongoing crisis, and it is usually right.** The calendar's loss case is entering short-front at z = +2 and watching z go to +6 because the event was real: front IV doubles, spot moves onto the front strike, and the position loses on gamma (§6's channel) faster than the back leg's vega gains. This is why the exit is a *level* (z ≤ 0), the stop is inherited from §6, and — the structural mitigation — the position is **long the back**: unlike a naked front sale, the calendar's crisis loss is bounded by the spread between the legs rather than by the front leg alone. The remaining honest caveat is liquidity mismatch: the back leg's wider quoted spread means unwinding *in* the crisis pays the panic toll; the cost model charges the tape's stressed spreads, not the calm ones.

## Code shape

```typescript
/** One surface-tape row — the collector (O-E1) that every RV book's trigger reads from. */
export interface SurfaceTapeRow {
  tsMs: number;
  underlying: 'BTC' | 'ETH';
  tenorDays: 7 | 14 | 30 | 90;
  atmIv: number;               // fraction
  put25dIv: number; put10dIv: number; call25dIv: number;  // the wings (§8 reads these)
  quotedSpreadVolPts: number;  // the honest cost input, recorded not assumed
  ewmaRv: number;              // §3's estimator, same timestamp
}

export interface CalendarConfig {
  frontDays: 7; backDays: 30;
  entryZ: number;              // +2 — but SET FROM THE TAPE distribution, never a priori (R7)
  exitZ: number;               // 0
  minTapeDays: 30;             // the trigger may not exist before the distribution does
  costFloorVolPts: number;     // measured 4-leg round trip; the calendar's real enemy
}

/** Vega-neutral back-leg ratio: √(T_f/T_b) per §2's √τ vega scaling. */
export function backLegRatio(frontDays: number, backDays: number): number {
  return Math.sqrt(frontDays / backDays);
}
```

## Sources

- Bennett, *Trading Volatility* — the sell-side treatment of term-structure trades, forward vol, and calendar risk.
- The VIX-futures roll-premium literature (e.g. Alexander & Korovilas 2012; the XIV/SVXY episode as its sizing epilogue) — the equity-market analogue of this book's premium and its failure mode.
- Derman (1999), "Regimes of Volatility" — why term-structure shape mean-reverts and when it doesn't.
- Meridian: PROFIT_PIVOT_II R7 (the trigger-from-distribution lesson this book inherits), `docs/OPTIONS_DESK.md` §2-O4 and Phase O-0/O-3 (the tape this book is blocked on).
