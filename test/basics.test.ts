import { afterEach, describe, expect, it } from 'vitest';
import { MirrorRunError } from '../src/index.ts';
import { type Harness, harness } from './support/harness.ts';

let h: Harness;
afterEach(() => h?.close());

describe.each(['link', 'offset', 'cursor'] as const)('%s pagination', (pagination) => {
  it('backfills, then syncs only what changed', async () => {
    h = await harness({ pagination, pageSize: 3 });
    h.api.insert(10);

    const backfill = await h.mirror.backfill('items');
    expect(backfill).toMatchObject({ status: 'ok', pages: 4, rowsRead: 10, rowsInserted: 10, rowsUpdated: 0 });
    expect(await h.rows()).toEqual(h.api.snapshot());

    h.api.update(2);
    h.api.update(7);
    h.api.insert(2);
    const sync = await h.mirror.sync('items');
    expect(sync).toMatchObject({ status: 'ok', rowsInserted: 2, rowsUpdated: 2, restarts: 0 });
    expect(await h.rows()).toEqual(h.api.snapshot());
    expect(await h.cursor()).toBe(h.api.items.get(12)!.updated_at);
  });
});

describe('idempotence', () => {
  it('a sync with no changes writes nothing and costs one request', async () => {
    h = await harness({ pageSize: 3 });
    h.api.insert(10);
    await h.mirror.backfill('items');
    await h.mirror.sync('items');
    const requestsBefore = h.api.requests.length;

    const idle = await h.mirror.sync('items');
    expect(idle).toMatchObject({ status: 'ok', pages: 1, rowsInserted: 0, rowsUpdated: 0 });
    expect(h.api.requests.length - requestsBefore).toBe(1);
  });

  it('replaying the whole backfill changes nothing', async () => {
    h = await harness({ pageSize: 4 });
    h.api.insert(9);
    await h.mirror.backfill('items');
    const before = await h.pool.query(`select id, _mirrored_at from ${h.table} order by id`);

    const again = await h.mirror.backfill('items', { restart: true });
    expect(again).toMatchObject({ status: 'ok', rowsRead: 9, rowsInserted: 0, rowsUpdated: 0 });
    const after = await h.pool.query(`select id, _mirrored_at from ${h.table} order by id`);
    expect(after.rows).toEqual(before.rows);
  });
});

describe('guards', () => {
  it('refuses to sync before a backfill completed', async () => {
    h = await harness();
    h.api.insert(2);
    const error = await h.mirror.sync('items').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MirrorRunError);
    expect((error as MirrorRunError).message).toMatch(/run `mirror backfill items` first/);
    expect(await h.runs()).toMatchObject([{ kind: 'sync', status: 'error' }]);
  });

  it('rejects a sync source that does not sort by modification time', async () => {
    h = await harness({ source: { syncParams: { sort: 'created' } } });
    h.api.insert(3);
    await h.mirror.backfill('items');
    h.api.update(1);
    h.api.update(2);
    // Sorted by creation, item 3 (older timestamp) comes after items 1 and 2 (just updated).
    h.api.insert(1, '2026-01-01T00:00:00Z');
    await expect(h.mirror.sync('items')).rejects.toThrow(/ordered by updated_at ascending/);
  });

  it('never follows a Link header to another origin', async () => {
    h = await harness({ pageSize: 2 });
    h.api.insert(3);
    const original = h.source.url;
    const evil = h.another({ url: original.replace('127.0.0.1', 'localhost') });
    await expect(evil.backfill('items')).rejects.toThrow(/another origin/);
  });

  it('a backfill that already completed is a no-op unless restarted', async () => {
    h = await harness();
    h.api.insert(3);
    await h.mirror.backfill('items');
    const again = await h.mirror.backfill('items');
    expect(again).toMatchObject({ status: 'ok', pages: 0 });
    expect(again.message).toMatch(/already completed/);
  });
});

describe('resumable backfill', () => {
  it('continues from the saved page after a crash', async () => {
    h = await harness({ pageSize: 2 });
    h.api.insert(9);
    const crash = h.another();
    const failed = await crash
      .backfill('items', { hooks: { beforeCommit: ({ page }) => { if (page === 3) throw new Error('killed'); } } })
      .catch((e: MirrorRunError) => e.result);
    expect(failed).toMatchObject({ status: 'error', pages: 3, rowsInserted: 4 }); // only committed pages count
    expect((await h.rows()).length).toBe(4); // pages 1 and 2 committed, page 3 rolled back

    const resumed = await h.mirror.backfill('items');
    expect(resumed.message).toBe('resumed an interrupted backfill');
    expect(resumed).toMatchObject({ status: 'ok', pages: 3, rowsInserted: 5 });
    expect(await h.rows()).toEqual(h.api.snapshot());
  });
});
