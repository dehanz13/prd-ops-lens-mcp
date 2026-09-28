import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { assertAllowedRequest } from '../src/core/allowlist.js';
import { ConfigSchema } from '../src/core/config.js';
import { UptimeProvider, uptimeRoutes } from '../src/providers/uptime.js';
import { createServer } from '../src/server.js';
import pageFixture from './fixtures/uptime/page.json' with { type: 'json' };
import heartbeatFixture from './fixtures/uptime/heartbeats.json' with { type: 'json' };

const base = 'http://127.0.0.1:3040';
const mockServer = setupServer();
beforeAll(() => mockServer.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => mockServer.use(
  http.get(`${base}/api/status-page/demo`, () => HttpResponse.json(pageFixture.response)),
  http.get(`${base}/api/status-page/heartbeat/demo`, () => HttpResponse.json(heartbeatFixture.response)),
));
afterEach(() => mockServer.resetHandlers());
afterAll(() => mockServer.close());

async function harness() {
  const auditPath = join(mkdtempSync(join(tmpdir(), 'ops-uptime-')), 'audit.jsonl');
  const config = ConfigSchema.parse({ version: 1, audit: { path: auditPath },
    providers: { uptime: { enabled: true, baseUrl: base, slug: 'demo' } },
  });
  const server = createServer(config, [new UptimeProvider()]);
  const client = new Client({ name: 'uptime-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, auditPath, close: async () => { await client.close(); await server.close(); } };
}

// @guardrail G3.1: only the two public status-page GET endpoints are permitted.
it('allows public status JSON and refuses login or admin routes', () => {
  const routes = uptimeRoutes('demo');
  expect(() => assertAllowedRequest('uptime', 'GET', '/api/status-page/demo', routes)).not.toThrow();
  expect(() => assertAllowedRequest('uptime', 'GET', '/api/status-page/heartbeat/demo', routes)).not.toThrow();
  expect(() => assertAllowedRequest('uptime', 'POST', '/api/login', routes)).toThrow('not allowlisted');
  expect(() => assertAllowedRequest('uptime', 'GET', '/api/status-page/other', routes)).toThrow('not allowlisted');
});

// @guardrail G3.2: newest heartbeat is last and URL, host, config, tags, content never escape.
it('projects safe monitor and incident fields with the newest heartbeat', async () => {
  const fixture = await harness();
  try {
    const result = await fixture.client.callTool({ name: 'uptime_status', arguments: {} });
    expect(result.structuredContent).toMatchObject({ data: {
      state: 'available', monitors: [{ state: 'up', uptime24h: 0.98, observedAt: null }, { state: 'unknown' }],
      incidents: [{ status: 'active' }],
    }, examined: { rowCount: 3 } });
    const serialized = JSON.stringify(result);
    for (const planted of ['node.private.example', 'queue.private.example', 'private-css-marker',
      'private-analytics-marker', 'private-tag-marker', 'private-content-marker', '/health']) {
      expect(serialized).not.toContain(planted);
    }
    expect(readFileSync(fixture.auditPath, 'utf8').trim().split('\n')).toHaveLength(1);
  } finally { await fixture.close(); }
});

it('treats unpublished or incomplete pages as unknown, never up', async () => {
  mockServer.use(http.get(`${base}/api/status-page/demo`, () => HttpResponse.json({
    config: { published: false }, incidents: [], publicGroupList: null,
  })));
  const fixture = await harness();
  try {
    const result = await fixture.client.callTool({ name: 'uptime_status', arguments: {} });
    expect(result.structuredContent).toMatchObject({ data: { state: 'unknown', monitors: [] },
      examined: { rowCount: 0 } });
  } finally { await fixture.close(); }
});

it('treats a missing heartbeat list as unknown, never up', async () => {
  mockServer.use(http.get(`${base}/api/status-page/heartbeat/demo`, () => HttpResponse.json({ uptimeList: {} })));
  const fixture = await harness();
  try {
    const result = await fixture.client.callTool({ name: 'uptime_status', arguments: {} });
    expect(result.structuredContent).toMatchObject({ data: { state: 'unknown', monitors: [] } });
  } finally { await fixture.close(); }
});
