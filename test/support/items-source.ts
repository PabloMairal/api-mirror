import type { SourceConfig } from '../../src/index.ts';
import type { FakeApiOptions } from './fake-api.ts';

/** The source definition every test uses, pointed at a FakeApi. Also imported by the CLI fixture config. */
export function itemsSource(url: string, table: string, pagination: FakeApiOptions['pagination'], pageSize: number): SourceConfig {
  const base = {
    name: 'items',
    table,
    url,
    backfillParams: { sort: 'created' },
    syncParams: { sort: 'updated' },
    sinceParam: 'since',
    modifiedAt: 'updated_at',
    primaryKey: 'id',
    columns: {
      id: { type: 'bigint' },
      title: { type: 'text' },
      created_at: { type: 'timestamptz' },
      updated_at: { type: 'timestamptz' },
    },
    staleAfterSeconds: 3600,
    overlapSeconds: 0,
    retries: 0,
  } satisfies Partial<SourceConfig>;
  switch (pagination ?? 'link') {
    case 'offset':
      return { ...base, pagination: { type: 'offset', pageSize } };
    case 'cursor':
      return {
        ...base,
        records: (body) => (body as { items: unknown[] }).items,
        pagination: { type: 'cursor', param: 'cursor', next: (body) => (body as { next_cursor: string | null }).next_cursor },
      };
    case 'link':
      return { ...base, params: { per_page: String(pageSize) }, pagination: { type: 'link' } };
  }
}
