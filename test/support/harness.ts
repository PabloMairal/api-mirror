import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { type Mirror, type SourceConfig, createMirror } from '../../src/index.ts';
import { FakeApi, type FakeApiOptions } from './fake-api.ts';
import { itemsSource } from './items-source.ts';

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';
if (!TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is not set (see .env.example)');

export interface Harness {
  api: FakeApi;
  mirror: Mirror;
  pool: pg.Pool;
  schema: string;
  table: string;
  source: SourceConfig;
  /** Builds a second Mirror over the same schema and source (another "process"). */
  another(overrides?: Partial<SourceConfig>): Mirror;
  rows(): Promise<Array<{ id: number; title: string; updated_at: string }>>;
  cursor(): Promise<string | null>;
  runs(): Promise<Array<{ kind: string; status: string; rows_inserted: number; rows_updated: number; error: string | null }>>;
  close(): Promise<void>;
}

export async function harness(
  options: FakeApiOptions & { source?: Partial<SourceConfig> } = {},
): Promise<Harness> {
  const pageSize = options.pageSize ?? 3;
  const api = await new FakeApi({ ...options, pageSize }).start();
  const schema = `t_${randomBytes(5).toString('hex')}`;
  const table = `${schema}.items`;
  const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 6 });
  const source: SourceConfig = { ...itemsSource(api.url, table, options.pagination, pageSize), ...options.source };
  const mirrors: Mirror[] = [];
  const make = (overrides: Partial<SourceConfig> = {}) => {
    const mirror = createMirror({ pool, schema, sources: [{ ...source, ...overrides }] });
    mirrors.push(mirror);
    return mirror;
  };
  const mirror = make();

  return {
    api, mirror, pool, schema, table, source,
    another: make,
    async rows() {
      const { rows } = await pool.query<{ id: string; title: string; updated_at: Date }>(
        `select id, title, updated_at from ${table} order by id`,
      );
      return rows.map((row) => ({ id: Number(row.id), title: row.title, updated_at: row.updated_at.toISOString() }));
    },
    async cursor() {
      const { rows } = await pool.query<{ cursor: Date | null }>(`select cursor from ${schema}.sources where name = 'items'`);
      return rows[0]?.cursor?.toISOString() ?? null;
    },
    async runs() {
      const { rows } = await pool.query(
        `select kind, status, rows_inserted, rows_updated, error from ${schema}.runs order by id`,
      );
      return rows;
    },
    async close() {
      await api.stop();
      await Promise.all(mirrors.map((m) => m.close()));
      await pool.query(`drop schema if exists ${schema} cascade`);
      await pool.end();
    },
  };
}
