export type ColumnType =
  | 'text'
  | 'integer'
  | 'bigint'
  | 'numeric'
  | 'boolean'
  | 'timestamptz'
  | 'date'
  | 'jsonb'
  | 'text[]';

export type ApiRecord = Record<string, unknown>;

export interface ColumnSpec {
  type: ColumnType;
  /** Dotted path into the record (`user.login`) or a function. Defaults to the column name. */
  from?: string | ((record: ApiRecord) => unknown);
}

export type Pagination =
  /** Follows the `rel="next"` URL of the `Link` response header (GitHub style). */
  | { type: 'link' }
  /** `?offset=N&limit=M`. The last page is the first one with fewer than `pageSize` records. */
  | { type: 'offset'; pageSize: number; offsetParam?: string; limitParam?: string }
  /** An opaque token read from the body and sent back as a query param. */
  | { type: 'cursor'; param: string; next: (body: unknown) => string | null | undefined };

export interface SourceConfig {
  /** Identifier used by the CLI, the runs table and the lock. */
  name: string;
  /** Target table, optionally schema-qualified. Created if missing. */
  table: string;
  url: string;
  headers?: Record<string, string> | (() => Record<string, string>);
  /** Query params for every request, plus per-mode overrides. */
  params?: Record<string, string>;
  backfillParams?: Record<string, string>;
  syncParams?: Record<string, string>;
  pagination: Pagination;
  /** Where the records live in the response body. Defaults to the body itself when it is an array. */
  records?: (body: unknown) => unknown[];
  /** Query param that receives the lower bound in incremental syncs. */
  sinceParam: string;
  formatSince?: (since: Date) => string;
  /** Column (of `columns`) holding the record's last modification time. */
  modifiedAt: string;
  /** Column (of `columns`) that identifies a record. */
  primaryKey: string;
  columns: Record<string, ColumnSpec>;
  /** A source is `stale` when its last successful run finished longer ago than this. */
  staleAfterSeconds: number;
  /** How far behind the cursor each sync starts reading. Covers equal timestamps and clock skew. */
  overlapSeconds?: number;
  /** A sync gives up after restarting this many times because rows shifted under offset pagination. */
  maxRestarts?: number;
  /** Records for which this returns false are read but not stored. */
  filter?: (record: ApiRecord) => boolean;
  retries?: number;
  timeoutMs?: number;
}

export interface MirrorConfig {
  /** Postgres schema for the library's own tables (cursors and runs). */
  schema?: string;
  sources: SourceConfig[];
}

export interface ResolvedSource extends SourceConfig {
  overlapSeconds: number;
  maxRestarts: number;
  retries: number;
  timeoutMs: number;
}

export function defineSource(source: SourceConfig): SourceConfig {
  return source;
}

export function defineConfig(config: MirrorConfig): MirrorConfig {
  return config;
}

const IDENT = /^[a-z_][a-z0-9_]{0,62}$/;
const TYPES = new Set<ColumnType>([
  'text', 'integer', 'bigint', 'numeric', 'boolean', 'timestamptz', 'date', 'jsonb', 'text[]',
]);

export class ConfigError extends Error {
  override name = 'ConfigError';
}

export function assertIdentifier(value: string, what: string): void {
  if (!IDENT.test(value)) {
    throw new ConfigError(`${what} "${value}" must match ${IDENT} (lowercase, digits, underscore)`);
  }
}

export function resolveSource(source: SourceConfig): ResolvedSource {
  const where = `source "${source.name}"`;
  assertIdentifier(source.name, `${where}: name`);
  const tableParts = source.table.split('.');
  if (tableParts.length > 2) throw new ConfigError(`${where}: table "${source.table}" has too many dots`);
  for (const part of tableParts) assertIdentifier(part, `${where}: table`);

  const columns = Object.entries(source.columns);
  if (columns.length === 0) throw new ConfigError(`${where}: columns is empty`);
  for (const [name, spec] of columns) {
    assertIdentifier(name, `${where}: column`);
    if (name.startsWith('_mirror')) throw new ConfigError(`${where}: column "${name}" uses a reserved prefix`);
    if (!TYPES.has(spec.type)) throw new ConfigError(`${where}: column "${name}" has unknown type "${spec.type}"`);
  }
  if (!source.columns[source.primaryKey]) {
    throw new ConfigError(`${where}: primaryKey "${source.primaryKey}" is not a column`);
  }
  const modified = source.columns[source.modifiedAt];
  if (!modified) throw new ConfigError(`${where}: modifiedAt "${source.modifiedAt}" is not a column`);
  if (modified.type !== 'timestamptz') {
    throw new ConfigError(`${where}: modifiedAt column "${source.modifiedAt}" must be timestamptz`);
  }
  if (!(source.staleAfterSeconds > 0)) throw new ConfigError(`${where}: staleAfterSeconds must be > 0`);
  if (source.pagination.type === 'offset' && !(source.pagination.pageSize > 0)) {
    throw new ConfigError(`${where}: pagination.pageSize must be > 0`);
  }

  return {
    ...source,
    overlapSeconds: source.overlapSeconds ?? 60,
    maxRestarts: source.maxRestarts ?? 3,
    retries: source.retries ?? 2,
    timeoutMs: source.timeoutMs ?? 30_000,
  };
}
