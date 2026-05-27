import { ConfigService } from '@nestjs/config';
import { HedgeVenueUnhealthyError, VenueHealth } from './hedge-venue.interface';
import { HedgeCircuitBreaker } from './hedge-circuit-breaker';
import { FeedStaleError } from './hedge.errors';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeCfg(
  maxFundingBps = 100,
  maxFeedStalenessMs = 300_000,
  ilsSigmaBps = 94,
): ConfigService {
  return {
    getOrThrow: () => ({
      hedge: { maxFundingBps, maxFeedStalenessMs, ilsSigmaBps },
    }),
  } as unknown as ConfigService;
}

function healthyVenue(lastFundingBps = 5): VenueHealth {
  return { healthy: true, lastFundingBps, lastUpdate: new Date() };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('HedgeCircuitBreaker', () => {
  describe('checkVenueHealth', () => {
    it('passes when venue is healthy and funding is below the limit', () => {
      const breaker = new HedgeCircuitBreaker(makeCfg(100));
      expect(() => breaker.checkVenueHealth(healthyVenue(50))).not.toThrow();
    });

    it('throws HedgeVenueUnhealthyError when venue.healthy is false', () => {
      const breaker = new HedgeCircuitBreaker(makeCfg(100));
      const unhealthy: VenueHealth = { healthy: false, lastFundingBps: 5, lastUpdate: new Date() };
      expect(() => breaker.checkVenueHealth(unhealthy)).toThrow(HedgeVenueUnhealthyError);
    });

    it('throws HedgeVenueUnhealthyError when funding bps exceeds the max', () => {
      const breaker = new HedgeCircuitBreaker(makeCfg(100));
      const highFunding: VenueHealth = { healthy: true, lastFundingBps: 101, lastUpdate: new Date() };
      expect(() => breaker.checkVenueHealth(highFunding)).toThrow(HedgeVenueUnhealthyError);
    });

    it('passes exactly at the limit (boundary: == max is allowed)', () => {
      const breaker = new HedgeCircuitBreaker(makeCfg(100));
      expect(() => breaker.checkVenueHealth(healthyVenue(100))).not.toThrow();
    });
  });

  describe('checkFeedStaleness', () => {
    it('passes when the feed is fresh', () => {
      const breaker = new HedgeCircuitBreaker(makeCfg(100, 300_000));
      const recentAsOf = new Date(Date.now() - 1_000); // 1 second ago
      const now = new Date();
      expect(() => breaker.checkFeedStaleness(recentAsOf, now)).not.toThrow();
    });

    it('throws FeedStaleError when the feed exceeds maxFeedStalenessMs', () => {
      const breaker = new HedgeCircuitBreaker(makeCfg(100, 300_000));
      const staleAsOf = new Date(Date.now() - 400_000); // 400s > 300s
      const now = new Date();
      expect(() => breaker.checkFeedStaleness(staleAsOf, now)).toThrow(FeedStaleError);
    });
  });

  describe('maxNotional', () => {
    it('returns correct 3σ liquidation buffer', () => {
      // margin = 100 USDC (100_000_000 units), ilsSigmaBps = 94
      // maxNotional = 100_000_000 × 10_000 / (3 × 94)
      //             = 1_000_000_000_000 / 282
      //             = 3_546_099_290 (≈3,546 USDC — ~35× leverage at 3σ ILS move)
      const breaker = new HedgeCircuitBreaker(makeCfg(100, 300_000, 94));
      const margin = 100_000_000n; // 100 USDC
      const result = breaker.maxNotional(margin);
      // Use Number() for Jest comparison — BigInt JSON-serialisation breaks Jest messaging.
      expect(Number(result)).toBe(3_546_099_290);
    });

    it('returns marginUnits unchanged when ilsSigmaBps is 0 (degenerate guard)', () => {
      const breaker = new HedgeCircuitBreaker(makeCfg(100, 300_000, 0));
      expect(Number(breaker.maxNotional(50_000_000n))).toBe(50_000_000);
    });
  });
});
