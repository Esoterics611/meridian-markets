import { LiveController } from './live.controller';
import { LivePaperTrader } from './live-paper-trader';
import { LivePortfolioTrader } from './live-portfolio-trader';
import { StatArbRepository } from '../stat-arb/persistence/stat-arb.repository';
import { ConfigService } from '@nestjs/config';
import { DeskEventLog } from '../market-making/events/desk-event-log';
import { statArbEntryEvent, statArbExitEvent } from './live-desk-events';

const M = 1_000_000n;

// The events endpoint only touches the injected DeskEventLog, so the other
// constructor deps are unused stubs here.
function controllerWith(log: DeskEventLog | null): LiveController {
  return new LiveController(
    {} as unknown as LivePaperTrader,
    {} as unknown as LivePortfolioTrader,
    {} as unknown as StatArbRepository,
    {} as unknown as ConfigService,
    log,
  );
}

describe('LiveController events endpoint', () => {
  it('returns the buffered events + a cursor, and respects ?since=', () => {
    const log = new DeskEventLog();
    log.emit(statArbEntryEvent({ ts: 1, pair: 'ETH/BTC', source: 'binance.spot', side: 'LONG', notionalUnits: 50n * M, entryZ: -2, feeUnits: 0n, symbolA: 'ETH', symbolB: 'BTC' }));
    log.emit(statArbExitEvent({ ts: 2, pair: 'ETH/BTC', source: 'binance.spot', side: 'LONG', notionalUnits: 50n * M, exitZ: 0, realisedDeltaUnits: M, feeUnits: 0n }));
    const ctrl = controllerWith(log);

    const all = ctrl.events();
    expect(all.events).toHaveLength(2);
    expect(all.cursor).toBe(2);
    expect(all.events.map((e) => e.action)).toEqual(['open', 'close']);

    // Long-poll from the first cursor → only the newer event.
    const tail = ctrl.events('1');
    expect(tail.events).toHaveLength(1);
    expect(tail.events[0].action).toBe('close');
  });

  it('degrades to an empty feed when no event log is wired', () => {
    const ctrl = controllerWith(null);
    expect(ctrl.events()).toEqual({ events: [], cursor: 0 });
  });
});
