import { createServer } from 'node:http';
import { createMirror } from '../src/index.ts';
import config from './github-issues/mirror.config.ts';

// Mounts the health handler on a bare Node server: GET /health answers 200 when every source is fresh, 503 otherwise.
//   node --env-file=.env examples/health-server.ts
const mirror = createMirror({ ...config, databaseUrl: process.env.DATABASE_URL! });
const health = mirror.healthHandler();
const port = Number(process.env.PORT ?? 3120);

createServer((req, res) => {
  if (req.url === '/health') return void health(req, res);
  res.writeHead(404).end();
}).listen(port, () => console.log(`health on http://localhost:${port}/health`));
