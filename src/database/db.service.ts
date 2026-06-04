import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { ITelemetry, TELEMETRY } from '../telemetry/telemetry.interface';
import { NULL_TELEMETRY } from '../telemetry/null-telemetry';
import { M } from '../telemetry/metric-catalog';

const PG_SERIALIZATION_FAILURE = '40001';
const SLOW_TX_MS = 500;
const MAX_RETRIES = 7; // total attempts = MAX_RETRIES + 1
const BASE_BACKOFF_MS = 8;

// Mirrors Lira-Bridge's DbService — runs fn inside a SERIALIZABLE transaction,
// retries on PostgreSQL serialization_failure (SQLSTATE 40001) with
// exponential backoff and jitter. Under the high-contention concurrent-deposit
// test pattern (N parallel txns mutating the same position row), a single
// retry was insufficient — the same row would lose the race twice. Backoff
// converges quickly: 5 retries with base 8ms = up to ~250ms worst-case wait
// at the tail, well below any caller's tolerance.
@Injectable()
export class DbService {
  private readonly logger = new Logger(DbService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    // Optional observability seam: NullTelemetry by default ⇒ no behaviour change
    // and manual `new DbService(ds)` (the int-specs) work unchanged.
    @Optional() @Inject(TELEMETRY) private readonly telemetry: ITelemetry = NULL_TELEMETRY,
  ) {}

  /** Lightweight reachability probe for GET /health/ready. true iff SELECT 1 succeeds. */
  async ping(): Promise<boolean> {
    try {
      await this.dataSource.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  async runInSerializableTransaction<T>(
    fn: (em: EntityManager) => Promise<T>,
  ): Promise<T> {
    const startedAt = Date.now();
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const result = await this.dataSource.transaction('SERIALIZABLE', fn);
        const durationMs = Date.now() - startedAt;
        this.telemetry.histogram(M.dbDuration, durationMs / 1000, { op: 'serializable_tx' });
        if (durationMs > SLOW_TX_MS) {
          this.logger.warn(`slow SERIALIZABLE tx: ${durationMs}ms`);
        }
        return result;
      } catch (err: unknown) {
        const code =
          (err as { code?: string })?.code ??
          (err as { driverError?: { code?: string } })?.driverError?.code;
        if (code !== PG_SERIALIZATION_FAILURE) {
          this.telemetry.counter(M.dbErrors);
          throw err;
        }
        if (attempt >= MAX_RETRIES) {
          this.telemetry.counter(M.dbErrors);
          this.logger.error(
            `SERIALIZABLE serialization_failure exhausted after ${MAX_RETRIES + 1} attempts`,
          );
          throw err;
        }
        // Exponential backoff with full jitter, capped per attempt.
        const exp = BASE_BACKOFF_MS * Math.pow(2, attempt);
        const waitMs = Math.floor(Math.random() * exp);
        this.logger.warn(
          `SERIALIZABLE serialization_failure on attempt ${attempt + 1} — backing off ${waitMs}ms`,
        );
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
    }
    throw new Error('unexpected runInSerializableTransaction exit');
  }
}
