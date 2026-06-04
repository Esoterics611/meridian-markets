import { Injectable } from '@nestjs/common';
import { IMmStateStore, MmBookRecord } from './mm-state-store.interface';
import { MmStateRepository } from './mm-state.repository';

// PostgresMmStateStore — the real persistence backend. A thin adapter over
// MmStateRepository so the trader depends only on IMmStateStore (the seam),
// never on the SQL layer. Selected by config (MM_PERSIST) in the module factory.

@Injectable()
export class PostgresMmStateStore implements IMmStateStore {
  readonly enabled = true;
  constructor(private readonly repo: MmStateRepository) {}

  save(record: MmBookRecord): Promise<void> {
    return this.repo.upsert(record);
  }
  loadOpen(): Promise<MmBookRecord[]> {
    return this.repo.loadOpen();
  }
  close(bookKey: string): Promise<void> {
    return this.repo.markClosed(bookKey);
  }
}
