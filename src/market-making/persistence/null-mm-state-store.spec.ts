import { NullMmStateStore } from './null-mm-state-store';
import { MmBookRecord } from './mm-state-store.interface';

describe('NullMmStateStore', () => {
  const store = new NullMmStateStore();

  it('is disabled and a no-op (save/close resolve, loadOpen is empty)', async () => {
    expect(store.enabled).toBe(false);
    await expect(store.save({} as MmBookRecord)).resolves.toBeUndefined();
    await expect(store.close('BTC')).resolves.toBeUndefined();
    await expect(store.loadOpen()).resolves.toEqual([]);
  });
});
