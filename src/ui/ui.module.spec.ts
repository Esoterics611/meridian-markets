import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { appConfigFactory } from '@config/app-config.factory';
import { UiModule } from './ui.module';
import { ExecController } from './exec.controller';
import { UiAssetController } from './ui-asset.controller';

// Compiles the real DI graph (UiModule → MarketMakingModule, MmPortfolioTrader
// injected into ExecController) so a wiring break surfaces here, not at boot —
// `npm run start:dev` can't run in this sandbox. Construction is lazy + offline:
// the read path renders MmPortfolioTrader.snapshot() and touches no Binance/DB.
describe('UiModule — offline DI compile', () => {
  let exec: ExecController;
  let assets: UiAssetController;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, load: [appConfigFactory] }), UiModule],
    }).compile();
    exec = mod.get(ExecController);
    assets = mod.get(UiAssetController);
  });

  it('resolves ExecController with the live MM trader injected', () => {
    expect(exec).toBeInstanceOf(ExecController);
    // an idle desk (no books) still renders a coherent page from real state
    const html = exec.page();
    expect(html).toContain('id="exec-live"');
    expect(html).toContain('Executive');
  });

  it('serves the shared UI assets that the page references', () => {
    expect(assets).toBeInstanceOf(UiAssetController);
    const sent: { type?: string; body?: string } = {};
    const res = {
      setHeader: (k: string, v: string) => {
        if (k === 'Content-Type') sent.type = v;
      },
      send: (b: string) => {
        sent.body = b;
      },
    } as any;
    assets.serve('ui.css', res);
    expect(sent.type).toContain('text/css');
    expect(sent.body).toContain('.topbar'); // the real stylesheet, not a stub

    assets.serve('desk-feed.js', res);
    expect(sent.type).toContain('javascript');
    expect(sent.body).toContain('customElements.define');
  });

  it('rejects an unknown asset (no path traversal surface)', () => {
    const res = { setHeader: () => undefined, send: () => undefined } as any;
    expect(() => assets.serve('../../package.json', res)).toThrow();
  });
});
