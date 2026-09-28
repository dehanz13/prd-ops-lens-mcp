import { createServer } from 'node:http';

const metrics = [
  '# HELP demo_db_pool_in_use Synthetic database connections currently in use.',
  '# TYPE demo_db_pool_in_use gauge',
  'demo_db_pool_in_use{service="demo-api"} 19',
  '# HELP demo_db_pool_max Synthetic database connection capacity.',
  '# TYPE demo_db_pool_max gauge',
  'demo_db_pool_max{service="demo-api"} 20',
  '# HELP demo_score_write_errors_total Synthetic failed score writes.',
  '# TYPE demo_score_write_errors_total counter',
  'demo_score_write_errors_total{service="demo-api"} 7',
].join('\n') + '\n';

createServer((request, response) => {
  if (request.url === '/metrics') {
    response.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
    response.end(metrics);
    return;
  }
  if (request.url === '/health') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ status: 'ok', scenario: 'synthetic-db-pool-saturation' }));
    return;
  }
  response.writeHead(404);
  response.end();
}).listen(8080, '0.0.0.0');

async function seedLoki() {
  const now = BigInt(Date.now()) * 1_000_000n;
  const lines = [
    [String(now - 1_000_000_000n), JSON.stringify({ service: 'demo-api', logCode: 'DB_POOL_SATURATED', message: 'synthetic database pool at capacity' })],
    [String(now), JSON.stringify({ service: 'demo-api', logCode: 'SCORE_WRITE_FAILED', causeLogCode: 'DB_POOL_SATURATED', message: 'synthetic score write could not acquire a connection' })],
  ];
  const response = await fetch(`${process.env.LOKI_URL}/loki/api/v1/push`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ streams: [{ stream: { job: 'demo-api', service: 'demo-api' }, values: lines }] }),
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error('Synthetic Loki seed failed');
}

async function seedWithRetry() {
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      await seedLoki();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
  process.stderr.write('Synthetic Loki seed did not complete.\n');
}

void seedWithRetry();
setInterval(() => { void seedWithRetry(); }, 60_000);
