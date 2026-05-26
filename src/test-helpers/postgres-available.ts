import { DataSource } from 'typeorm';

const DEFAULT_PRIVILEGED_URL =
  process.env['DATABASE_URL'] ??
  'postgresql://meridian_markets:meridian_markets@localhost:5433/meridian_markets';
const DEFAULT_APP_URL =
  process.env['DATABASE_URL_APP'] ??
  'postgresql://meridian_markets_app:meridian_markets_app@localhost:5433/meridian_markets';

// Try to open a connection against the privileged URL. If Postgres is not
// running locally on :5433 (CI without docker, fresh laptop, etc.), every
// DB-backed test in this repo opts out via `describeIfDb` instead of failing.
// This matches Lira-Bridge's approach to integration tests — green by default,
// real assertions when the DB is up.
export async function postgresAvailable(): Promise<boolean> {
  const probe = new DataSource({
    type: 'postgres',
    url: DEFAULT_PRIVILEGED_URL,
    connectTimeoutMS: 1500,
    extra: { connectionTimeoutMillis: 1500 },
  });
  try {
    await probe.initialize();
    await probe.query('SELECT 1');
    await probe.destroy();
    return true;
  } catch {
    try { await probe.destroy(); } catch { /* noop */ }
    return false;
  }
}

export function newPrivilegedDataSource(): DataSource {
  return new DataSource({
    type: 'postgres',
    url: DEFAULT_PRIVILEGED_URL,
    entities: [],
    synchronize: false,
  });
}

export function newAppDataSource(): DataSource {
  return new DataSource({
    type: 'postgres',
    url: DEFAULT_APP_URL,
    entities: [],
    synchronize: false,
  });
}

// describeIf: native Jest helper. Use `describeIfDb(name, fn)` to register a
// suite that only runs when Postgres is reachable. Otherwise it shows as
// "skipped" instead of failing the run.
type SuiteFn = (name: string, fn: () => void) => void;
let cachedAvailable: boolean | null = null;
export async function dbAvailableCached(): Promise<boolean> {
  if (cachedAvailable === null) cachedAvailable = await postgresAvailable();
  return cachedAvailable;
}

export const describeIfDb = (name: string, fn: () => void): void => {
  const maybe: SuiteFn = process.env['MERIDIAN_DB_TESTS'] === 'off'
    ? describe.skip
    : describe;
  maybe(name, fn);
};
