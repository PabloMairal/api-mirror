import type { ApiRecord, ResolvedSource } from './config.ts';
import { type CountingClient, quoteIdent, quoteTable } from './db.ts';

export interface MappedRow {
  key: string;
  modifiedAt: Date;
  values: Record<string, unknown>;
}

function readPath(record: ApiRecord, path: string): unknown {
  let value: unknown = record;
  for (const part of path.split('.')) {
    if (value === null || typeof value !== 'object') return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

export function mapRecord(source: ResolvedSource, record: ApiRecord): MappedRow {
  const values: Record<string, unknown> = {};
  for (const [column, spec] of Object.entries(source.columns)) {
    const from = spec.from ?? column;
    const value = typeof from === 'function' ? from(record) : readPath(record, from);
    values[column] = value instanceof Date ? value.toISOString() : (value ?? null);
  }
  const key = values[source.primaryKey];
  if (key === null) throw new Error(`source "${source.name}": record without ${source.primaryKey}`);
  const modified = new Date(values[source.modifiedAt] as string);
  if (Number.isNaN(modified.getTime())) {
    throw new Error(`source "${source.name}": record ${String(key)} has an invalid ${source.modifiedAt}`);
  }
  return { key: String(key), modifiedAt: modified, values };
}

export async function ensureTargetTable(db: CountingClient, source: ResolvedSource): Promise<void> {
  const columns = Object.entries(source.columns).map(([name, spec]) => `${quoteIdent(name)} ${spec.type}`);
  const table = quoteTable(source.table);
  await db.query(`
    create table if not exists ${table} (
      ${columns.join(',\n      ')},
      _mirrored_at timestamptz not null default now(),
      primary key (${quoteIdent(source.primaryKey)})
    )`);
  const bare = source.table.split('.').at(-1)!;
  const index = `${bare}_${source.modifiedAt}_idx`.slice(0, 63);
  await db.query(`create index if not exists ${quoteIdent(index)} on ${table} (${quoteIdent(source.modifiedAt)})`);
}

export interface UpsertResult {
  inserted: number;
  updated: number;
}

/**
 * One statement per page. A row is only overwritten by a strictly newer version, so replaying a page
 * (after a crash, or because of the overlap window) writes nothing and leaves no dead tuples.
 */
export async function upsertRows(db: CountingClient, source: ResolvedSource, rows: MappedRow[]): Promise<UpsertResult> {
  if (rows.length === 0) return { inserted: 0, updated: 0 };
  const names = Object.keys(source.columns);
  const cols = names.map(quoteIdent).join(', ');
  const recordset = Object.entries(source.columns).map(([name, spec]) => `${quoteIdent(name)} ${spec.type}`).join(', ');
  const updates = names
    .filter((name) => name !== source.primaryKey)
    .map((name) => `${quoteIdent(name)} = excluded.${quoteIdent(name)}`);
  const modified = quoteIdent(source.modifiedAt);
  const [result] = await db.query<{ inserted: number; updated: number }>(
    `with written as (
       insert into ${quoteTable(source.table)} as current (${cols})
       select ${cols} from jsonb_to_recordset($1::jsonb) as incoming(${recordset})
       on conflict (${quoteIdent(source.primaryKey)}) do update
         set ${[...updates, '_mirrored_at = now()'].join(', ')}
         where current.${modified} < excluded.${modified}
       returning (xmax = 0) as inserted
     )
     select count(*) filter (where inserted)::int as inserted,
            count(*) filter (where not inserted)::int as updated
     from written`,
    [JSON.stringify(rows.map((row) => row.values))],
  );
  return result ?? { inserted: 0, updated: 0 };
}

/**
 * Keeps the newest version of each key. A page can repeat a key when rows shift under offset
 * pagination, and Postgres refuses to upsert the same key twice in one statement.
 */
export function dedupe(rows: MappedRow[]): MappedRow[] {
  const byKey = new Map<string, MappedRow>();
  for (const row of rows) {
    const seen = byKey.get(row.key);
    if (!seen || seen.modifiedAt < row.modifiedAt) byKey.set(row.key, row);
  }
  return [...byKey.values()];
}
