import { Injectable } from '@nestjs/common';
import {
  CloseShortRequest,
  CloseShortResult,
  HedgePosition,
  HedgeVenueNotConfiguredError,
  IHedgeVenue,
  OpenShortRequest,
  OpenShortResult,
  VenueHealth,
} from './hedge-venue.interface';

// Real Hyperliquid hedge venue — DORMANT in Phase 1 scaffold.
//
// Wire-up plan (post-KYB + venue access):
//   - openShort   → POST /exchange  { order: { coin: 'ILS-PERP', sz, side: 'short' } }
//   - closeShort  → POST /exchange  { order: { reduceOnly: true, ... } }
//   - position    → POST /info      { type: 'clearinghouseState', user }
//   - health      → GET  /info/meta and watch funding rate + venue uptime
//
// Why Hyperliquid first: highest TVL among perps DEXs (lowest solvency risk in
// the GMX/Drift/Hyperliquid set), deepest ILS-PERP book at the volumes we'd
// trade, fully-on-chain settlement so we don't carry venue custodial risk.
// See PHASED_PLAN.md §Phase 1 — "Hyperliquid > Drift > GMX > others".
//
// Throws HedgeVenueNotConfiguredError until MOCK_HEDGE_ENABLED=false AND
// venue KYB completes + HYPERLIQUID_* secrets are populated. Do not implement
// real REST calls before that — wrong order, same posture as RealOndoYieldProvider.

@Injectable()
export class RealHyperliquidHedgeVenue implements IHedgeVenue {
  readonly venueId = 'hyperliquid';

  async openShort(_req: OpenShortRequest): Promise<OpenShortResult> {
    throw new HedgeVenueNotConfiguredError(this.venueId);
  }

  async closeShort(_req: CloseShortRequest): Promise<CloseShortResult> {
    throw new HedgeVenueNotConfiguredError(this.venueId);
  }

  async fetchPosition(_positionRef: string): Promise<HedgePosition> {
    throw new HedgeVenueNotConfiguredError(this.venueId);
  }

  async fetchHealth(): Promise<VenueHealth> {
    throw new HedgeVenueNotConfiguredError(this.venueId);
  }
}
