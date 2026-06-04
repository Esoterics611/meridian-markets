import { Injectable } from '@nestjs/common';
import { IStatArbStateStore, StatArbBookRecord } from './stat-arb-state-store.interface';
import { StatArbStateRepository } from './stat-arb-state.repository';

// PostgresStatArbStateStore — the real persistence backend. A thin adapter over
// StatArbStateRepository so the trader depends only on IStatArbStateStore (the
// seam), never on the SQL layer. Selected by config (STAT_ARB_PERSIST) in the
// module factory.

@Injectable()
export class PostgresStatArbStateStore implements IStatArbStateStore {
  readonly enabled = true;
  constructor(private readonly repo: StatArbStateRepository) {}

  save(record: StatArbBookRecord): Promise<void> {
    return this.repo.upsert(record);
  }
  loadOpen(): Promise<StatArbBookRecord[]> {
    return this.repo.loadOpen();
  }
  close(bookKey: string): Promise<void> {
    return this.repo.markClosed(bookKey);
  }
}
