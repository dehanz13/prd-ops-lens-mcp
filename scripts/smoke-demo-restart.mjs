import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import YAML from 'yaml';
import { DockerDesktopDemoApi } from '../dist/restart/demo-docker.js';

const socket = join(homedir(), '.docker/run/docker.sock');
const api = new DockerDesktopDemoApi(socket);
const daemonId = await api.identity();
const before = await api.inspect();
if (await api.health() !== 'healthy') throw new Error('The local demo API is not healthy before the restart');
if (!before.lastStartedAt || Date.now() - Date.parse(before.lastStartedAt) < 600_000) {
  throw new Error('The local demo container is inside its ten-minute cooldown');
}

const dir = mkdtempSync(join(tmpdir(), 'ops-lens-restart-smoke-'));
const auditPath = join(dir, 'audit.jsonl');
const configPath = join(dir, 'config.yaml');
writeFileSync(configPath, YAML.stringify({
  version: 1,
  audit: { path: auditPath },
  writes: {
    enabled: true, demoOnly: true, containers: ['demo-api'],
    dockerSocket: socket, expectedDaemonId: daemonId,
    killSwitchFile: join(dir, 'stop'), deployLockFile: join(dir, 'deploy-lock'),
  },
}), { mode: 0o600 });
const client = new Client({ name: 'demo-restart-smoke', version: '1.0.0' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['dist/index.js'],
  env: { PATH: process.env.PATH ?? '', HOME: homedir(), OPS_LENS_CONFIG: configPath,
    OPS_LENS_ENABLE_WRITES: '1' },
});

try {
  await client.connect(transport);
  const plan = await client.callTool({ name: 'plan_restart', arguments: { container: 'demo-api' } });
  if (plan.isError) throw new Error('Local demo restart plan was refused');
  const token = plan.structuredContent?.data?.confirmation;
  if (typeof token !== 'string' || token.length !== 24) throw new Error('Confirmation was missing');
  const reason = 'Synthetic local demo recovery check';
  const confirm = await client.callTool({ name: 'restart_container', arguments: {
    container: 'demo-api', token, reason,
  } });
  if (confirm.isError || confirm.structuredContent?.data?.beforeHealth !== 'healthy' ||
    confirm.structuredContent?.data?.afterHealth !== 'healthy') {
    throw new Error('Local demo restart did not report healthy before and after states');
  }
  const replay = await client.callTool({ name: 'restart_container', arguments: {
    container: 'demo-api', token, reason,
  } });
  if (!replay.isError || replay.structuredContent?.data?.code !== 'REFUSED') {
    throw new Error('Confirmation replay was not refused');
  }
  const after = await api.inspect();
  if (after.id !== before.id || after.lastStartedAt === before.lastStartedAt) {
    throw new Error('The demo target did not show a changed start time');
  }
  const entries = readFileSync(auditPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  if (entries.length !== 3 || entries[2].outcome !== 'refused') {
    throw new Error('The restart audit did not record all three attempts');
  }
  process.stdout.write(`${JSON.stringify({ result: 'pass', target: 'demo-api',
    healthyBefore: true, healthyAfter: true, replayRefused: true, auditedAttempts: entries.length })}\n`);
} finally {
  await client.close();
  rmSync(dir, { recursive: true, force: true });
}
