import type { ApiRecord, ResolvedSource } from './config.ts';

export class HttpError extends Error {
  override name = 'HttpError';
  readonly status: number;
  constructor(status: number, url: string, body: string) {
    super(`HTTP ${status} from ${url}: ${body.slice(0, 200)}`);
    this.status = status;
  }
}

export interface Page {
  records: ApiRecord[];
  /** URL of the next page, or null when this was the last one. */
  nextUrl: string | null;
  /** Server clock from the `Date` header, when present. */
  serverDate: Date | null;
}

export interface HttpStats {
  requests: number;
  ms: number;
}

export function firstPageUrl(source: ResolvedSource, mode: 'backfill' | 'sync', since: Date | null): string {
  const url = new URL(source.url);
  const params = { ...source.params, ...(mode === 'backfill' ? source.backfillParams : source.syncParams) };
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  if (since) {
    const format = source.formatSince ?? ((d: Date) => d.toISOString());
    url.searchParams.set(source.sinceParam, format(since));
  }
  if (source.pagination.type === 'offset') {
    url.searchParams.set(source.pagination.offsetParam ?? 'offset', '0');
    url.searchParams.set(source.pagination.limitParam ?? 'limit', String(source.pagination.pageSize));
  }
  return url.toString();
}

function nextUrl(source: ResolvedSource, current: string, response: Response, body: unknown, count: number): string | null {
  const pagination = source.pagination;
  switch (pagination.type) {
    case 'link': {
      const link = response.headers.get('link');
      const match = link?.split(',').map((part) => /<([^>]+)>\s*;\s*rel="?next"?/.exec(part)).find(Boolean);
      if (!match) return null;
      const next = new URL(match[1]!, current);
      // Headers (tokens included) go with every request, so never follow a link to another origin.
      if (next.origin !== new URL(source.url).origin) {
        throw new Error(`source "${source.name}": next page link points to another origin (${next.origin})`);
      }
      return next.toString();
    }
    case 'offset': {
      if (count < pagination.pageSize) return null;
      const url = new URL(current);
      const param = pagination.offsetParam ?? 'offset';
      url.searchParams.set(param, String(Number(url.searchParams.get(param) ?? 0) + count));
      return url.toString();
    }
    case 'cursor': {
      const token = pagination.next(body);
      if (!token) return null;
      const url = new URL(current);
      url.searchParams.set(pagination.param, token);
      return url.toString();
    }
  }
}

function retryDelayMs(response: Response | null, attempt: number): number {
  const header = response?.headers.get('retry-after');
  const seconds = header ? Number(header) : NaN;
  if (Number.isFinite(seconds) && seconds >= 0 && seconds <= 60) return seconds * 1000;
  return 250 * 2 ** attempt;
}

function isRetryable(status: number): boolean {
  return status === 429 || status >= 500;
}

export async function fetchPage(source: ResolvedSource, url: string, stats: HttpStats): Promise<Page> {
  const headers = typeof source.headers === 'function' ? source.headers() : (source.headers ?? {});
  for (let attempt = 0; ; attempt++) {
    const started = performance.now();
    let response: Response | null = null;
    try {
      response = await fetch(url, {
        headers: { accept: 'application/json', ...headers },
        signal: AbortSignal.timeout(source.timeoutMs),
      });
      if (!response.ok) {
        const text = await response.text();
        if (attempt < source.retries && isRetryable(response.status)) {
          await new Promise((r) => setTimeout(r, retryDelayMs(response, attempt)));
          continue;
        }
        throw new HttpError(response.status, url, text);
      }
      const body: unknown = await response.json();
      const raw = source.records ? source.records(body) : body;
      if (!Array.isArray(raw)) {
        throw new Error(`source "${source.name}": response body is not an array; set \`records\` in the config`);
      }
      const date = response.headers.get('date');
      return {
        records: raw as ApiRecord[],
        nextUrl: nextUrl(source, url, response, body, raw.length),
        serverDate: date ? new Date(date) : null,
      };
    } catch (error) {
      const network = !(error instanceof HttpError) && response === null;
      if (network && attempt < source.retries) {
        await new Promise((r) => setTimeout(r, retryDelayMs(null, attempt)));
        continue;
      }
      throw error;
    } finally {
      stats.requests += 1;
      stats.ms += performance.now() - started;
    }
  }
}
