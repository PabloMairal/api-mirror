import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { type Harness, harness } from './support/harness.ts';

let h: Harness;
afterEach(() => h?.close());

describe('health', () => {
  it('is stale before any successful run, ok after one, and stale again past the threshold', async () => {
    h = await harness({ source: { staleAfterSeconds: 600 } });
    h.api.insert(3);

    const never = await h.mirror.health();
    expect(never.ok).toBe(false);
    expect(never.sources[0]).toMatchObject({ status: 'stale', reason: 'no successful run yet', lastRun: null });

    await h.mirror.backfill('items');
    const fresh = await h.mirror.health();
    expect(fresh.ok).toBe(true);
    expect(fresh.sources[0]).toMatchObject({ status: 'ok', backfillCompleted: true, lastRun: { status: 'ok' } });

    const lastOk = new Date(fresh.sources[0]!.lastOkAt!);
    const justBefore = await h.mirror.health({ now: new Date(lastOk.getTime() + 600_000) });
    expect(justBefore.sources[0]!.status).toBe('ok');
    const after = await h.mirror.health({ now: new Date(lastOk.getTime() + 601_000) });
    expect(after.ok).toBe(false);
    expect(after.sources[0]).toMatchObject({ status: 'stale', ageSeconds: 601 });
    expect(after.sources[0]!.reason).toMatch(/601s ago \(threshold 600s\)/);
  });

  it('failed and skipped runs do not count as fresh', async () => {
    h = await harness({ source: { staleAfterSeconds: 600 } });
    h.api.insert(3);
    await h.mirror.backfill('items');
    const lastOk = new Date((await h.mirror.health()).sources[0]!.lastOkAt!);

    h.api.onRequest = () => ({ status: 500 });
    await h.mirror.sync('items').catch(() => {});
    const health = await h.mirror.health({ now: new Date(lastOk.getTime() + 700_000) });
    expect(health.sources[0]).toMatchObject({ status: 'stale', lastRun: { status: 'error' } });
    expect(health.sources[0]!.lastRun!.error).toMatch(/HTTP 500/);
  });

  it('the HTTP handler answers 503 while stale and 200 when fresh', async () => {
    h = await harness();
    h.api.insert(2);
    const server = createServer(h.mirror.healthHandler());
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/health`;
    try {
      const stale = await fetch(url);
      expect(stale.status).toBe(503);
      expect(await stale.json()).toMatchObject({ ok: false });

      await h.mirror.backfill('items');
      const ok = await fetch(url);
      expect(ok.status).toBe(200);
      expect(ok.headers.get('content-type')).toBe('application/json');
      expect(await ok.json()).toMatchObject({ ok: true, sources: [{ source: 'items', status: 'ok' }] });
    } finally {
      server.close();
    }
  });
});
