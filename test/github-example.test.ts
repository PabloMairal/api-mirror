import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMirror, type Mirror, type SourceConfig } from '../src/index.ts';
import { FakeApi } from './support/fake-api.ts';
import { TEST_DATABASE_URL } from './support/harness.ts';

// The demo config, pointed at a fake that answers like GitHub's issues endpoint. Never the real API in tests.
const api = new FakeApi({
  pageSize: 100,
  render: (item) => ({
    id: 1_000_000 + item.id,
    number: item.id,
    title: item.title,
    state: item.id % 2 ? 'open' : 'closed',
    user: { login: `user${item.id}` },
    labels: item.id === 1 ? [{ name: 'bug' }, { name: 'help wanted' }] : [],
    comments: item.id,
    ...(item.id === 2 ? { pull_request: { url: 'https://example.test/pulls/2' } } : {}),
    created_at: item.created_at,
    updated_at: item.updated_at,
    closed_at: item.id % 2 ? null : item.updated_at,
  }),
});
const schema = `t_${randomBytes(5).toString('hex')}`;
const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 3 });
let mirror: Mirror;

beforeAll(async () => {
  await api.start();
  process.env.GITHUB_API_URL = new URL(api.url).origin;
  process.env.GITHUB_REPO = 'octo/demo';
  process.env.GITHUB_TOKEN = 'test-token';
  const { githubIssues } = await import('../examples/github-issues/mirror.config.ts');
  const source: SourceConfig = { ...githubIssues, table: `${schema}.github_issues`, retries: 0 };
  mirror = createMirror({ pool, schema, sources: [source] });
});

afterAll(async () => {
  await api.stop();
  await pool.query(`drop schema if exists ${schema} cascade`);
  await pool.end();
});

describe('GitHub issues example', () => {
  it('maps issues, follows the Link header and sends the documented params', async () => {
    api.insert(250);
    api.tick();
    const backfill = await mirror.backfill('github_issues');
    expect(backfill).toMatchObject({ status: 'ok', pages: 3, rowsInserted: 250 });

    const first = api.requests[0]!;
    expect(first.url.pathname).toBe('/repos/octo/demo/issues');
    expect(Object.fromEntries(first.url.searchParams)).toEqual({ state: 'all', per_page: '100', direction: 'asc', sort: 'created' });
    expect(first.headers['user-agent']).toBe('api-mirror-demo');
    expect(first.headers.authorization).toBe('Bearer test-token');

    const { rows } = await pool.query(
      `select number, state, author, labels, comments, is_pull_request, closed_at is null as open
       from ${schema}.github_issues where number in (1, 2) order by number`,
    );
    expect(rows).toEqual([
      { number: 1, state: 'open', author: 'user1', labels: ['bug', 'help wanted'], comments: 1, is_pull_request: false, open: true },
      { number: 2, state: 'closed', author: 'user2', labels: [], comments: 2, is_pull_request: true, open: false },
    ]);

    api.update(10);
    const sync = await mirror.sync('github_issues');
    expect(sync).toMatchObject({ status: 'ok', rowsUpdated: 1 });
    const since = api.requests.at(-1)!.url.searchParams;
    expect(since.get('sort')).toBe('updated');
    expect(since.get('since')).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/); // GitHub format, no millis
  });
});
