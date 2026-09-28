import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'ops-lens-uptime-smoke-'));
const configPath = join(dir, 'config.yaml');
writeFileSync(configPath, `version: 1\naudit:\n  path: ${join(dir, 'audit.jsonl')}\nproviders:\n  uptime:\n    enabled: true\n    baseUrl: http://127.0.0.1:3001\n    slug: demo\n`, { mode: 0o600 });
const client = new Client({ name: 'uptime-demo-smoke', version: '1.0.0' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['dist/index.js'],
  env: { ...process.env, OPS_LENS_CONFIG: configPath },
});

try {
  await client.connect(transport);
  const result = await client.callTool({ name: 'uptime_status', arguments: {} });
  const data = result.structuredContent?.data;
  const examined = result.structuredContent?.examined;
  if (result.isError || data?.state !== 'available' || !Array.isArray(data.monitors) ||
    data.monitors.length < 1 || !examined || examined.rowCount < 1) {
    throw new Error('The synthetic Kuma demo page did not return an available, examined monitor');
  }
  const serialized = JSON.stringify(result.structuredContent);
  if (serialized.includes('demo-api:8080') || serialized.includes('/health')) {
    throw new Error('The synthetic monitor URL escaped the safe status projection');
  }
  process.stdout.write(`${JSON.stringify({ result: 'pass', state: data.state,
    monitorRows: data.monitors.length, examinedRows: examined.rowCount })}\n`);
} finally {
  await client.close();
  rmSync(dir, { recursive: true, force: true });
}
