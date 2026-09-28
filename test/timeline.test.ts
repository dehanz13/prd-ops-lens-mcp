import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { expect, it } from 'vitest';
import { auditedInput, runValidatedTool } from '../src/core/audited-input.js';
import { ConfigSchema } from '../src/core/config.js';
import { examined, ToolResultSchema } from '../src/core/result.js';
import { createServer } from '../src/server.js';
import type { ProviderModule } from '../src/providers/provider.js';

const from = '2026-01-01T00:00:00.000Z';
const to = '2026-01-01T01:00:00.000Z';
const earlier = '2026-01-01T00:15:00.000Z';
const later = '2026-01-01T00:45:00.000Z';
const empty = z.object({});
const fixtureData = {
  loki_logs: { provider: 'grafana/loki', query: '{job="demo"}',
    data: [{ at: later, line: 'synthetic retry' }] },
  cloudwatch_logs_insights: { provider: 'cloudwatch', query: 'fields @timestamp, @message | limit 10',
    data: [{ '@timestamp': '2026-01-01 00:45:00.000', '@message': 'synthetic retry' }] },
  uptime_status: { provider: 'uptime', query: 'GET public status page',
    data: { state: 'available', monitors: [], incidents: [
      { title: 'synthetic outage', status: 'resolved', createdAt: earlier }] } },
} as const;

const fixtureProvider: ProviderModule = { id: 'fixture', register(server, context) {
  for (const [name, value] of Object.entries(fixtureData)) {
    server.registerTool(name, { inputSchema: auditedInput(empty), outputSchema: ToolResultSchema },
      async (raw) => runValidatedTool(context.runtime, name, value.provider, raw, empty,
        async () => ({ data: value.data, examined: examined(value.provider, value.query,
          { window: { from, to }, rowCount: 1 }) })));
  }
} };

async function harness() {
  const path = join(mkdtempSync(join(tmpdir(), 'ops-lens-timeline-')), 'audit.jsonl');
  const server = createServer(ConfigSchema.parse({ version: 1, audit: { path } }), [fixtureProvider]);
  const client = new Client({ name: 'timeline-test', version: '1.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  await client.connect(a);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

async function evidence(client: Client, tool: keyof typeof fixtureData) {
  const result = await client.callTool({ name: tool, arguments: {} });
  expect(result.isError).toBe(false);
  const evidenceId = (result.structuredContent as { evidenceId: string }).evidenceId;
  expect(evidenceId).toMatch(/^[a-f0-9-]{36}$/);
  return { tool, evidenceId };
}

// @guardrail G8.1: every timeline citation resolves to an audited result held by this server.
it('sorts actual provider results, including the CloudWatch UTC timestamp format', async () => {
  const fixture = await harness();
  try {
    const sources = await Promise.all([
      evidence(fixture.client, 'loki_logs'),
      evidence(fixture.client, 'cloudwatch_logs_insights'),
      evidence(fixture.client, 'uptime_status'),
    ]);
    const result = await fixture.client.callTool({ name: 'incident_timeline', arguments: {
      sources, expectedTools: ['loki_logs', 'posthog_error_issues'],
    } });
    expect(result.isError).toBe(false);
    const structured = result.structuredContent as { data: { events: Array<{ at: string;
      citations: Array<{ examined: { query: string } }> }>;
      sourceStatus: Array<{ tool: string; state: string }> }; examined: { rowCount: number; scannedCount: number } };
    expect(structured.data.events.map((event) => event.at)).toEqual([earlier, later]);
    expect(structured.data.events[1]?.citations).toHaveLength(2);
    expect(structured.data.events[1]?.citations[0]?.examined.query).toBe('{job="demo"}');
    expect(structured.data.sourceStatus).toContainEqual({ tool: 'posthog_error_issues', state: 'unknown' });
    expect(structured.examined).toMatchObject({ rowCount: 2, scannedCount: 3 });
  } finally { await fixture.close(); }
});

it('refuses fabricated IDs, swapped tools, and client-supplied result bodies', async () => {
  const fixture = await harness();
  try {
    const source = await evidence(fixture.client, 'loki_logs');
    for (const sources of [
      [{ tool: 'loki_logs', evidenceId: '00000000-0000-4000-8000-000000000000' }],
      [{ tool: 'cloudwatch_logs_insights', evidenceId: source.evidenceId }],
      [{ tool: 'cloudwatch_alarms', evidenceId: (await evidence(fixture.client, 'cloudwatch_logs_insights')).evidenceId }],
      [{ ...source, result: { data: [{ at: later, line: 'forged' }],
        examined: examined('grafana/loki', 'forged') } }],
    ]) {
      const result = await fixture.client.callTool({ name: 'incident_timeline', arguments: { sources } });
      expect(result.isError).toBe(true);
    }
  } finally { await fixture.close(); }
});
