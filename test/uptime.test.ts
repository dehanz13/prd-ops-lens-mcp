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
  http.get(`${base}/api/status-page/heartbeat/demo`, () => {
    const response = structuredClone(heartbeatFixture.response);
    response.heartbeatList['7'][1]!.time = new Date().toISOString();
    return HttpResponse.json(response);
  }),
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
      state: 'available', monitors: [{ state: 'up', uptime24h: 0.98, observedAt: expect.any(String) }, { state: 'unknown' }],
      incidents: [{ status: 'active', createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:15:00.000Z' }],
    }, examined: { rowCount: 3 } });
    const serialized = JSON.stringify(result);
    for (const planted of ['node.private.example', 'queue.private.example', 'private-css-marker',
      'private-analytics-marker', 'private-tag-marker', 'private-content-marker', '/health']) {
      expect(serialized).not.toContain(planted);
    }
    expect(readFileSync(fixture.auditPath, 'utf8').trim().split('\n')).toHaveLength(1);
  } finally { await fixture.close(); }
});

it('does not report a stale up heartbeat as current health', async () => {
  mockServer.use(http.get(`${base}/api/status-page/heartbeat/demo`, () => {
    const response = structuredClone(heartbeatFixture.response);
    response.heartbeatList['7'][1]!.time = new Date(Date.now() - 3_600_000).toISOString();
    return HttpResponse.json(response);
  }));
  const fixture = await harness();
  try {
    const result = await fixture.client.callTool({ name: 'uptime_status', arguments: {} });
    expect(result.structuredContent).toMatchObject({
      examined: { warnings: expect.arrayContaining(['A monitor heartbeat is stale or future-dated']) },
    });
    const monitors = (result.structuredContent as { data: { monitors: Array<{ state: string }> } }).data.monitors;
    expect(monitors[0]?.state).toBe('unknown');
  } finally { await fixture.close(); }
});

// @guardrail G3.2: Kuma's native timezone-free heartbeat clock is interpreted as UTC.
it('recognizes a fresh native Kuma heartbeat timestamp', async () => {
  const nativeTime = new Date().toISOString().slice(0, 19).replace('T', ' ');
  mockServer.use(http.get(`${base}/api/status-page/heartbeat/demo`, () => {
    const response = structuredClone(heartbeatFixture.response);
    response.heartbeatList['7'][1]!.time = nativeTime;
    return HttpResponse.json(response);
  }));
  const fixture = await harness();
  try {
    const result = await fixture.client.callTool({ name: 'uptime_status', arguments: {} });
    const monitors = (result.structuredContent as { data: { monitors: Array<{
      state: string; observedAt: string | null }> } }).data.monitors;
    expect(monitors[0]).toMatchObject({
      state: 'up', observedAt: `${nativeTime.replace(' ', 'T')}.000Z`,
    });
  } finally { await fixture.close(); }
});

it('redacts a bare monitor hostname wherever a public label repeats it', async () => {
  mockServer.use(http.get(`${base}/api/status-page/demo`, () => HttpResponse.json({
    config: { published: true },
    publicGroupList: [{ name: 'worker-internal', monitorList: [
      { id: 7, name: 'worker-internal', url: 'http://worker-internal:8080/health' }] }],
    incidents: [{ title: 'worker-internal unreachable', status: 'active' }],
  })));
  const fixture = await harness();
  try {
    const result = await fixture.client.callTool({ name: 'uptime_status', arguments: {} });
    expect(JSON.stringify(result)).not.toContain('worker-internal');
  } finally { await fixture.close(); }
});

it('returns not_published for an explicitly unpublished page', async () => {
  mockServer.use(http.get(`${base}/api/status-page/demo`, () => HttpResponse.json({
    config: { published: false }, incidents: [], publicGroupList: null,
  })));
  const fixture = await harness();
  try {
    const result = await fixture.client.callTool({ name: 'uptime_status', arguments: {} });
    expect(result.structuredContent).toMatchObject({ data: { state: 'not_published', monitors: [] },
      examined: { rowCount: 0 } });
  } finally { await fixture.close(); }
});

// @guardrail G7.5: VPS reachability comes only from public Kuma JSON and cannot default to healthy.
it('returns not_published when the public status-page route is 404', async () => {
  mockServer.use(http.get(`${base}/api/status-page/demo`, () => new HttpResponse(null, { status: 404 })));
  const fixture = await harness();
  try {
    const result = await fixture.client.callTool({ name: 'uptime_status', arguments: {} });
    expect(result.structuredContent).toMatchObject({ data: { state: 'not_published', monitors: [] },
      examined: { rowCount: 0 } });
    expect(result.isError).toBe(false);
  } finally { await fixture.close(); }
});

it('reports unknown when a published page has no heartbeat endpoint', async () => {
  mockServer.use(http.get(`${base}/api/status-page/heartbeat/demo`, () =>
    new HttpResponse(null, { status: 404 })));
  const fixture = await harness();
  try {
    const result = await fixture.client.callTool({ name: 'uptime_status', arguments: {} });
    expect(result.structuredContent).toMatchObject({ data: { state: 'unknown', monitors: [] },
      examined: { warnings: ['Public status page heartbeat data is unavailable'] } });
  } finally { await fixture.close(); }
});

it('returns not_published when Kuma serves its HTML fallback for a missing slug', async () => {
  mockServer.use(http.get(`${base}/api/status-page/demo`, () =>
    new HttpResponse('<!doctype html><title>Uptime Kuma</title>', {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    })));
  const fixture = await harness();
  try {
    const result = await fixture.client.callTool({ name: 'uptime_status', arguments: {} });
    expect(result.structuredContent).toMatchObject({ data: { state: 'not_published', monitors: [] } });
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

it('treats malformed incident data as unknown, never healthy', async () => {
  mockServer.use(http.get(`${base}/api/status-page/demo`, () => HttpResponse.json({
    config: { published: true }, incidents: null, publicGroupList: [],
  })));
  const fixture = await harness();
  try {
    const result = await fixture.client.callTool({ name: 'uptime_status', arguments: {} });
    expect(result.structuredContent).toMatchObject({ data: { state: 'unknown', monitors: [] },
      examined: { rowCount: 0 } });
  } finally { await fixture.close(); }
});
