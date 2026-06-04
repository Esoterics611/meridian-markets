import { Injectable } from '@nestjs/common';
import { IStatArbStateStore, StatArbBookRecord } from './stat-arb-state-store.interface';

// NullStatArbStateStore — the default, no-op persistence backend. Used when
// STAT_ARB_PERSIST is off and in every test / no-DB run, so the live stat-arb
// path behaves exactly as it did before restart-safe books existed: nothing is
// written, boot finds no books.

@Injectable()
export class NullStatArbStateStore implements IStatArbStateStore {
  readonly enabled = false;
  async save(_record: StatArbBookRecord): Promise<void> {
    /* no-op */
  }
  async loadOpen(): Promise<StatArbBookRecord[]> {
    return [];
  }
  async close(_bookKey: string): Promise<void> {
    /* no-op */
  }
}
