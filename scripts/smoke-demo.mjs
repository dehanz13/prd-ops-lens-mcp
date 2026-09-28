import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const probes = [
  ['grafana', 'http://127.0.0.1:3000/api/health'],
  ['prometheus', 'http://127.0.0.1:9090/-/ready'],
  ['loki', 'http://127.0.0.1:3100/ready'],
  ['demo-api', 'http://127.0.0.1:8088/health'],
  ['uptime-kuma', 'http://127.0.0.1:3001/'],
];
for (const [name, url] of probes) {
  const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`${name} readiness returned HTTP ${response.status}`);
}

const dir = mkdtempSync(join(tmpdir(), 'ops-lens-demo-smoke-'));
const configPath = join(dir, 'config.yaml');
writeFileSync(configPath, `version: 1\naudit:\n  path: ${join(dir, 'audit.jsonl')}\nproviders:\n  grafana:\n    enabled: true\n    baseUrl: http://127.0.0.1:3000\n    prometheusUid: demo-prometheus\n    lokiUid: demo-loki\n`);
const client = new Client({ name: 'demo-smoke', version: '1.0.0' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['dist/index.js'],
  env: { ...process.env, OPS_LENS_CONFIG: configPath },
});

async function call(name, args) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(`${name} returned a tool error`);
  const output = result.structuredContent;
  if (!output?.examined || !Array.isArray(output.data)) throw new Error(`${name} lacks the expected result envelope`);
  return output;
}

try {
  await client.connect(transport);
  const dashboards = await call('grafana_search_dashboards', { query: 'Synthetic', limit: 10 });
  const metrics = await call('prometheus_instant', { query: 'demo_db_pool_in_use' });
  const hostMetric = await call('prometheus_instant', { query: 'node_load1{job="node-exporter"}' });
  const to = new Date();
  const from = new Date(to.getTime() - 10 * 60_000);
  const logs = await call('loki_logs', {
    selector: '{job="demo-api"}',
    query: '{job="demo-api"} |= "DB_POOL_SATURATED"',
    from: from.toISOString(),
    to: to.toISOString(),
    limit: 20,
  });
  if (dashboards.data.length < 1 || metrics.data.length < 1 || hostMetric.data.length < 1 || logs.data.length < 1) {
    throw new Error('Synthetic incident and demo host metrics were not available');
  }
  process.stdout.write(`${JSON.stringify({
    result: 'pass',
    dashboards: dashboards.examined.rowCount,
    metricRows: metrics.examined.rowCount,
    hostMetricRows: hostMetric.examined.rowCount,
    logRows: logs.examined.rowCount,
    lokiScannedBytes: logs.examined.byteCount,
  })}\n`);
} finally {
  await client.close();
  rmSync(dir, { recursive: true, force: true });
}
