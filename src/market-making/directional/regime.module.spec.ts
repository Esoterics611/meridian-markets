import { Test } from '@nestjs/testing';
import { ConfigModule } from '@config/config.module';
import { RegimeModule, RegimeBootstrap } from './regime.module';
import { RegimeController } from './regime.controller';

// Boot test for the P13 wiring: prove RegimeModule's DI resolves so it can never silently crash
// the whole Nest app at startup (the module is imported by AppModule). REGIME_DESK is unset in the
// test env ⇒ the inert default: trader null, controller returns { enabled:false }, bootstrap no-ops.

describe('RegimeModule boot (P13 — inert default)', () => {
  it('compiles + initialises with REGIME_DESK off (no boot crash) and serves the inert controller', async () => {
    const prev = process.env.REGIME_DESK;
    delete process.env.REGIME_DESK; // force the inert default
    const moduleRef = await Test.createTestingModule({ imports: [ConfigModule, RegimeModule] }).compile();
    await moduleRef.init(); // fires RegimeBootstrap.onModuleInit — must not throw when trader is null

    const controller = moduleRef.get(RegimeController);
    expect(controller.snapshot()).toMatchObject({ enabled: false });
    expect(controller.flatten({ symbol: 'ETH' })).toMatchObject({ enabled: false });
    expect(controller.halt()).toMatchObject({ enabled: false });

    // the bootstrap resolved (it owns the lifecycle); the trader provider is null when off.
    expect(moduleRef.get(RegimeBootstrap)).toBeInstanceOf(RegimeBootstrap);
    expect(moduleRef.get(RegimeBootstrap).driving).toBe(false);

    await moduleRef.close(); // fires onApplicationShutdown — must not throw with no driver
    if (prev !== undefined) process.env.REGIME_DESK = prev;
  });
});

// The two-flag split (the non-interference fix): REGIME_DESK=true SERVES the cockpit, but the
// in-process trading driver stays OFF unless REGIME_DESK_DRIVE=true — so the UI backend never
// spins up a second regime desk that would compete with scripts/regime-book-live.ts. Tested by
// constructing the bootstrap directly (deterministic, offline — never news up the network driver).
describe('RegimeBootstrap — serve-vs-drive split (non-interference)', () => {
  const stubConfig = (regimeDeskDrive: boolean) =>
    ({ get: () => ({ regimeDeskDrive }) }) as unknown as ConstructorParameters<typeof RegimeBootstrap>[0];
  const stubTrader = { stop: () => undefined } as unknown as ConstructorParameters<typeof RegimeBootstrap>[1];

  it('with a trader present but REGIME_DESK_DRIVE off ⇒ serves only, NO driver started', () => {
    const boot = new RegimeBootstrap(stubConfig(false), stubTrader);
    boot.onModuleInit(); // must not touch the network — drive is off
    expect(boot.driving).toBe(false);
    boot.onApplicationShutdown(); // no driver ⇒ must not throw
  });

  it('with no trader (REGIME_DESK off) ⇒ inert, driving stays false', () => {
    const boot = new RegimeBootstrap(stubConfig(true), null);
    boot.onModuleInit();
    expect(boot.driving).toBe(false);
  });
});
