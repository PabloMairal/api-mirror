import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeItem {
  id: number;
  title: string;
  created_at: string;
  updated_at: string;
}

export type FakePagination = 'link' | 'offset' | 'cursor';

export interface FakeRequest {
  n: number;
  url: URL;
  headers: Record<string, string | string[] | undefined>;
}

export interface FakeApiOptions {
  pagination?: FakePagination;
  /** Page size for `link` and `cursor` pagination. `offset` takes it from the `limit` param. */
  pageSize?: number;
  /** GitHub's `since` is inclusive. Some APIs use a strict `>`; the overlap window exists for those. */
  sinceExclusive?: boolean;
  delayMs?: number;
  /** Shapes each item in responses, e.g. to look like a GitHub issue. */
  render?: (item: FakeItem) => unknown;
}

/**
 * An in-memory REST API with GitHub-like semantics: `since` filters on updated_at, `sort` picks created or
 * updated (ascending, ties broken by id), and pages are positional, so they shift when data changes mid-read.
 * `onRequest` runs before each response and can mutate data, delay, block or fail the request.
 */
export class FakeApi {
  readonly items = new Map<number, FakeItem>();
  readonly requests: FakeRequest[] = [];
  onRequest: ((request: FakeRequest) => void | { status: number } | Promise<void | { status: number }>) | undefined;
  /** The server's clock. Every insert or update advances it one second unless a time is given. */
  clock = Date.parse('2026-01-01T00:00:00Z');
  private server: Server | undefined;
  private nextId = 1;
  private readonly cache = new Map<string, FakeItem[]>();
  private readonly options: Required<FakeApiOptions>;
  url = '';

  constructor(options: FakeApiOptions = {}) {
    this.options = {
      pagination: 'link', pageSize: 3, sinceExclusive: false, delayMs: 0, render: (item) => item, ...options,
    };
  }

  async start(): Promise<this> {
    this.server = createServer((req, res) => {
      this.handle(req.url ?? '/', req.headers).then(
        ({ status, headers, body }) => {
          res.writeHead(status, headers);
          res.end(body);
        },
        (error: Error) => {
          res.writeHead(500);
          res.end(error.message);
        },
      );
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    const { port } = this.server.address() as AddressInfo;
    this.url = `http://127.0.0.1:${port}/items`;
    return this;
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) => this.server?.close(() => resolve()) ?? resolve());
  }

  tick(seconds = 1): string {
    this.clock += seconds * 1000;
    return new Date(this.clock).toISOString();
  }

  insert(count: number, at?: string): FakeItem[] {
    const created: FakeItem[] = [];
    for (let i = 0; i < count; i++) {
      const time = at ?? this.tick();
      const item = { id: this.nextId++, title: `item ${this.nextId - 1} v1`, created_at: time, updated_at: time };
      this.items.set(item.id, item);
      this.cache.clear();
      created.push(item);
    }
    return created;
  }

  update(id: number, at?: string): FakeItem {
    const item = this.items.get(id);
    if (!item) throw new Error(`no item ${id}`);
    const version = Number(/v(\d+)$/.exec(item.title)?.[1] ?? 1) + 1;
    item.title = `item ${id} v${version}`;
    item.updated_at = at ?? this.tick();
    this.cache.clear();
    return item;
  }

  /** What the mirror should contain, in the shape the tests compare. */
  snapshot(): Array<{ id: number; title: string; updated_at: string }> {
    return [...this.items.values()]
      .sort((a, b) => a.id - b.id)
      .map(({ id, title, updated_at }) => ({ id, title, updated_at }));
  }

  /** Filtered and sorted rows, cached until the data changes, so the fake does not dominate benchmarks. */
  private query(sortField: 'created_at' | 'updated_at', since: string | null): FakeItem[] {
    const key = `${sortField}|${since}`;
    const cached = this.cache.get(key);
    if (cached) return cached;
    const sinceMs = since ? Date.parse(since) : null;
    const rows = [...this.items.values()]
      .map((item) => ({ item, at: Date.parse(item[sortField]), updated: Date.parse(item.updated_at) }))
      .filter(({ updated }) => sinceMs === null || (this.options.sinceExclusive ? updated > sinceMs : updated >= sinceMs))
      .sort((a, b) => a.at - b.at || a.item.id - b.item.id)
      .map(({ item }) => item);
    this.cache.set(key, rows);
    return rows;
  }

  private async handle(path: string, headers: FakeRequest['headers']) {
    const url = new URL(path, this.url);
    const request = { n: this.requests.length + 1, url, headers };
    this.requests.push(request);
    const override = await this.onRequest?.(request);
    if (override) return { status: override.status, headers: {}, body: 'injected failure' };
    if (this.options.delayMs) await new Promise((r) => setTimeout(r, this.options.delayMs));

    const rows = this.query(url.searchParams.get('sort') === 'updated' ? 'updated_at' : 'created_at', url.searchParams.get('since'));
    const render = (items: FakeItem[]) => items.map((item) => this.options.render(item));

    const responseHeaders: Record<string, string> = {
      'content-type': 'application/json',
      date: new Date(this.clock).toUTCString(),
    };
    const { pagination, pageSize } = this.options;
    if (pagination === 'offset') {
      const offset = Number(url.searchParams.get('offset') ?? 0);
      const limit = Number(url.searchParams.get('limit') ?? 10);
      return { status: 200, headers: responseHeaders, body: JSON.stringify(render(rows.slice(offset, offset + limit))) };
    }
    if (pagination === 'cursor') {
      // An opaque token that is really an offset, like many APIs: it shifts just like offset pagination.
      const token = url.searchParams.get('cursor');
      const offset = token ? Number(Buffer.from(token, 'base64url').toString()) : 0;
      const items = rows.slice(offset, offset + pageSize);
      const next = offset + pageSize < rows.length ? Buffer.from(String(offset + pageSize)).toString('base64url') : null;
      return { status: 200, headers: responseHeaders, body: JSON.stringify({ items: render(items), next_cursor: next }) };
    }
    const page = Number(url.searchParams.get('page') ?? 1);
    const perPage = Number(url.searchParams.get('per_page') ?? pageSize);
    const items = rows.slice((page - 1) * perPage, page * perPage);
    if (page * perPage < rows.length) {
      const next = new URL(url);
      next.searchParams.set('page', String(page + 1));
      responseHeaders.link = `<${next.toString()}>; rel="next"`;
    }
    return { status: 200, headers: responseHeaders, body: JSON.stringify(render(items)) };
  }
}
