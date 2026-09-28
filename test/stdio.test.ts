import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

it('starts as a child process and answers over stdio', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ops-lens-stdio-'));
  const configPath = join(dir, 'config.yaml');
  writeFileSync(configPath, `version: 1\naudit:\n  path: ${join(dir, 'audit.jsonl')}\n`);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', 'src/index.ts'],
    env: { ...process.env, OPS_LENS_CONFIG: configPath } as Record<string, string>,
  });
  const client = new Client({ name: 'stdio-test', version: '1.0.0' });
  await client.connect(transport);
  try {
    const result = await client.callTool({ name: 'server_status', arguments: {} });
    expect(result.structuredContent).toMatchObject({ examined: { provider: 'local' } });
  } finally {
    await client.close();
  }
});
