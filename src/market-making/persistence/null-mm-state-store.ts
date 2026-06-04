import { Injectable } from '@nestjs/common';
import { IMmStateStore, MmBookRecord } from './mm-state-store.interface';

// NullMmStateStore — the default, no-op persistence backend. Used when MM_PERSIST
// is off and in every test / no-DB run, so the live MM path behaves exactly as it
// did before restart-safe books existed: nothing is written, boot finds no books.

@Injectable()
export class NullMmStateStore implements IMmStateStore {
  readonly enabled = false;
  async save(_record: MmBookRecord): Promise<void> {
    /* no-op */
  }
  async loadOpen(): Promise<MmBookRecord[]> {
    return [];
  }
  async close(_bookKey: string): Promise<void> {
    /* no-op */
  }
}
