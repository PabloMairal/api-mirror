#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { type Health, type MirrorConfig, MirrorRunError, type RunResult, createMirror } from './index.ts';

const USAGE = `Usage:
  mirror backfill <source> [--restart] [--wait]   read the whole collection (resumes if interrupted)
  mirror sync <source> [--wait]                   read what changed since the last run
  mirror health [--json]                          exit 1 when any source is stale
  mirror sources                                  list configured sources

Options:
  --config <path>   config module (default: ./mirror.config.ts or ./mirror.config.js)
  --wait            wait for a concurrent run of the same source instead of skipping

Environment:
  DATABASE_URL      Postgres connection string (read from .env when present)`;

async function loadConfig(path: string | undefined): Promise<MirrorConfig> {
  const candidates = path ? [path] : ['mirror.config.ts', 'mirror.config.js'];
  const found = candidates.map((candidate) => resolve(candidate)).find((candidate) => existsSync(candidate));
  if (!found) throw new Error(`config not found (tried ${candidates.join(', ')})`);
  const module = (await import(pathToFileURL(found).href)) as { default?: MirrorConfig };
  if (!module.default?.sources) throw new Error(`${found} must export default defineConfig({ sources: [...] })`);
  return module.default;
}

function summary(result: RunResult): string {
  const parts = [
    `${result.kind} ${result.source}: ${result.status}`,
    `run #${result.runId}`,
    `${result.pages} pages`,
    `${result.rowsRead} read`,
    `${result.rowsInserted} inserted`,
    `${result.rowsUpdated} updated`,
  ];
  if (result.restarts) parts.push(`${result.restarts} restarts`);
  parts.push(
    `${result.httpRequests} requests (${result.httpMs} ms)`,
    `${result.dbQueries} queries (${result.dbMs} ms)`,
    `${result.ms} ms total`,
  );
  if (result.cursorTo) parts.push(`cursor ${result.cursorTo.toISOString()}`);
  return parts.join(' | ') + (result.message ? `\n  ${result.message}` : '');
}

function printHealth(health: Health): void {
  for (const source of health.sources) {
    const age = source.ageSeconds === null ? 'never' : `${source.ageSeconds}s ago`;
    const last = source.lastRun ? `last run ${source.lastRun.status}` : 'no runs';
    console.log(`${source.status.padEnd(5)}  ${source.source}  last ok ${age}, ${last}${source.reason ? ` (${source.reason})` : ''}`);
  }
}

async function main(): Promise<number> {
  if (existsSync('.env')) process.loadEnvFile('.env');
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: 'string' },
      wait: { type: 'boolean', default: false },
      restart: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const [command, name] = positionals;
  if (values.help || !command) {
    console.log(USAGE);
    return command ? 0 : 2;
  }

  const config = await loadConfig(values.config);
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');
  const mirror = createMirror({ ...config, databaseUrl: process.env.DATABASE_URL });
  try {
    switch (command) {
      case 'sources':
        for (const source of mirror.sourceNames) console.log(source);
        return 0;
      case 'health': {
        const health = await mirror.health();
        if (values.json) console.log(JSON.stringify(health, null, 2));
        else printHealth(health);
        return health.ok ? 0 : 1;
      }
      case 'sync':
      case 'backfill': {
        if (!name) {
          console.error(`missing source name\n\n${USAGE}`);
          return 2;
        }
        const options = { wait: values.wait, restart: values.restart };
        try {
          const result = command === 'sync' ? await mirror.sync(name, options) : await mirror.backfill(name, options);
          console.log(summary(result));
          return 0;
        } catch (error) {
          if (error instanceof MirrorRunError) {
            console.error(summary(error.result));
            return 1;
          }
          throw error;
        }
      }
      default:
        console.error(`unknown command "${command}"\n\n${USAGE}`);
        return 2;
    }
  } finally {
    await mirror.close();
  }
}

main().then(
  (code) => { process.exitCode = code; },
  (error: unknown) => {
    console.error(error instanceof Error ? `error: ${error.message}` : error);
    process.exitCode = 1;
  },
);
