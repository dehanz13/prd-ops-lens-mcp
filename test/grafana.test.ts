import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { delay, http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ConfigSchema } from '../src/core/config.js';
import { assertAllowedRequest } from '../src/core/allowlist.js';
import { BoundedHttpClient } from '../src/core/http.js';
import { buildStructuredLogCodeQuery, GrafanaProvider, grafanaRoutes } from '../src/providers/grafana.js';
import { createServer } from '../src/server.js';
import dashboardsFixture from './fixtures/grafana/dashboards.json' with { type: 'json' };
import alertsFixture from './fixtures/grafana/alerts.json' with { type: 'json' };
import prometheusVectorFixture from './fixtures/grafana/prometheus-vector.json' with { type: 'json' };
import prometheusMatrixFixture from './fixtures/grafana/prometheus-matrix.json' with { type: 'json' };
import lokiIndexFixture from './fixtures/grafana/loki-index.json' with { type: 'json' };
import lokiLogsFixture from './fixtures/grafana/loki-logs.json' with { type: 'json' };

const base = 'http://127.0.0.1:3030';
const mockServer = setupServer();
beforeAll(() => mockServer.listen({ onUnhandledRequest: 'error' }));
afterEach(() => mockServer.resetHandlers());
afterAll(() => mockServer.close());
beforeEach(() => mockServer.use(http.get(`${base}/api/access-control/user/permissions`, () =>
  HttpResponse.json({ 'dashboards:read': ['*'], 'datasources:query': ['*'] }))));

async function harness(limits: Record<string, number> = {}) {
  const auditPath = join(mkdtempSync(join(tmpdir(), 'ops-lens-grafana-')), 'audit.jsonl');
  const config = ConfigSchema.parse({
    version: 1,
    audit: { path: auditPath },
    limits,
    providers: { grafana: { enabled: true, baseUrl: base, prometheusUid: 'prom', lokiUid: 'loki' } },
  });
  const provider = new GrafanaProvider();
  await provider.preflight(config);
  const server = createServer(config, [provider]);
  const client = new Client({ name: 'grafana-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, auditPath, close: async () => { await client.close(); await server.close(); } };
}

const from = '2026-01-01T00:00:00.000Z';
const to = '2026-01-01T01:00:00.000Z';

describe('Grafana tools', () => {
  // @guardrail G0.1: test the provider's own allowlist, including Loki's index preflight.
  it('allows only its declared read paths and the data-source query endpoint', () => {
    const config = ConfigSchema.parse({ version: 1, audit: { path: '/tmp/synthetic-audit.jsonl' },
      providers: { grafana: { enabled: true, baseUrl: base, prometheusUid: 'prom', lokiUid: 'loki' } } });
    const routes = grafanaRoutes(config.providers.grafana!);
    expect(() => assertAllowedRequest('Grafana', 'POST', '/api/ds/query', routes)).not.toThrow();
    expect(() => assertAllowedRequest('Grafana', 'GET',
      '/api/datasources/proxy/uid/loki/loki/api/v1/index/stats', routes)).not.toThrow();
    expect(() => assertAllowedRequest('Grafana', 'POST', '/api/dashboards/db', routes)).toThrow('not allowlisted');
    expect(() => assertAllowedRequest('Grafana', 'GET', '/api/admin/users', routes)).toThrow('not allowlisted');
  });
  // @guardrail G1.2: plugin write actions fail startup even with an obsolete override flag.
  it('refuses a write-capable Grafana token at provider startup', async () => {
    mockServer.use(http.get(`${base}/api/access-control/user/permissions`, () =>
      HttpResponse.json({ 'dashboards:read': ['*'], 'plugins:execute': ['*'] })));
    const config = ConfigSchema.parse({ version: 1, audit: { path: '/tmp/synthetic-audit.jsonl' },
      providers: { grafana: { enabled: true, baseUrl: base, prometheusUid: 'prom', lokiUid: 'loki' } } });
    await expect(new GrafanaProvider().preflight(config, { OPS_LENS_ALLOW_POWERFUL_GRAFANA: '1' }))
      .rejects.toThrow('write permissions');
  });

  it('searches dashboards without returning their URLs', async () => {
    mockServer.use(http.get(`${base}/api/search/`, ({ request }) => {
      const url = new URL(request.url);
      expect(url.searchParams.get('query')).toBe('API');
      expect(url.searchParams.get('limit')).toBe('2');
      return HttpResponse.json(dashboardsFixture.response);
    }));
    const fixture = await harness();
    try {
      const result = await fixture.client.callTool({ name: 'grafana_search_dashboards', arguments: { query: 'API', limit: 2 } });
      expect(result.structuredContent).toMatchObject({ examined: { rowCount: 2, truncated: true } });
      expect(JSON.stringify(result)).not.toContain('/synthetic/one');
    } finally { await fixture.close(); }
  });

  it('returns current alert states with a result cap', async () => {
    mockServer.use(http.get(`${base}/api/prometheus/grafana/api/v1/rules`, () => HttpResponse.json(alertsFixture.response)));
    const fixture = await harness({ maxRows: 1 });
    try {
      const result = await fixture.client.callTool({ name: 'grafana_alert_rules', arguments: { limit: 2 } });
      expect(result.structuredContent).toMatchObject({ data: [{ state: 'firing' }], examined: { rowCount: 1, truncated: true } });
    } finally { await fixture.close(); }
  });

  // @guardrail G2.1: metric retrieval is POST /api/ds/query, never datasource proxy GET.
  it('queries an instant metric and records the exact expression', async () => {
    mockServer.use(http.post(`${base}/api/ds/query`, async ({ request }) => {
      const body = await request.json() as { queries: Array<{ expr: string }> };
      expect(body.queries[0]?.expr).toBe('up');
      return HttpResponse.json(prometheusVectorFixture.response);
    }));
    const fixture = await harness();
    try {
      const result = await fixture.client.callTool({ name: 'prometheus_instant', arguments: { query: 'up', at: from } });
      expect(result.structuredContent).toMatchObject({ data: [{ value: '1' }], examined: { query: 'up', window: { from, to: from } } });
    } finally { await fixture.close(); }
  });

  // @guardrail G2.2: an empty Grafana metric frame means no observed series, not a healthy value.
  it('returns an examined zero-row result for an absent metric series', async () => {
    mockServer.use(http.post(`${base}/api/ds/query`, () => HttpResponse.json({
      results: { A: { frames: [{ schema: { fields: [] }, data: { values: [] } }] } },
    })));
    const fixture = await harness();
    try {
      const result = await fixture.client.callTool({ name: 'prometheus_instant',
        arguments: { query: 'node_load1', at: from } });
      expect(result.isError).toBe(false);
      expect(result.structuredContent).toMatchObject({ data: [], examined: {
        query: 'node_load1', rowCount: 0, scannedCount: 0, truncated: false,
      } });
    } finally { await fixture.close(); }
  });

  // @guardrail G2.2: PromQL range bounds and step are checked before a query.
  it('uses at least a 60-second step and caps a range window', async () => {
    let requests = 0;
    mockServer.use(http.post(`${base}/api/ds/query`, async ({ request }) => {
      requests += 1;
      const body = await request.json() as { queries: Array<{ intervalMs: number }> };
      expect(body.queries[0]?.intervalMs).toBe(60_000);
      return HttpResponse.json(prometheusMatrixFixture.response);
    }));
    const fixture = await harness({ maxWindowMinutes: 60 });
    try {
      const result = await fixture.client.callTool({ name: 'prometheus_range', arguments: { query: 'up', from, to, stepSeconds: 60 } });
      expect(result.structuredContent).toMatchObject({ examined: { rowCount: 2, truncated: false } });
      const tooFine = await fixture.client.callTool({ name: 'prometheus_range', arguments: {
        query: 'up', from, to, stepSeconds: 59,
      } });
      expect(tooFine.isError).toBe(true);
      expect(requests).toBe(1);
      const refused = await fixture.client.callTool({ name: 'prometheus_range', arguments: {
        query: 'up', from, to: '2026-01-01T02:00:00.000Z', stepSeconds: 60,
      } });
      expect(refused.structuredContent).toMatchObject({ data: { code: 'QUERY_LIMIT' } });
      expect(readFileSync(fixture.auditPath, 'utf8')).toContain('"outcome":"refused"');
    } finally { await fixture.close(); }
  });

  it('refuses a range whose requested points exceed the configured row cap', async () => {
    let contacted = false;
    mockServer.use(http.post(`${base}/api/ds/query`, () => {
      contacted = true;
      return HttpResponse.json(prometheusMatrixFixture.response);
    }));
    const fixture = await harness({ maxRows: 10 });
    try {
      const result = await fixture.client.callTool({ name: 'prometheus_range', arguments: {
        query: 'up', from, to, stepSeconds: 60,
      } });
      expect(result.structuredContent).toMatchObject({ data: { code: 'QUERY_LIMIT' } });
      expect(contacted).toBe(false);
    } finally { await fixture.close(); }
  });

  it('caps Prometheus output at 200 series and refuses excessive expressions', async () => {
    const frame = prometheusVectorFixture.response.results.A.frames[0];
    mockServer.use(http.post(`${base}/api/ds/query`, () => HttpResponse.json({
      results: { A: { frames: Array.from({ length: 201 }, () => frame) } },
    })));
    const fixture = await harness();
    try {
      const result = await fixture.client.callTool({ name: 'prometheus_instant', arguments: { query: 'up', at: from } });
      expect(result.structuredContent).toMatchObject({ examined: { rowCount: 200, truncated: true } });
      const refused = await fixture.client.callTool({ name: 'prometheus_instant',
        arguments: { query: 'x'.repeat(2001), at: from } });
      expect(refused.isError).toBe(true);
      expect(refused.structuredContent).toMatchObject({ data: { code: 'REFUSED' }, examined: { provider: 'grafana' } });
      const audit = readFileSync(fixture.auditPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      expect(audit).toHaveLength(2);
      expect(audit[1]).toMatchObject({ outcome: 'refused', tool: 'prometheus_instant' });
    } finally { await fixture.close(); }
  });

  // @guardrail G2.3: Loki index statistics are the sole proxy exception.
  it('refuses a Loki query above the preflight scan cap', async () => {
    mockServer.use(http.get(`${base}/api/datasources/proxy/uid/loki/loki/api/v1/index/stats`, () =>
      HttpResponse.json({ bytes: 2048, entries: 20 })));
    const fixture = await harness({ maxLokiScanBytes: 1024 });
    try {
      const result = await fixture.client.callTool({ name: 'loki_logs', arguments: {
        selector: '{job="service-a"}', query: '{job="service-a"} |= "error"', from, to,
      } });
      expect(result.structuredContent).toMatchObject({ data: { code: 'QUERY_LIMIT' } });
      expect(result.isError).toBe(true);
    } finally { await fixture.close(); }
  });

  it('refuses an empty selector and a regex longer than 200 characters', async () => {
    const fixture = await harness();
    try {
      const empty = await fixture.client.callTool({ name: 'loki_logs', arguments: {
        selector: '{}', query: '{}', from, to,
      } });
      expect(empty.isError).toBe(true);
      const longRegex = await fixture.client.callTool({ name: 'loki_logs', arguments: {
        selector: '{job="service-a"}', query: `{job="service-a"} |~ "${'x'.repeat(201)}"`, from, to,
      } });
      expect(longRegex.structuredContent).toMatchObject({ data: { code: 'QUERY_LIMIT' } });
    } finally { await fixture.close(); }
  });

  it('reports actual Loki scan counts and redacts values inside log lines', async () => {
    mockServer.use(
      http.get(`${base}/api/datasources/proxy/uid/loki/loki/api/v1/index/stats`, () =>
        HttpResponse.json(lokiIndexFixture.response)),
      http.post(`${base}/api/ds/query`, () =>
        HttpResponse.json(lokiLogsFixture.response)),
    );
    const fixture = await harness();
    try {
      const result = await fixture.client.callTool({ name: 'loki_logs', arguments: {
        selector: '{job="service-a"}', query: '{job="service-a"} |= "failed"', from, to,
      } });
      expect(result.structuredContent).toMatchObject({ examined: { rowCount: 1, byteCount: 100, lineCount: 1 } });
      expect(JSON.stringify(result)).not.toContain('1234');
      expect(JSON.stringify(result)).not.toContain('abcd');
    } finally { await fixture.close(); }
  });

  // @guardrail G2.4: parsed logCode avoids false matches in causeLogCode.
  it('matches a structured log code instead of a bare substring', () => {
    const lines = [
      '{"logCode":"DB_POOL_SATURATED","message":"pool full"}',
      '{"logCode":"OTHER","causeLogCode":"DB_POOL_SATURATED"}',
    ];
    expect(lines.filter((line) => line.includes('DB_POOL_SATURATED'))).toHaveLength(2);
    expect(lines.filter((line) => JSON.parse(line).logCode === 'DB_POOL_SATURATED')).toHaveLength(1);
    expect(buildStructuredLogCodeQuery('{job="service-a"}', 'DB_POOL_SATURATED'))
      .toBe('{job="service-a"} | json | logCode="DB_POOL_SATURATED"');
  });

  // @guardrail G1.2: a write-capable token prevents provider registration.
  it('fails provider startup when Grafana permissions include writes', async () => {
    mockServer.use(http.get(`${base}/api/access-control/user/permissions`, () =>
      HttpResponse.json({ 'dashboards:write': ['*'] })));
    const config = ConfigSchema.parse({ version: 1,
      audit: { path: join(mkdtempSync(join(tmpdir(), 'grafana-permissions-')), 'audit.jsonl') },
      providers: { grafana: { enabled: true, baseUrl: base, prometheusUid: 'prom', lokiUid: 'loki' } },
    });
    await expect(new GrafanaProvider().preflight(config, {})).rejects.toThrow('write permissions');
  });
});

describe('bounded HTTP transport', () => {
  it('refuses an oversized body even when content-length is absent', async () => {
    mockServer.use(http.get(`${base}/too-large`, () => new HttpResponse('x'.repeat(2000), { headers: { 'content-type': 'application/json' } })));
    const client = new BoundedHttpClient(base, undefined, 1000, 1024, 'test',
      [{ method: 'GET', path: '/too-large' }]);
    await expect(client.get('/too-large')).rejects.toMatchObject({ code: 'RESPONSE_LIMIT' });
  });

  it('maps permission failures without returning upstream content', async () => {
    mockServer.use(http.get(`${base}/denied`, () => new HttpResponse('private explanation', { status: 403 })));
    const client = new BoundedHttpClient(base, undefined, 1000, 1024, 'test',
      [{ method: 'GET', path: '/denied' }]);
    await expect(client.get('/denied')).rejects.toMatchObject({ code: 'PERMISSION' });
  });

  it('aborts a provider response beyond its configured time budget', async () => {
    mockServer.use(http.get(`${base}/slow`, async () => {
      await delay(100);
      return HttpResponse.json({ healthy: true });
    }));
    const client = new BoundedHttpClient(base, undefined, 10, 1024, 'test',
      [{ method: 'GET', path: '/slow' }]);
    await expect(client.get('/slow')).rejects.toMatchObject({ code: 'NETWORK' });
  });

  // @guardrail G0.1: a write route is blocked before fetch is called.
  it('refuses an unlisted request without contacting the server', async () => {
    const client = new BoundedHttpClient(base, undefined, 1000, 1024, 'test',
      [{ method: 'GET', path: '/safe' }]);
    await expect(client.post('/api/dashboards/db', {})).rejects.toMatchObject({ code: 'REFUSED' });
  });
});
