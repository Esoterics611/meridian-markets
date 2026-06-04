import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import type { Response } from 'express';
import { appConfigFactory } from '@config/app-config.factory';
import { TelemetryModule } from './telemetry.module';
import { MetricsController } from './metrics.controller';
import { HealthController } from './health.controller';

// Compiles the real DI graph (TelemetryModule → MarketMakingModule, global
// TELEMETRY flowing back) so a wiring break surfaces here, not at boot — important
// because `npm run start:dev` can't run in this sandbox. No network, no DB:
// construction is lazy and the read paths don't touch Binance.
function fakeRes(): Response {
  return { statusCode: 0 } as unknown as Response;
}

describe('TelemetryModule — offline DI compile', () => {
  describe('telemetry disabled (default)', () => {
    let metrics: MetricsController;
    let health: HealthController;
    beforeAll(async () => {
      delete process.env['TELEMETRY_ENABLED'];
      const mod = await Test.createTestingModule({
        imports: [ConfigModule.forRoot({ isGlobal: true, load: [appConfigFactory] }), TelemetryModule],
      }).compile();
      metrics = mod.get(MetricsController);
      health = mod.get(HealthController);
    });

    it('GET /metrics returns the disabled note', () => {
      expect(metrics.metrics()).toContain('telemetry disabled');
    });

    it('GET /health is live', () => {
      expect(health.liveness().status).toBe('ok');
    });

    it('GET /health/ready is ready (idle desk, persistence off) → 200', async () => {
      const res = fakeRes();
      const body = await health.ready(res);
      expect(body.ready).toBe(true);
      expect(res.statusCode).toBe(200);
    });
  });

  describe('telemetry enabled', () => {
    let metrics: MetricsController;
    beforeAll(async () => {
      process.env['TELEMETRY_ENABLED'] = 'true';
      const mod = await Test.createTestingModule({
        imports: [ConfigModule.forRoot({ isGlobal: true, load: [appConfigFactory] }), TelemetryModule],
      }).compile();
      metrics = mod.get(MetricsController);
    });
    afterAll(() => {
      delete process.env['TELEMETRY_ENABLED'];
    });

    it('GET /metrics renders the catalog (HELP/TYPE) in Prometheus format', () => {
      const out = metrics.metrics();
      expect(out).toContain('# TYPE meridian_tick_total counter');
      expect(out).toContain('# TYPE meridian_desk_equity_units gauge');
      expect(out).toContain('# TYPE meridian_tick_duration_seconds histogram');
      // collector ran on scrape: process uptime gauge has a sample
      expect(out).toMatch(/meridian_process_uptime_seconds \d/);
    });
  });
});
