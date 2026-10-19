import { type ApiRecord, defineConfig, defineSource } from '../../src/index.ts';

/**
 * Mirrors the issues (and pull requests, which GitHub serves on the same endpoint) of a public repository.
 *
 *   GITHUB_REPO=owner/name   defaults to tj/commander.js (~2.4k issues and PRs, ~25 requests to backfill)
 *   GITHUB_TOKEN             optional; raises the rate limit from 60 to 5,000 requests per hour
 */
const repo = process.env.GITHUB_REPO ?? 'tj/commander.js';
const api = process.env.GITHUB_API_URL ?? 'https://api.github.com';

export const githubIssues = defineSource({
  name: 'github_issues',
  table: 'github_issues',
  url: `${api}/repos/${repo}/issues`,
  headers: () => ({
    accept: 'application/vnd.github+json',
    'user-agent': 'api-mirror-demo',
    'x-github-api-version': '2022-11-28',
    ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
  }),
  params: { state: 'all', per_page: '100', direction: 'asc' },
  // Creation order never changes, so the backfill's pages cannot shift when issues are edited.
  backfillParams: { sort: 'created' },
  syncParams: { sort: 'updated' },
  pagination: { type: 'link' },
  sinceParam: 'since',
  // GitHub timestamps have second resolution; flooring keeps the bound inclusive.
  formatSince: (since) => since.toISOString().replace(/\.\d{3}Z$/, 'Z'),
  primaryKey: 'id',
  modifiedAt: 'updated_at',
  columns: {
    id: { type: 'bigint' },
    number: { type: 'integer' },
    title: { type: 'text' },
    state: { type: 'text' },
    author: { type: 'text', from: 'user.login' },
    labels: { type: 'text[]', from: (issue: ApiRecord) => (issue.labels as Array<{ name: string }>).map((l) => l.name) },
    comments: { type: 'integer' },
    is_pull_request: { type: 'boolean', from: (issue: ApiRecord) => issue.pull_request != null },
    created_at: { type: 'timestamptz' },
    updated_at: { type: 'timestamptz' },
    closed_at: { type: 'timestamptz' },
  },
  staleAfterSeconds: 2 * 60 * 60,
  overlapSeconds: 60,
});

export default defineConfig({ sources: [githubIssues] });
