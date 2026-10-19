import pg from 'pg';
import { ConfigError, type MirrorConfig, type ResolvedSource, assertIdentifier, resolveSource } from './config.ts';
import { CountingClient, migrate } from './db.ts';
import { type Health, type HealthHandler, createHealthHandler, getHealth } from './health.ts';
import { type RunKind, type RunOptions, type RunResult, execute } from './run.ts';
import { ensureTargetTable } from './target.ts';

export { ConfigError, defineConfig, defineSource } from './config.ts';
export type { ApiRecord, ColumnSpec, ColumnType, MirrorConfig, Pagination, SourceConfig } from './config.ts';
export { HttpError } from './http.ts';
export type { Health, HealthHandler, SourceHealth } from './health.ts';
export { MirrorRunError, SourceContractError } from './run.ts';
export type { PageInfo, RunHooks, RunKind, RunOptions, RunResult } from './run.ts';

export interface MirrorOptions extends MirrorConfig {
  /** Either an existing pool (the mirror will not close it) or a connection string. */
  pool?: pg.Pool;
  databaseUrl?: string;
}

export class Mirror {
  readonly schema: string;
  readonly pool: pg.Pool;
  private readonly sources = new Map<string, ResolvedSource>();
  private readonly ownsPool: boolean;
  private migrated: Promise<number> | undefined;
  private readonly tablesReady = new Set<string>();

  constructor(options: MirrorOptions) {
    this.schema = options.schema ?? 'api_mirror';
    assertIdentifier(this.schema, 'schema');
    for (const source of options.sources) {
      if (this.sources.has(source.name)) throw new ConfigError(`duplicate source "${source.name}"`);
      this.sources.set(source.name, resolveSource(source));
    }
    if (options.pool) {
      this.pool = options.pool;
      this.ownsPool = false;
    } else {
      if (!options.databaseUrl) throw new ConfigError('pass either pool or databaseUrl');
      this.pool = new pg.Pool({ connectionString: options.databaseUrl, max: 4 });
      this.ownsPool = true;
    }
  }

  get sourceNames(): string[] {
    return [...this.sources.keys()];
  }

  source(name: string): ResolvedSource {
    const source = this.sources.get(name);
    if (!source) throw new ConfigError(`unknown source "${name}"; configured: ${this.sourceNames.join(', ') || 'none'}`);
    return source;
  }

  /** Creates or upgrades the library's own tables. Runs once per instance; safe to call from many processes. */
  migrate(): Promise<number> {
    this.migrated ??= migrate(this.pool, this.schema);
    return this.migrated;
  }

  /** Reads everything that changed since the last sync. Requires a completed backfill. */
  sync(name: string, options: RunOptions = {}): Promise<RunResult> {
    return this.run(name, 'sync', options);
  }

  /** Reads the whole collection. Resumes an interrupted backfill unless `restart` is set. */
  backfill(name: string, options: RunOptions = {}): Promise<RunResult> {
    return this.run(name, 'backfill', options);
  }

  async health(options: { now?: Date } = {}): Promise<Health> {
    await this.migrate();
    return getHealth(this.pool, this.schema, [...this.sources.values()], options.now);
  }

  healthHandler(): HealthHandler {
    return createHealthHandler(() => this.health());
  }

  async close(): Promise<void> {
    if (this.ownsPool) await this.pool.end();
  }

  private async run(name: string, kind: RunKind, options: RunOptions): Promise<RunResult> {
    const source = this.source(name);
    await this.migrate();
    return execute(this.pool, this.schema, source, kind, options, async (db: CountingClient) => {
      if (this.tablesReady.has(name)) return;
      await ensureTargetTable(db, source);
      this.tablesReady.add(name);
    });
  }
}

export function createMirror(options: MirrorOptions): Mirror {
  return new Mirror(options);
}
