import { afterEach, describe, expect, it } from 'vitest';
import { type Harness, harness } from './support/harness.ts';

let h: Harness;
afterEach(() => h?.close());

async function slowSourceWithChanges(): Promise<Harness> {
  h = await harness({ pageSize: 2, delayMs: 40 });
  h.api.insert(6);
  await h.mirror.backfill('items');
  for (const id of [1, 2, 3, 4, 5, 6]) h.api.update(id);
  return h;
}

describe('two runs of the same source at once', () => {
  it('one runs and the other skips without touching the API', async () => {
    await slowSourceWithChanges();
    const before = h.api.requests.length;

    const results = await Promise.all([h.mirror.sync('items'), h.another().sync('items')]);
    expect(results.map((r) => r.status).sort()).toEqual(['ok', 'skipped']);
    expect(h.api.requests.length - before).toBe(3); // only the winner paged through
    expect(results.find((r) => r.status === 'ok')).toMatchObject({ rowsUpdated: 6 });
    expect(await h.rows()).toEqual(h.api.snapshot());
    expect((await h.runs()).map((r) => r.status).sort()).toEqual(['ok', 'ok', 'skipped']);
  });

  it('with wait, the second one runs after the first and finds nothing new', async () => {
    await slowSourceWithChanges();
    const [first, second] = await Promise.all([
      h.mirror.sync('items'),
      new Promise((r) => setTimeout(r, 20)).then(() => h.another().sync('items', { wait: true, waitTimeoutMs: 5000 })),
    ]);
    expect(first).toMatchObject({ status: 'ok', rowsUpdated: 6 });
    expect(second).toMatchObject({ status: 'ok', pages: 1, rowsInserted: 0, rowsUpdated: 0 });
    expect(await h.rows()).toEqual(h.api.snapshot());
  });

  it('a sync started while the backfill runs is skipped', async () => {
    h = await harness({ pageSize: 2, delayMs: 40 });
    h.api.insert(6);
    const [backfill, sync] = await Promise.all([
      h.mirror.backfill('items'),
      new Promise((r) => setTimeout(r, 20)).then(() => h.another().sync('items')),
    ]);
    expect(backfill.status).toBe('ok');
    expect(sync.status).toBe('skipped');
  });
});
