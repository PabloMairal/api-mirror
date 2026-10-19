import { afterEach, describe, expect, it } from 'vitest';
import { type Harness, harness } from './support/harness.ts';

let h: Harness;
afterEach(() => h?.close());

describe('a row that changes between the backfill and the first sync', () => {
  it('is picked up whether it changed during the backfill or after it', async () => {
    h = await harness({ pageSize: 2 });
    h.api.insert(6);
    const firstResponseDate = new Date(Math.floor(h.api.clock / 1000) * 1000).toISOString();
    // While the backfill reads page 3, item 1 (already read on page 1) changes.
    h.api.onRequest = ({ n }) => { if (n === 3) h.api.update(1); };

    await h.mirror.backfill('items');
    expect((await h.rows()).find((row) => row.id === 1)?.title).toBe('item 1 v1');
    // The cursor starts where the backfill started, by the server's clock (ours is months ahead of the fake's).
    expect(await h.cursor()).toBe(firstResponseDate);

    h.api.onRequest = undefined;
    h.api.update(4);
    const sync = await h.mirror.sync('items');
    expect(sync).toMatchObject({ rowsUpdated: 2, rowsInserted: 0 });
    expect(await h.rows()).toEqual(h.api.snapshot());
  });
});

describe.each(['link', 'offset', 'cursor'] as const)('rows moving under %s pagination during a sync', (pagination) => {
  it('are detected and the pass restarts, so the row they pushed back is not skipped', async () => {
    h = await harness({ pagination, pageSize: 2 });
    h.api.insert(6);
    await h.mirror.backfill('items');
    for (const id of [1, 2, 3, 4, 5, 6]) h.api.update(id);

    // After page 1 ([1, 2]) item 1 changes and moves to the end. Every row shifts back one position, so page 2
    // starts at item 4 and item 3 is never served in this pass.
    const base = h.api.requests.length;
    h.api.onRequest = ({ n }) => { if (n === base + 2) h.api.update(1); };

    const sync = await h.mirror.sync('items');
    expect(sync.restarts).toBe(1);
    expect(await h.rows()).toEqual(h.api.snapshot());
  });

  it('gives up after maxRestarts but keeps everything it wrote', async () => {
    h = await harness({ pagination, pageSize: 2, source: { maxRestarts: 1 } });
    h.api.insert(6);
    await h.mirror.backfill('items');
    for (const id of [1, 2, 3, 4, 5, 6]) h.api.update(id);
    // Something always changes behind us.
    h.api.onRequest = ({ url }) => { if (url.searchParams.get('sort') === 'updated') h.api.update(1 + (h.api.requests.length % 6)); };

    await expect(h.mirror.sync('items')).rejects.toThrow(/kept changing under pagination/);
    h.api.onRequest = undefined;
    await h.mirror.sync('items');
    expect(await h.rows()).toEqual(h.api.snapshot());
  });
});
