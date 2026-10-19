import { afterEach, describe, expect, it } from 'vitest';
import type { MirrorRunError } from '../src/index.ts';
import { type Harness, harness } from './support/harness.ts';

let h: Harness;
afterEach(() => h?.close());

describe('rows sharing a timestamp across a page boundary', () => {
  it('are all kept when the run stops between the two pages', async () => {
    h = await harness({ pageSize: 2 });
    h.api.insert(2);
    h.api.tick();
    await h.mirror.backfill('items');
    const tie = h.api.tick();
    h.api.insert(5, tie); // pages: [3, 4] [5, 6] [7], all with the same updated_at

    const stopped = await h
      .another()
      .sync('items', { hooks: { afterCommit: ({ page }) => { if (page === 1) throw new Error('stop'); } } })
      .catch((error: MirrorRunError) => error.result);
    expect(stopped).toMatchObject({ status: 'error', rowsInserted: 2 });
    expect(await h.cursor()).toBe(tie);

    // The cursor sits on the tied timestamp; an inclusive `since` returns all five again.
    const retry = await h.mirror.sync('items');
    expect(retry).toMatchObject({ status: 'ok', rowsRead: 5, rowsInserted: 3, rowsUpdated: 0 });
    expect(await h.rows()).toEqual(h.api.snapshot());
  });

  it('are all kept across two full syncs too', async () => {
    h = await harness({ pageSize: 2 });
    h.api.insert(1);
    await h.mirror.backfill('items');
    const tie = h.api.tick();
    h.api.insert(3, tie);
    await h.mirror.sync('items');
    h.api.insert(2, tie); // land later, in the same second as the cursor
    const second = await h.mirror.sync('items');
    expect(second).toMatchObject({ rowsInserted: 2 });
    expect(await h.rows()).toEqual(h.api.snapshot());
  });

  describe('with an API whose `since` is exclusive', () => {
    async function lateRowInTheSameSecond(overlapSeconds: number) {
      h = await harness({ pageSize: 2, sinceExclusive: true, source: { overlapSeconds } });
      h.api.insert(1);
      await h.mirror.backfill('items');
      const tie = h.api.tick();
      h.api.insert(2, tie);
      await h.mirror.sync('items');
      h.api.insert(1, tie);
      await h.mirror.sync('items');
      return h;
    }

    it('loses the late row without an overlap window (the failure mode the window exists for)', async () => {
      await lateRowInTheSameSecond(0);
      expect((await h.rows()).length).toBe(h.api.items.size - 1);
    });

    it('keeps it with a one-second overlap', async () => {
      await lateRowInTheSameSecond(1);
      expect(await h.rows()).toEqual(h.api.snapshot());
    });
  });
});
