import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { appConfigFactory } from '@config/app-config.factory';
import { MarketMakingModule } from './market-making.module';
import { MmController } from './mm.controller';

// Boots the real MarketMakingModule (DI wiring + ConfigService factory) and
// exercises exactly the read/launch endpoints the /demo "Market Making" tab
// calls. No network, no DB — construction is lazy and the read paths don't
// touch Binance. Catches a wiring break before the UI does.
describe('MarketMakingModule — the endpoints the /demo MM tab calls', () => {
  let controller: MmController;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, load: [appConfigFactory] }), MarketMakingModule],
    }).compile();
    controller = mod.get(MmController);
  });

  it('GET /strategies lists the three quoter families', () => {
    const ids = controller.strategies().strategies.map((s) => s.id);
    expect(ids).toEqual(expect.arrayContaining(['mm-symmetric', 'mm-avellaneda-stoikov', 'mm-glft']));
  });

  it('GET /markets includes the stablecoin-peg preset with a default symbol', () => {
    const peg = controller.markets().presets.find((p) => p.id === 'stablecoin-peg');
    expect(peg).toBeDefined();
    expect(peg!.symbols).toContain(peg!.defaultSymbol);
  });

  it('GET /markets exposes the DEX preset wired to the geckoterminal source', () => {
    const dex = controller.markets().presets.find((p) => p.id === 'dex-eth-bluechip');
    expect(dex).toBeDefined();
    expect(dex!.source).toBe('geckoterminal');
  });

  it('GET /snapshot is an empty desk before any launch', () => {
    const s = controller.snapshot();
    expect(s.bookCount).toBe(0);
    expect(s.books).toEqual([]);
  });

  it('POST /launch rejects a missing symbol (the UI guard)', async () => {
    const r = (await controller.launch({})) as { error?: string };
    expect(r.error).toMatch(/symbol/i);
  });

  it('POST /launch rejects an unknown strategyId', async () => {
    const r = (await controller.launch({ symbol: 'FDUSD', strategyId: 'nope' })) as { error?: string };
    expect(r.error).toMatch(/unknown/i);
  });
});
