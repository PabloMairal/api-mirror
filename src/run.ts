import type { Pool } from 'pg';
import type { ApiRecord, ResolvedSource } from './config.ts';
import { CountingClient, LOCK_RUN, quoteIdent } from './db.ts';
import { fetchPage, firstPageUrl, type HttpStats } from './http.ts';
import { dedupe, ensureTargetTable, mapRecord, type MappedRow, upsertRows } from './target.ts';

export type RunKind = 'backfill' | 'sync';

export interface PageInfo {
  source: string;
  kind: RunKind;
  page: number;
  url: string;
  rows: number;
}

export interface RunHooks {
  /** Runs inside the page transaction, after the upsert and before the cursor moves. Throwing rolls the page back. */
  beforeCommit?: (page: PageInfo) => void | Promise<void>;
  /** Runs after the page transaction committed. */
  afterCommit?: (page: PageInfo) => void | Promise<void>;
}

export interface RunOptions {
  /** Wait for a concurrent run of the same source to finish instead of skipping. */
  wait?: boolean;
  waitTimeoutMs?: number;
  /** Backfill only: start over even if a previous backfill completed or is half done. */
  restart?: boolean;
  hooks?: RunHooks;
}

export interface RunResult {
  runId: number;
  source: string;
  kind: RunKind;
  status: 'ok' | 'skipped' | 'error';
  message?: string;
  pages: number;
  rowsRead: number;
  rowsInserted: number;
  rowsUpdated: number;
  restarts: number;
  httpRequests: number;
  httpMs: number;
  dbQueries: number;
  dbMs: number;
  ms: number;
  cursorFrom: Date | null;
  cursorTo: Date | null;
}

export class MirrorRunError extends Error {
  override name = 'MirrorRunError';
  readonly result: RunResult;
  constructor(result: RunResult, cause: unknown) {
    super(`${result.kind} of "${result.source}" failed: ${result.message}`, { cause });
    this.result = result;
  }
}

/** Thrown when a page breaks an assumption the incremental algorithm depends on. */
export class SourceContractError extends Error {
  override name = 'SourceContractError';
}

interface Context {
  db: CountingClient;
  http: HttpStats;
  source: ResolvedSource;
  schema: string;
  result: RunResult;
  options: RunOptions;
}

async function acquireLock(db: CountingClient, schema: string, source: string, options: RunOptions): Promise<boolean> {
  const key = `${schema}.${source}`;
  if (!options.wait) {
    const [row] = await db.query<{ locked: boolean }>('select pg_try_advisory_lock($1, hashtext($2)) as locked', [LOCK_RUN, key]);
    return row?.locked === true;
  }
  await db.query(`select set_config('lock_timeout', $1, false)`, [`${options.waitTimeoutMs ?? 600_000}ms`]);
  try {
    await db.query('select pg_advisory_lock($1, hashtext($2))', [LOCK_RUN, key]);
    return true;
  } catch (error) {
    if ((error as { code?: string }).code === '55P03') return false; // lock_not_available
    throw error;
  } finally {
    await db.query(`select set_config('lock_timeout', '0', false)`);
  }
}

export async function execute(
  pool: Pool,
  schema: string,
  source: ResolvedSource,
  kind: RunKind,
  options: RunOptions,
  prepare: (db: CountingClient) => Promise<void>,
): Promise<RunResult> {
  const s = quoteIdent(schema);
  const started = performance.now();
  const client = await pool.connect();
  const db = new CountingClient(client);
  const http: HttpStats = { requests: 0, ms: 0 };
  const result: RunResult = {
    runId: 0, source: source.name, kind, status: 'ok', pages: 0, rowsRead: 0, rowsInserted: 0, rowsUpdated: 0,
    restarts: 0, httpRequests: 0, httpMs: 0, dbQueries: 0, dbMs: 0, ms: 0, cursorFrom: null, cursorTo: null,
  };
  const finish = () => {
    result.httpRequests = http.requests;
    result.httpMs = Math.round(http.ms);
    result.dbQueries = db.queries;
    result.dbMs = Math.round(db.ms);
    result.ms = Math.round(performance.now() - started);
    return result;
  };

  let locked = false;
  let broken: Error | undefined;
  try {
    locked = await acquireLock(db, schema, source.name, options);
    if (!locked) {
      const [run] = await db.query<{ id: string }>(
        `insert into ${s}.runs (source, kind, status, finished_at, error)
         values ($1, $2, 'skipped', now(), 'another run of this source holds the lock') returning id`,
        [source.name, kind],
      );
      result.runId = Number(run!.id);
      result.status = 'skipped';
      result.message = 'another run of this source holds the lock';
      return finish();
    }

    // We hold the lock, so any run still marked as running belongs to a process that died.
    await db.query(
      `update ${s}.runs set status = 'abandoned', finished_at = now(), error = 'process ended without closing the run'
       where source = $1 and status = 'running'`,
      [source.name],
    );
    const [run] = await db.query<{ id: string }>(
      `insert into ${s}.runs (source, kind, status) values ($1, $2, 'running') returning id`,
      [source.name, kind],
    );
    result.runId = Number(run!.id);

    let failure: unknown;
    try {
      await prepare(db);
      await (kind === 'sync' ? runSync : runBackfill)({ db, http, source, schema, result, options });
    } catch (error) {
      failure = error;
      result.status = 'error';
      result.message = error instanceof Error ? error.message : String(error);
    }

    finish();
    await db.query(
      `update ${s}.runs set status = $2, finished_at = now(), pages = $3, rows_read = $4, rows_inserted = $5,
         rows_updated = $6, restarts = $7, http_requests = $8, db_queries = $9, cursor_from = $10, cursor_to = $11,
         error = $12
       where id = $1`,
      [
        result.runId, result.status, result.pages, result.rowsRead, result.rowsInserted, result.rowsUpdated,
        result.restarts, result.httpRequests, result.dbQueries + 1, result.cursorFrom, result.cursorTo,
        result.message ?? null,
      ],
    );
    if (failure !== undefined) throw new MirrorRunError(finish(), failure);
    return finish();
  } catch (error) {
    if (!(error instanceof MirrorRunError)) broken = error as Error;
    throw error;
  } finally {
    if (locked && !broken) {
      await db.query('select pg_advisory_unlock($1, hashtext($2))', [LOCK_RUN, `${schema}.${source.name}`]).catch(
        (error: Error) => { broken = error; },
      );
    }
    // A broken connection may still hold the session lock; destroying it releases the lock server side.
    client.release(broken);
  }
}

function mapPage(ctx: Context, records: ApiRecord[]): { all: MappedRow[]; stored: MappedRow[] } {
  const all: MappedRow[] = [];
  const stored: MappedRow[] = [];
  for (const record of records) {
    const row = mapRecord(ctx.source, record);
    all.push(row);
    if (!ctx.source.filter || ctx.source.filter(record)) stored.push(row);
  }
  return { all, stored: dedupe(stored) };
}

/**
 * Reads everything modified since `cursor - overlap`, page by page. Each page is written and the cursor
 * advanced in the same transaction, so a crash at any point loses at most the page in flight, which the
 * next run reads again.
 *
 * Offset and page-number pagination are not stable while the source changes: when a row we already read is
 * modified, it moves to the end of the result set and every row behind it shifts one position back, so the
 * row at the page boundary is never served. The moved row shows up again later in the same pass with a newer
 * timestamp, which is how we detect it. Any skipped row sorts after the moved row's old position, so the pass
 * restarts from that old timestamp.
 */
async function runSync(ctx: Context): Promise<void> {
  const { db, source, result, options } = ctx;
  const s = quoteIdent(ctx.schema);
  const [state] = await db.query<{ cursor: Date | null; backfill_completed_at: Date | null }>(
    `select cursor, backfill_completed_at from ${s}.sources where name = $1`,
    [source.name],
  );
  if (!state?.backfill_completed_at || !state.cursor) {
    throw new Error(`source "${source.name}" has no completed backfill; run \`mirror backfill ${source.name}\` first`);
  }
  let cursor = state.cursor;
  result.cursorFrom = cursor;

  for (;;) {
    const since = new Date(cursor.getTime() - source.overlapSeconds * 1000);
    const seen = new Map<string, number>();
    let url: string | null = firstPageUrl(source, 'sync', since);
    let lastModified = -Infinity;
    let restartFrom: number | null = null;

    while (url) {
      const page = await fetchPage(source, url, ctx.http);
      result.pages += 1;
      result.rowsRead += page.records.length;
      const { all, stored } = mapPage(ctx, page.records);

      for (const row of all) {
        const modified = row.modifiedAt.getTime();
        if (modified < lastModified) {
          throw new SourceContractError(
            `source "${source.name}" must return records ordered by ${source.modifiedAt} ascending in sync mode`,
          );
        }
        lastModified = modified;
        const previous = seen.get(row.key);
        if (previous === undefined) seen.set(row.key, modified);
        else if (previous !== modified) restartFrom = Math.min(restartFrom ?? Infinity, previous);
      }

      const pageMax = all.length > 0 ? new Date(lastModified) : null;
      const info: PageInfo = { source: source.name, kind: 'sync', page: result.pages, url, rows: page.records.length };
      if (all.length > 0) {
        const written = await db.transaction(async () => {
          const written = await upsertRows(db, source, stored);
          await options.hooks?.beforeCommit?.(info);
          if (restartFrom !== null) {
            await db.query(`update ${s}.sources set cursor = $2, updated_at = now() where name = $1`, [
              source.name, new Date(restartFrom),
            ]);
          } else if (pageMax && pageMax > cursor) {
            await db.query(`update ${s}.sources set cursor = $2, updated_at = now() where name = $1`, [
              source.name, pageMax,
            ]);
          }
          return written;
        });
        result.rowsInserted += written.inserted;
        result.rowsUpdated += written.updated;
      }
      await options.hooks?.afterCommit?.(info);

      if (restartFrom !== null) {
        cursor = new Date(restartFrom);
        result.restarts += 1;
        if (result.restarts > source.maxRestarts) {
          throw new Error(
            `source "${source.name}" kept changing under pagination (${result.restarts} restarts); ` +
              'progress is saved, the next run continues from the cursor',
          );
        }
        break;
      }
      if (pageMax && pageMax > cursor) cursor = pageMax;
      url = page.nextUrl;
    }

    if (restartFrom === null) break;
  }
  result.cursorTo = cursor;
}

/**
 * Reads the whole collection in the backfill order (ideally an immutable one, like creation time) and saves the
 * next page URL with every page, so an interrupted backfill resumes where it stopped. When it completes, the sync
 * cursor starts at the moment the backfill began: anything modified while it ran is picked up by the first sync.
 */
async function runBackfill(ctx: Context): Promise<void> {
  const { db, source, result, options } = ctx;
  const s = quoteIdent(ctx.schema);
  await db.query(`insert into ${s}.sources (name) values ($1) on conflict (name) do nothing`, [source.name]);
  if (options.restart) {
    await db.query(
      `update ${s}.sources set backfill_started_at = null, backfill_next_url = null, backfill_completed_at = null,
         cursor = null, updated_at = now()
       where name = $1`,
      [source.name],
    );
  }
  const [state] = await db.query<{
    backfill_started_at: Date | null; backfill_next_url: string | null; backfill_completed_at: Date | null;
  }>(`select backfill_started_at, backfill_next_url, backfill_completed_at from ${s}.sources where name = $1`, [
    source.name,
  ]);
  if (state?.backfill_completed_at) {
    result.message = `backfill already completed at ${state.backfill_completed_at.toISOString()}; use --restart to redo it`;
    return;
  }

  let startedAt = state?.backfill_started_at ?? null;
  let url: string | null = state?.backfill_next_url ?? firstPageUrl(source, 'backfill', null);
  if (state?.backfill_next_url) result.message = 'resumed an interrupted backfill';
  const seen = new Map<string, number>();

  while (url) {
    const requestedAt = new Date();
    const page = await fetchPage(source, url, ctx.http);
    // Take the earlier of our clock and the server's, so a client clock running ahead cannot skip changes.
    startedAt ??= page.serverDate && page.serverDate < requestedAt ? page.serverDate : requestedAt;
    result.pages += 1;
    result.rowsRead += page.records.length;
    const { all, stored } = mapPage(ctx, page.records);

    for (const row of all) {
      const modified = row.modifiedAt.getTime();
      const previous = seen.get(row.key);
      if (previous === undefined) seen.set(row.key, modified);
      else if (previous !== modified) {
        throw new SourceContractError(
          `source "${source.name}": record ${row.key} moved while backfilling, so rows behind it may have been ` +
            'skipped. Order the backfill by a field that never changes (creation time or id) via backfillParams.',
        );
      }
    }

    const info: PageInfo = { source: source.name, kind: 'backfill', page: result.pages, url, rows: page.records.length };
    const written = await db.transaction(async () => {
      const written = await upsertRows(db, source, stored);
      await options.hooks?.beforeCommit?.(info);
      await db.query(
        `update ${s}.sources set
           backfill_started_at = coalesce(backfill_started_at, $2),
           backfill_next_url = $3,
           backfill_completed_at = case when $3::text is null then now() end,
           cursor = case when $3::text is null then coalesce(backfill_started_at, $2) end,
           updated_at = now()
         where name = $1`,
        [source.name, startedAt, page.nextUrl],
      );
      return written;
    });
    result.rowsInserted += written.inserted;
    result.rowsUpdated += written.updated;
    await options.hooks?.afterCommit?.(info);
    url = page.nextUrl;
  }
  result.cursorTo = startedAt;
}
