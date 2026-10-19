import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { assertIdentifier } from './config.ts';

/** Advisory lock class ids ("mirr" and "migr" as int4), so our keys never collide with an app's own locks. */
export const LOCK_RUN = 0x6d697272;
export const LOCK_MIGRATE = 0x6d696772;

export function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

export function quoteTable(table: string): string {
  return table.split('.').map(quoteIdent).join('.');
}

/** A client that counts its queries and the time spent in them, so every run can report both. */
export class CountingClient {
  queries = 0;
  ms = 0;
  readonly client: PoolClient;

  constructor(client: PoolClient) {
    this.client = client;
  }

  async query<R extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]): Promise<R[]> {
    const started = performance.now();
    try {
      const result = await this.client.query<R>(text, params);
      return result.rows;
    } finally {
      this.queries += 1;
      this.ms += performance.now() - started;
    }
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    await this.query('begin');
    try {
      const value = await fn();
      await this.query('commit');
      return value;
    } catch (error) {
      await this.query('rollback').catch(() => {});
      throw error;
    }
  }
}

/** Forward-only migrations for the library's own tables. Never edit one that shipped; append. */
const MIGRATIONS: Array<(s: string) => string> = [
  (s) => `
    create table ${s}.sources (
      name text primary key,
      cursor timestamptz,
      backfill_started_at timestamptz,
      backfill_next_url text,
      backfill_completed_at timestamptz,
      updated_at timestamptz not null default now()
    );

    create table ${s}.runs (
      id bigint generated always as identity primary key,
      source text not null,
      kind text not null check (kind in ('backfill', 'sync')),
      status text not null check (status in ('running', 'ok', 'error', 'skipped', 'abandoned')),
      started_at timestamptz not null default now(),
      finished_at timestamptz,
      pages integer not null default 0,
      rows_read integer not null default 0,
      rows_inserted integer not null default 0,
      rows_updated integer not null default 0,
      restarts integer not null default 0,
      http_requests integer not null default 0,
      db_queries integer not null default 0,
      cursor_from timestamptz,
      cursor_to timestamptz,
      error text
    );

    create index runs_source_started_idx on ${s}.runs (source, started_at desc);
    create index runs_source_last_ok_idx on ${s}.runs (source, finished_at desc) where status = 'ok';
    create index runs_running_idx on ${s}.runs (source) where status = 'running';
  `,
];

export async function migrate(pool: Pool, schema: string): Promise<number> {
  assertIdentifier(schema, 'schema');
  const s = quoteIdent(schema);
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('select pg_advisory_xact_lock($1, hashtext($2))', [LOCK_MIGRATE, schema]);
    await client.query(`create schema if not exists ${s}`);
    await client.query(`
      create table if not exists ${s}.schema_migrations (
        version integer primary key,
        applied_at timestamptz not null default now()
      )`);
    const { rows } = await client.query<{ version: number }>(
      `select coalesce(max(version), 0)::int as version from ${s}.schema_migrations`,
    );
    const current = rows[0]?.version ?? 0;
    for (let version = current + 1; version <= MIGRATIONS.length; version++) {
      await client.query(MIGRATIONS[version - 1]!(s));
      await client.query(`insert into ${s}.schema_migrations (version) values ($1)`, [version]);
    }
    await client.query('commit');
    return MIGRATIONS.length - current;
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
