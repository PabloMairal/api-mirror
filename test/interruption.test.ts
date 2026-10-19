import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import type { MirrorRunError, RunResult } from '../src/index.ts';
import { type Harness, TEST_DATABASE_URL, harness } from './support/harness.ts';

let h: Harness;
afterEach(() => h?.close());

/** 6 rows backfilled, then 4 updated and 3 inserted: the sync reads 7 changes in pages of 3, 3 and 1. */
async function withPendingChanges(): Promise<Harness> {
  h = await harness({ pageSize: 3 });
  h.api.insert(6);
  h.api.tick(); // the backfill starts a second after the last write, so the sync does not re-read item 6
  await h.mirror.backfill('items');
  for (const id of [1, 2, 3, 4]) h.api.update(id);
  h.api.insert(3);
  return h;
}

const failedResult = (error: unknown) => (error as MirrorRunError).result;

describe('a sync cut in the middle of a page', () => {
  it('rolls back the page in flight, and the retry neither duplicates nor loses rows', async () => {
    await withPendingChanges();
    const firstPage = h.api.snapshot().filter((row) => [1, 2, 3].includes(row.id));

    const crashed = await h
      .another()
      .sync('items', { hooks: { beforeCommit: ({ page }) => { if (page === 2) throw new Error('crash after upsert'); } } })
      .catch(failedResult);
    expect(crashed).toMatchObject({ status: 'error', pages: 2, rowsUpdated: 3, rowsInserted: 0 });

    // Page 1 is in, page 2 (items 4, 7, 8) is not, not even partially.
    const rows = await h.rows();
    expect(rows.filter((row) => [1, 2, 3].includes(row.id))).toEqual(firstPage);
    expect(rows.find((row) => row.id === 4)?.title).toBe('item 4 v1');
    expect(rows.some((row) => row.id >= 7)).toBe(false);
    expect(await h.cursor()).toBe(h.api.items.get(3)!.updated_at);

    const retry = await h.mirror.sync('items');
    // 7 changes in total, 3 already written: the retry writes exactly the other 4.
    expect(retry.rowsInserted + retry.rowsUpdated).toBe(4);
    expect(await h.rows()).toEqual(h.api.snapshot());
  });

  it('survives the API failing mid-sync', async () => {
    await withPendingChanges();
    const base = h.api.requests.length;
    h.api.onRequest = ({ n }) => (n === base + 2 ? { status: 503 } : undefined);

    const failed = await h.mirror.sync('items').catch(failedResult);
    expect(failed).toMatchObject({ status: 'error', pages: 1, rowsUpdated: 3 });
    expect(failed.message).toMatch(/HTTP 503/);

    h.api.onRequest = undefined;
    const retry = await h.mirror.sync('items');
    expect(retry.rowsInserted + retry.rowsUpdated).toBe(4);
    expect(await h.rows()).toEqual(h.api.snapshot());
  });

  it('survives the process being killed: the lock is released and the run marked abandoned', async () => {
    await withPendingChanges();
    const base = h.api.requests.length;
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let reachedPage2!: () => void;
    const atPage2 = new Promise<void>((resolve) => { reachedPage2 = resolve; });
    h.api.onRequest = async ({ n }) => {
      if (n === base + 2) {
        reachedPage2();
        await blocked;
      }
    };

    const child = spawn(
      process.execPath,
      ['src/cli.ts', 'sync', 'items', '--config', 'test/fixtures/mirror.config.ts'],
      {
        env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL, FAKE_API_URL: h.api.url, MIRROR_SCHEMA: h.schema, PAGE_SIZE: '3' },
        stdio: 'pipe',
      },
    );
    await atPage2;
    const [held] = (await h.pool.query(`select count(*)::int as n from pg_locks where locktype = 'advisory' and granted`)).rows;
    expect(held.n).toBeGreaterThanOrEqual(1);
    child.kill('SIGKILL');
    await once(child, 'exit');
    release();

    expect((await h.rows()).find((row) => row.id === 1)?.title).toBe('item 1 v2'); // page 1 was committed
    h.api.onRequest = undefined;
    const retry: RunResult = await h.mirror.sync('items', { wait: true, waitTimeoutMs: 5000 });
    expect(retry.status).toBe('ok');
    expect(retry.rowsInserted + retry.rowsUpdated).toBe(4);
    expect(await h.rows()).toEqual(h.api.snapshot());
    expect((await h.runs()).map((run) => `${run.kind}:${run.status}`)).toEqual(['backfill:ok', 'sync:abandoned', 'sync:ok']);
  });
});
