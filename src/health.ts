import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Pool } from 'pg';
import type { ResolvedSource } from './config.ts';
import { quoteIdent } from './db.ts';

export interface SourceHealth {
  source: string;
  status: 'ok' | 'stale';
  reason: string | null;
  staleAfterSeconds: number;
  lastOkAt: string | null;
  /** Seconds since the last successful run finished. */
  ageSeconds: number | null;
  cursor: string | null;
  backfillCompleted: boolean;
  lastRun: { status: string; startedAt: string; finishedAt: string | null; error: string | null } | null;
}

export interface Health {
  ok: boolean;
  checkedAt: string;
  sources: SourceHealth[];
}

interface Row {
  name: string;
  cursor: Date | null;
  backfill_completed_at: Date | null;
  last_ok_at: Date | null;
  last_status: string | null;
  last_started_at: Date | null;
  last_finished_at: Date | null;
  last_error: string | null;
  db_now: Date;
}

/**
 * One query for every source. The two lateral subqueries are top-1-per-group lookups: each one is a single
 * probe on its index (runs_source_last_ok_idx, runs_source_started_idx), so the cost does not grow with the
 * size of the runs table.
 */
export async function getHealth(pool: Pool, schema: string, sources: ResolvedSource[], now?: Date): Promise<Health> {
  const s = quoteIdent(schema);
  const { rows } = await pool.query<Row>(
    `select n.name, src.cursor, src.backfill_completed_at, last_ok.finished_at as last_ok_at,
            last_run.status as last_status, last_run.started_at as last_started_at,
            last_run.finished_at as last_finished_at, last_run.error as last_error, now() as db_now
     from unnest($1::text[]) as n(name)
     left join ${s}.sources src on src.name = n.name
     left join lateral (
       select r.finished_at from ${s}.runs r
       where r.source = n.name and r.status = 'ok'
       order by r.finished_at desc limit 1
     ) last_ok on true
     left join lateral (
       select r.status, r.started_at, r.finished_at, r.error from ${s}.runs r
       where r.source = n.name
       order by r.started_at desc limit 1
     ) last_run on true`,
    [sources.map((source) => source.name)],
  );
  const byName = new Map(rows.map((row) => [row.name, row]));
  const reference = now ?? rows[0]?.db_now ?? new Date();

  const result = sources.map((source): SourceHealth => {
    const row = byName.get(source.name);
    const lastOk = row?.last_ok_at ?? null;
    const age = lastOk ? Math.max(0, Math.round((reference.getTime() - lastOk.getTime()) / 1000)) : null;
    let reason: string | null = null;
    if (age === null) reason = 'no successful run yet';
    else if (age > source.staleAfterSeconds) reason = `last successful run was ${age}s ago (threshold ${source.staleAfterSeconds}s)`;
    return {
      source: source.name,
      status: reason ? 'stale' : 'ok',
      reason,
      staleAfterSeconds: source.staleAfterSeconds,
      lastOkAt: lastOk?.toISOString() ?? null,
      ageSeconds: age,
      cursor: row?.cursor?.toISOString() ?? null,
      backfillCompleted: Boolean(row?.backfill_completed_at),
      lastRun: row?.last_status
        ? {
            status: row.last_status,
            startedAt: row.last_started_at!.toISOString(),
            finishedAt: row.last_finished_at?.toISOString() ?? null,
            error: row.last_error,
          }
        : null,
    };
  });
  return { ok: result.every((source) => source.status === 'ok'), checkedAt: reference.toISOString(), sources: result };
}

export type HealthHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

/** A plain Node handler: mount it on `node:http`, Express, Fastify (via `.raw`) or anything that exposes req/res. */
export function createHealthHandler(check: () => Promise<Health>): HealthHandler {
  return async (_req, res) => {
    try {
      const health = await check();
      res.writeHead(health.ok ? 200 : 503, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(health));
    } catch (error) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    }
  };
}
