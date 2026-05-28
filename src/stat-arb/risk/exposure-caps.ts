import { ALLOW, deny, GateDecision } from './gate';

// ExposureCapsGate — three caps in one decision pass:
//   gross — sum of absolute leg notionals across all open positions
//   net   — absolute value of (long - short)
//   pair  — single-pair gross
// Each is checked independently against its cap.

export interface ExposureCapsConfig {
  maxGrossUnits: bigint;
  maxNetUnits: bigint;
  maxPairUnits: bigint;
}

export interface PairExposure {
  pairId: string;
  /** Absolute notional held on the long leg (USDC units). */
  longUnits: bigint;
  /** Absolute notional held on the short leg (USDC units). */
  shortUnits: bigint;
}

export interface ExposureState {
  /** Per-pair exposure across the whole book. */
  positions: PairExposure[];
  /** The order being evaluated. */
  intent: {
    pairId: string;
    longUnits: bigint;
    shortUnits: bigint;
  };
}

function abs(b: bigint): bigint {
  return b < 0n ? -b : b;
}

export class ExposureCapsGate {
  constructor(private readonly cfg: ExposureCapsConfig) {}

  check(s: ExposureState): GateDecision {
    let gross = 0n;
    let net = 0n;
    let pairGross = s.intent.longUnits + s.intent.shortUnits;
    let pairExists = false;
    for (const p of s.positions) {
      gross += p.longUnits + p.shortUnits;
      net += p.longUnits - p.shortUnits;
      if (p.pairId === s.intent.pairId) {
        pairExists = true;
        pairGross += p.longUnits + p.shortUnits;
      }
    }
    // Add the new intent into the book-wide totals.
    gross += s.intent.longUnits + s.intent.shortUnits;
    net += s.intent.longUnits - s.intent.shortUnits;

    if (gross > this.cfg.maxGrossUnits) {
      return deny(`gross exposure ${gross} > cap ${this.cfg.maxGrossUnits}`, {
        gross: gross.toString(),
        cap: this.cfg.maxGrossUnits.toString(),
      });
    }
    if (abs(net) > this.cfg.maxNetUnits) {
      return deny(`net exposure ${net} > cap ±${this.cfg.maxNetUnits}`, {
        net: net.toString(),
        cap: this.cfg.maxNetUnits.toString(),
      });
    }
    if (pairGross > this.cfg.maxPairUnits) {
      return deny(`pair ${s.intent.pairId} gross ${pairGross} > cap ${this.cfg.maxPairUnits}`, {
        pairId: s.intent.pairId,
        pairGross: pairGross.toString(),
        cap: this.cfg.maxPairUnits.toString(),
        pairExists: pairExists ? 1 : 0,
      });
    }
    return ALLOW;
  }
}
