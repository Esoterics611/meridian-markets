import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';

const PG_SERIALIZATION_FAILURE = '40001';
const SLOW_TX_MS = 500;

// Mirrors Lira-Bridge's DbService — runs fn inside a SERIALIZABLE transaction,
// retries ONCE on PostgreSQL serialization_failure (SQLSTATE 40001) before
// propagating. Single retry is intentional: any longer loop hides contention
// rather than fixing it.
@Injectable()
export class DbService {
  private readonly logger = new Logger(DbService.name);

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async runInSerializableTransaction<T>(
    fn: (em: EntityManager) => Promise<T>,
  ): Promise<T> {
    const startedAt = Date.now();
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const result = await this.dataSource.transaction('SERIALIZABLE', fn);
        const durationMs = Date.now() - startedAt;
        if (durationMs > SLOW_TX_MS) {
          this.logger.warn(`slow SERIALIZABLE tx: ${durationMs}ms`);
        }
        return result;
      } catch (err: unknown) {
        const code =
          (err as { code?: string })?.code ??
          (err as { driverError?: { code?: string } })?.driverError?.code;
        if (code === PG_SERIALIZATION_FAILURE && attempt === 0) {
          this.logger.warn('SERIALIZABLE serialization_failure — retrying once');
          continue;
        }
        if (code === PG_SERIALIZATION_FAILURE) {
          this.logger.error('SERIALIZABLE serialization_failure exhausted');
        }
        throw err;
      }
    }
    throw new Error('unexpected runInSerializableTransaction exit');
  }
}
