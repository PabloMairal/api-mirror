import { writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import pg from 'pg';
import { createMirror, type Mirror, type RunResult } from '../src/index.ts';
import { FakeApi } from '../test/support/fake-api.ts';
import { itemsSource } from '../test/support/items-source.ts';

// Measures the mirror against the local fake API and a local Postgres. Writes bench/RESULTS.md.
//   npm run case-study
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error('DATABASE_URL is not set');
const schema = 'case_study';
const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });
const lines: string[] = [];
const log = (line = '') => { console.log(line); lines.push(line); };

async function fresh(latencyMs: number, rows: number): Promise<{ api: FakeApi; mirror: Mirror }> {
  await pool.query(`drop schema if exists ${schema} cascade`);
  const api = await new FakeApi({ pageSize: 100, delayMs: latencyMs }).start();
  api.insert(rows);
  api.tick();
  const source = { ...itemsSource(api.url, `${schema}.items`, 'link', 100), overlapSeconds: 60 };
  return { api, mirror: createMirror({ pool, schema, sources: [source] }) };
}

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;

function row(label: string, r: RunResult): string {
  const written = r.rowsInserted + r.rowsUpdated;
  const rate = written > 0 && r.ms > 0 ? Math.round((r.rowsRead / r.ms) * 1000).toLocaleString('en-US') : '-';
  return `| ${label} | ${r.rowsRead.toLocaleString('en-US')} | ${written.toLocaleString('en-US')} | ${r.httpRequests} | ${r.dbQueries} | ${r.httpMs} | ${r.dbMs} | ${r.ms} | ${rate} |`;
}

async function main() {
  const [{ version }] = (await pool.query<{ version: string }>(`select split_part(version(), ' ', 2) as version`)).rows as [{ version: string }];
  log('# Case study results');
  log();
  log(`Measured ${new Date().toISOString().slice(0, 10)} on ${cpus()[0]?.model.trim()}, Node ${process.version}, Postgres ${version}, WSL2.`);
  log('Fake API on localhost (in-memory, pages of 100). `latency` is an artificial delay per response.');
  log();
  log('| Scenario | Rows read | Rows written | HTTP requests | DB queries | HTTP ms | DB ms | Total ms | Rows/s |');
  log('|---|---:|---:|---:|---:|---:|---:|---:|---:|');

  // 1. Backfill, no latency: the library's own overhead.
  let { api, mirror } = await fresh(0, 50_000);
  log(row('Backfill 50k rows, latency 0', await mirror.backfill('items')));

  // 2. Sync with 1,000 changes, then idle syncs.
  for (let id = 1; id <= 1000; id++) api.update(id * 50);
  api.tick(120);
  log(row('Sync, 1,000 changed rows', await mirror.sync('items')));
  const idle: RunResult[] = [];
  for (let i = 0; i < 21; i++) idle.push(await mirror.sync('items'));
  const idleMedian = idle.find((r) => r.ms === median(idle.map((x) => x.ms)))!;
  log(row('Sync, no changes (median of 21)', idleMedian));
  await api.stop();

  // 3. Same backfill shape with a realistic network delay.
  ({ api, mirror } = await fresh(50, 10_000));
  log(row('Backfill 10k rows, latency 50 ms', await mirror.backfill('items')));
  for (let id = 1; id <= 100; id++) api.update(id * 50);
  api.tick(120);
  log(row('Sync, 100 changed rows, latency 50 ms', await mirror.sync('items')));
  const idleSlow: RunResult[] = [];
  for (let i = 0; i < 11; i++) idleSlow.push(await mirror.sync('items'));
  log(row('Sync, no changes, latency 50 ms (median of 11)', idleSlow.find((r) => r.ms === median(idleSlow.map((x) => x.ms)))!));
  await api.stop();

  // 4. Health with a large runs table: 5 sources x 20k runs, i.e. ~19 months of syncs every 5 minutes... per source.
  await pool.query(`
    insert into ${schema}.runs (source, kind, status, started_at, finished_at)
    select 's' || (g % 5), 'sync', case when g % 50 = 0 then 'error' else 'ok' end,
           now() - make_interval(mins => g), now() - make_interval(mins => g) + interval '2 seconds'
    from generate_series(1, 100000) as g`);
  await pool.query(`analyze ${schema}.runs`);
  const many = createMirror({
    pool, schema,
    sources: ['s0', 's1', 's2', 's3', 's4'].map((name) => ({ ...itemsSource('http://unused.test', `${schema}.items`, 'link', 100), name })),
  });
  const timings: number[] = [];
  for (let i = 0; i < 21; i++) {
    const started = performance.now();
    await many.health();
    timings.push(performance.now() - started);
  }
  const plan = await pool.query(`
    explain (analyze, buffers, format text)
    select n.name, last_ok.finished_at
    from unnest(array['s0','s1','s2','s3','s4']) as n(name)
    left join lateral (
      select r.finished_at from ${schema}.runs r where r.source = n.name and r.status = 'ok'
      order by r.finished_at desc limit 1
    ) last_ok on true`);
  const planText = plan.rows.map((r: { 'QUERY PLAN': string }) => r['QUERY PLAN']);
  const execution = planText.find((l) => l.startsWith('Execution Time')) ?? '';
  log();
  log(`Health check with 100,000 rows in the runs table (5 sources): median ${median(timings).toFixed(1)} ms for \`mirror.health()\` end to end (21 calls), 1 query.`);
  log(`Last-ok lookup, \`EXPLAIN ANALYZE\`: ${execution.replace('Execution Time: ', '')}, plan uses \`${planText.some((l) => l.includes('runs_source_last_ok_idx')) ? 'runs_source_last_ok_idx' : 'NO INDEX'}\`.`);
  log();
  log('```');
  for (const line of planText) log(line);
  log('```');

  writeFileSync(new URL('./RESULTS.md', import.meta.url), lines.join('\n') + '\n');
  await pool.query(`drop schema if exists ${schema} cascade`);
  await pool.end();
}

await main();
