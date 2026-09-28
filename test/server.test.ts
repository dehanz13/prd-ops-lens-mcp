import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { ConfigSchema } from '../src/core/config.js';
import { createServer } from '../src/server.js';
import { examined, ToolResultSchema } from '../src/core/result.js';
import { runTool } from '../src/core/tool.js';
import type { ProviderModule } from '../src/providers/provider.js';
import { z } from 'zod';

it('serves a real MCP tool call with a structured examined block', async () => {
  const auditPath = join(mkdtempSync(join(tmpdir(), 'ops-lens-mcp-')), 'audit.jsonl');
  const config = ConfigSchema.parse({ version: 1, audit: { path: auditPath } });
  const server = createServer(config);
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toContain('server_status');
    const result = await client.callTool({ name: 'server_status', arguments: {} });
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({
      data: { name: 'prd-ops-lens-mcp', providers: [], writesEnabled: false },
      examined: { provider: 'local', rowCount: 0 },
    });
    expect(readFileSync(auditPath, 'utf8').trim().split('\n')).toHaveLength(1);
  } finally {
    await client.close();
    await server.close();
  }
});

it('registers a fake provider through the same module seam used by live providers', async () => {
  const auditPath = join(mkdtempSync(join(tmpdir(), 'ops-lens-mcp-')), 'audit.jsonl');
  const config = ConfigSchema.parse({ version: 1, audit: { path: auditPath } });
  const fake: ProviderModule = {
    id: 'fake',
    register(server, { runtime }) {
      server.registerTool('fake_ping', {
        inputSchema: z.object({}), outputSchema: ToolResultSchema,
      }, async (parameters) => runTool(runtime, 'fake_ping', 'fake', parameters,
        async () => ({ data: { ok: true }, examined: examined('fake', 'synthetic ping', { rowCount: 1 }) })));
    },
  };
  const server = createServer(config, [fake]);
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const result = await client.callTool({ name: 'fake_ping', arguments: {} });
    expect(result.structuredContent).toMatchObject({ data: { ok: true }, examined: { rowCount: 1 } });
  } finally {
    await client.close();
    await server.close();
  }
});
