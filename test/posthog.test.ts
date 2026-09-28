import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { assertAllowedRequest } from '../src/core/allowlist.js';
import { ConfigSchema } from '../src/core/config.js';
import { PostHogProvider, posthogRoutes } from '../src/providers/posthog.js';
import { boundedHogql } from '../src/providers/posthog-query.js';
import { createServer } from '../src/server.js';

const base = 'http://127.0.0.1:3050';
const readScopes = ['query:read', 'insight:read', 'error_tracking:read', 'feature_flag:read'];
const mock = setupServer();
beforeAll(() => mock.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => mock.use(
  http.get(`${base}/api/personal_api_keys/@current/`, () => HttpResponse.json({
    scopes: readScopes, scoped_teams: [123], scoped_organizations: [],
    value: 'never-expose-this',
  })),
  http.post(`${base}/api/projects/123/query/`, async ({ request }) => {
    const body = await request.json() as { query: { kind: string; query: string } };
    expect(body.query.kind).toBe('HogQLQuery');
    expect(body.query.query).toContain('timestamp >= toDateTime');
    expect(body.query.query).toContain('LIMIT 10');
    return HttpResponse.json({ columns: ['event', 'count'],
      results: [['demo_event', 3]], hasMore: false });
  }),
  http.get(`${base}/api/projects/123/insights/7/`, () => HttpResponse.json({
    id: 7, short_id: 'synthetic', insight: 'TRENDS', name: 'Private user name',
    created_by: { email: 'person@example.invalid' }, last_refresh: '2026-01-01T00:00:00Z',
  })),
  http.get(`${base}/api/projects/123/error_tracking/issues/`, () => HttpResponse.json({
    count: 1, next: null, results: [{ id: 'synthetic-issue-id', name: 'Private user name',
      status: 'active', severity: 'high', description: 'person@example.invalid',
      first_seen: '2026-01-02T00:00:00Z' }],
  })),
  http.get(`${base}/api/projects/123/feature_flags/8/`, () => HttpResponse.json({
    id: 8, key: 'private-targeting-rule', active: true, archived: false,
    filters: { groups: [{ properties: [{ value: 'person@example.invalid' }] }] },
  })),
));
afterEach(() => mock.resetHandlers());
afterAll(() => mock.close());

function config() {
  const directory = mkdtempSync(join(tmpdir(), 'ops-posthog-'));
  const tokenFile = join(directory, 'posthog.token');
  writeFileSync(tokenFile, 'synthetic-token', { mode: 0o600 });
  const auditPath = join(directory, 'audit.jsonl');
  return { auditPath, value: ConfigSchema.parse({ version: 1, audit: { path: auditPath },
    limits: { maxRows: 10, maxWindowMinutes: 60 },
    providers: { posthog: { enabled: true, baseUrl: base, tokenFile, projectIds: [123] } },
  }) };
}

async function harness() {
  const { auditPath, value } = config();
  const provider = new PostHogProvider();
  await provider.preflight(value);
  const server = createServer(value, [provider]);
  const client = new Client({ name: 'posthog-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, auditPath, close: async () => { await client.close(); await server.close(); } };
}

// @guardrail G6.1: SQL remains one event-only SELECT with bounded rows and a UTC window.
it('rejects mutation, nested, broad, and excessive HogQL before network access', () => {
  const from = '2026-01-01T00:00:00Z'; const to = '2026-01-01T00:10:00Z';
  expect(boundedHogql('SELECT event, count(*) FROM events GROUP BY event', from, to, 10, 60).query)
    .toContain('LIMIT 10');
  expect(() => boundedHogql('SELECT event FROM events',
    '2026-01-01T00:00:00.9009Z', '2026-01-01T00:01:00.1259Z', 10, 60))
    .toThrow('UTC window is invalid');
  expect(boundedHogql("SELECT event FROM events WHERE event = 'a' OR event = 'b'", from, to, 10, 60).query)
    .toContain("WHERE (event = 'a' OR event = 'b') AND timestamp");
  for (const query of ['DELETE FROM events', 'SELECT * FROM events',
    'SELECT event FROM events; DROP TABLE events',
    'SELECT event FROM events UNION SELECT email FROM persons',
    'SELECT properties FROM events', 'SELECT event FROM events LIMIT 11',
    'SELECT event FROM events -- hidden', 'SELECT event FROM events JOIN persons ON 1=1',
    "SELECT event FROM events WHERE event = 'safe') OR 1=1 OR (event = 'other'",
    "SELECT event FROM events WHERE event = 'safe' AND (event = 'other'",
    'SELECT person.id AS event FROM events',
    'SELECT properties.id AS event FROM events',
    'SELECT event AS email FROM events',
    'SELECT event, count(*) FROM events GROUP BY person.id',
    'SELECT event FROM events ORDER BY person.id']) {
    expect(() => boundedHogql(query, from, to, 10, 60)).toThrow();
  }
  expect(() => boundedHogql('SELECT event FROM events', from, '2026-01-01T02:00:00Z', 10, 60)).toThrow();
  expect(() => boundedHogql('SELECT event FROM events SELECT timestamp', from, to, 10, 60)).toThrow();
  const futureFrom = new Date(Date.now() + 120_000).toISOString();
  const futureTo = new Date(Date.now() + 150_000).toISOString();
  expect(() => boundedHogql('SELECT event FROM events', futureFrom, futureTo, 10, 60)).toThrow();
});

// @guardrail G6.1: SQL predicates must cover exactly the reported millisecond window.
it('preserves fractional UTC bounds in the generated HogQL predicate', () => {
  const result = boundedHogql('SELECT event FROM events',
    '2026-01-01T00:00:00.900Z', '2026-01-01T00:00:01.125Z', 10, 60);
  expect(result.query).toContain("timestamp >= toDateTime64('2026-01-01 00:00:00.900', 3, 'UTC')");
  expect(result.query).toContain("timestamp <= toDateTime64('2026-01-01 00:00:01.125', 3, 'UTC')");
  expect(result.window).toEqual({ from: '2026-01-01T00:00:00.900Z',
    to: '2026-01-01T00:00:01.125Z' });
});

// @guardrail G6.3: key scopes and project binding must match the configured allowlist.
it('refuses broad or unscoped active keys at startup', async () => {
  const { value } = config();
  mock.use(http.get(`${base}/api/personal_api_keys/@current/`, () => HttpResponse.json({
    scopes: [...readScopes, 'query:write'], scoped_teams: [123], scoped_organizations: [],
  })));
  await expect(new PostHogProvider().preflight(value)).rejects.toThrow('PostHog scope');
  mock.use(http.get(`${base}/api/personal_api_keys/@current/`, () => HttpResponse.json({
    scopes: readScopes, scoped_teams: [], scoped_organizations: [],
  })));
  await expect(new PostHogProvider().preflight(value)).rejects.toThrow('PostHog scopes');
});

// @guardrail G6.2: only safe query cells and metadata summaries leave the provider.
it('returns bounded analytics and summary metadata without planted identity or targeting data', async () => {
  const fixture = await harness();
  try {
    const calls = [
      { name: 'posthog_hogql', arguments: { projectId: 123,
        query: 'SELECT event, count(*) FROM events GROUP BY event',
        from: '2026-01-01T00:00:00Z', to: '2026-01-01T00:10:00Z' } },
      { name: 'posthog_insight', arguments: { projectId: 123, insightId: 7 } },
      { name: 'posthog_error_issues', arguments: { projectId: 123 } },
      { name: 'posthog_flag', arguments: { projectId: 123, flagId: 8 } },
    ];
    const results = [];
    for (const call of calls) results.push(await fixture.client.callTool(call));
    expect(results[0]?.structuredContent).toMatchObject({
      data: { columns: ['event', 'count'], rows: [['demo_event', 3]] }, examined: { rowCount: 1 },
    });
    expect(results[1]?.structuredContent).toMatchObject({ data: { id: 7, kind: 'TRENDS' } });
    expect(results[2]?.structuredContent).toMatchObject({ data: [{ status: 'active', severity: 'high' }] });
    expect(results[3]?.structuredContent).toMatchObject({ data: { id: 8, state: 'active' } });
    const serialized = JSON.stringify(results);
    for (const planted of ['person@example.invalid', 'Private user name', 'private-targeting-rule',
      'never-expose-this', 'synthetic-issue-id']) expect(serialized).not.toContain(planted);
    expect(readFileSync(fixture.auditPath, 'utf8').trim().split('\n')).toHaveLength(4);
  } finally { await fixture.close(); }
});

it('rejects an upstream column shape that could relabel private data', async () => {
  mock.use(http.post(`${base}/api/projects/123/query/`, () => HttpResponse.json({
    columns: ['event', 'count', 'email'], results: [['demo_event', 3, 'private-identity']],
  })));
  const fixture = await harness();
  try {
    const result = await fixture.client.callTool({ name: 'posthog_hogql', arguments: {
      projectId: 123, query: 'SELECT event, count(*) FROM events GROUP BY event',
      from: '2026-01-01T00:00:00Z', to: '2026-01-01T00:10:00Z',
    } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain('private-identity');
  } finally { await fixture.close(); }
});

it('refuses equal-length upstream column labels that disagree with the safe projection', async () => {
  mock.use(http.post(`${base}/api/projects/123/query/`, () => HttpResponse.json({
    columns: ['email', 'count'], results: [['private-identity', 3]],
  })));
  const fixture = await harness();
  try {
    const result = await fixture.client.callTool({ name: 'posthog_hogql', arguments: {
      projectId: 123, query: 'SELECT event, count(*) FROM events GROUP BY event',
      from: '2026-01-01T00:00:00Z', to: '2026-01-01T00:10:00Z',
    } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain('private-identity');
  } finally { await fixture.close(); }
});

it('refuses a project outside the allowlist and returns unknown for a missing flag', async () => {
  mock.use(http.get(`${base}/api/projects/123/feature_flags/8/`, () => new HttpResponse(null, { status: 404 })));
  const fixture = await harness();
  try {
    const refused = await fixture.client.callTool({ name: 'posthog_flag', arguments: { projectId: 456, flagId: 8 } });
    expect(refused.isError).toBe(true);
    const missing = await fixture.client.callTool({ name: 'posthog_flag', arguments: { projectId: 123, flagId: 8 } });
    expect(missing.structuredContent).toMatchObject({ data: { state: 'unknown' }, examined: { rowCount: 0 } });
  } finally { await fixture.close(); }
});

it('permits only the key preflight and configured read routes', () => {
  const routes = posthogRoutes([123]);
  expect(() => assertAllowedRequest('posthog', 'GET', '/api/projects/123/error_tracking/issues/', routes)).not.toThrow();
  expect(() => assertAllowedRequest('posthog', 'POST', '/api/projects/123/query/', routes)).not.toThrow();
  expect(() => assertAllowedRequest('posthog', 'POST', '/api/projects/123/feature_flags/8/', routes)).toThrow();
  expect(() => assertAllowedRequest('posthog', 'GET', '/api/projects/456/insights/7/', routes)).toThrow();
  expect(() => assertAllowedRequest('posthog', 'GET', '/api/projects/123/session_recordings/', routes)).toThrow();
});
