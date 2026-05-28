import { Injectable } from '@nestjs/common';
import {
  Fill,
  ITradingVenue,
  PlaceOrderRequest,
  TradingVenueNotConfiguredError,
} from './trading-venue.interface';

// DORMANT in Phase 3 demo. Throws TradingVenueNotConfiguredError on every
// method until MOCK_TRADING_ENABLED=false AND Binance KYB completes +
// BINANCE_* secrets are populated. Same posture as RealHyperliquidHedgeVenue
// and RealOndoYieldProvider — ship the stub, leave mock-default on, refuse
// to fire without business sign-off.
//
// Wire-up plan (post-KYB + API key issuance):
//   - placeOrder  → POST /api/v3/order  (HMAC-SHA256 signed; recvWindow=5000)
//   - fetchPrice  → GET  /api/v3/ticker/price?symbol=...
// Spot only; no margin or futures in the Phase 3 scaffold.

@Injectable()
export class RealBinanceVenue implements ITradingVenue {
  readonly venueId = 'binance';

  async placeOrder(_req: PlaceOrderRequest): Promise<Fill> {
    throw new TradingVenueNotConfiguredError(this.venueId);
  }

  async fetchPrice(_symbol: string): Promise<bigint> {
    throw new TradingVenueNotConfiguredError(this.venueId);
  }
}
