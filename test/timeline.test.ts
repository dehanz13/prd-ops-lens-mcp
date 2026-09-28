import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { ConfigSchema } from '../src/core/config.js';
import { examined } from '../src/core/result.js';
import { createServer } from '../src/server.js';

async function harness() {
  const path = join(mkdtempSync(join(tmpdir(), 'ops-lens-timeline-')), 'audit.jsonl');
  const server = createServer(ConfigSchema.parse({ version: 1, audit: { path } }));
  const client = new Client({ name: 'timeline-test', version: '1.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  await client.connect(a);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

const from = '2026-01-01T00:00:00.000Z';
const to = '2026-01-01T01:00:00.000Z';
const earlier = '2026-01-01T00:15:00.000Z';
const later = '2026-01-01T00:45:00.000Z';

// @guardrail G8.1: every timeline event cites the supplied source query and missing sources stay unknown.
it('sorts and deduplicates only supplied events with exact examined citations', async () => {
  const fixture = await harness();
  try {
    const result = await fixture.client.callTool({ name: 'incident_timeline', arguments: {
      sources: [
        { tool: 'loki_logs', result: { data: [{ at: later, line: 'synthetic retry' }],
          examined: examined('grafana/loki', '{job="demo"}', { window: { from, to }, rowCount: 1 }) } },
        { tool: 'cloudwatch_logs_insights', result: { data: [{ '@timestamp': later,
          '@message': 'synthetic retry' }], examined: examined('cloudwatch', 'fields @timestamp, @message | limit 10',
          { window: { from, to }, rowCount: 1 }) } },
        { tool: 'uptime_status', result: { data: { state: 'available', monitors: [],
          incidents: [{ title: 'synthetic outage', status: 'resolved', createdAt: earlier }] },
        examined: examined('uptime', 'GET public status page', { window: { from, to }, rowCount: 1 }) } },
      ], expectedTools: ['loki_logs', 'posthog_error_issues'],
    } });
    expect(result.isError).toBe(false);
    const structured = result.structuredContent as { data: { events: Array<{ at: string;
      citations: Array<{ examined: { query: string } }> }>;
      sourceStatus: Array<{ tool: string; state: string }> }; examined: { rowCount: number; scannedCount: number } };
    const data = structured.data;
    expect(data.events.map((event) => event.at)).toEqual([earlier, later]);
    expect(data.events[1]?.citations).toHaveLength(2);
    expect(data.events[1]?.citations[0]?.examined.query).toBe('{job="demo"}');
    expect(data.sourceStatus).toContainEqual({ tool: 'posthog_error_issues', state: 'unknown' });
    expect(structured.examined).toMatchObject({ rowCount: 2, scannedCount: 3 });
  } finally { await fixture.close(); }
});

it('refuses mismatched provenance and invents no event from missing timestamps', async () => {
  const fixture = await harness();
  try {
    const empty = await fixture.client.callTool({ name: 'incident_timeline', arguments: {
      sources: [{ tool: 'cloudwatch_alarms', result: { data: [{ name: 'synthetic', state: 'ALARM' }],
        examined: examined('cloudwatch', 'DescribeAlarms', { rowCount: 1 }) } }],
    } });
    expect(empty.structuredContent).toMatchObject({ data: { events: [] }, examined: { rowCount: 0 } });
    const refused = await fixture.client.callTool({ name: 'incident_timeline', arguments: {
      sources: [{ tool: 'loki_logs', result: { data: [{ at: later, line: 'synthetic retry' }],
        examined: examined('posthog', 'forged query', { rowCount: 1 }) } }],
    } });
    expect(refused.isError).toBe(true);
    expect(refused.structuredContent).toMatchObject({ data: { code: 'REFUSED' } });
  } finally { await fixture.close(); }
});
