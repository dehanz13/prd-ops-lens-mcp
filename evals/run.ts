import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { ConfigSchema } from '../src/core/config.js';
import type { CloudWatchReadApi } from '../src/providers/aws-cloudwatch-api.js';
import { CloudWatchProvider } from '../src/providers/cloudwatch.js';
import { GrafanaProvider } from '../src/providers/grafana.js';
import { PostHogProvider } from '../src/providers/posthog.js';
import { UptimeProvider } from '../src/providers/uptime.js';
import { createServer } from '../src/server.js';
import { evidenceScore, positiveControlScore, suiteSchema, type Scenario } from './scoring.js';

const suite = suiteSchema.parse(JSON.parse(readFileSync('evals/fixtures/scenarios.json', 'utf8')));
const directory = mkdtempSync(join(tmpdir(), 'ops-lens-evals-'));
const tokenFile = join(directory, 'synthetic-posthog.token');
writeFileSync(tokenFile, 'synthetic-token', { mode: 0o600 });
const window = { from: '2026-01-01T00:00:00.000Z', to: '2026-01-01T01:00:00.000Z' };
type Source = Scenario['sources'][number];
type Row = Record<string, unknown>;
let active: { source: Source; data: unknown } | null = null;
const rows = (): Row[] => Array.isArray(active?.data)
  ? active.data.filter((value): value is Row => value !== null && typeof value === 'object' && !Array.isArray(value))
  : [];
const object = (value: unknown): Row => value !== null && typeof value === 'object' && !Array.isArray(value)
  ? value as Row : {};
const grafanaBase = 'http://127.0.0.1:3130';
const uptimeBase = 'http://127.0.0.1:3131';
const posthogBase = 'http://127.0.0.1:3132';

const upstream = setupServer(
  http.get(`${grafanaBase}/api/access-control/user/permissions`, () =>
    HttpResponse.json({ 'dashboards:read': ['*'], 'datasources:query': ['*'] })),
  http.get(`${grafanaBase}/api/datasources/proxy/uid/loki/loki/api/v1/index/stats`, () =>
    HttpResponse.json({ bytes: 100, entries: rows().length })),
  http.post(`${grafanaBase}/api/ds/query`, async ({ request }) => {
    const body = await request.json() as { queries: Array<{ datasource: { uid: string } }> };
    const values = rows();
    const frame = body.queries[0]?.datasource.uid === 'loki'
      ? { schema: { fields: [{ name: 'Time', type: 'time' }, { name: 'Line', type: 'string' }] },
        data: { values: [values.map((row) => Date.parse(String(row.at))),
          values.map((row) => String(row.line))] } }
      : { schema: { fields: values.length ? [{ name: 'Time', type: 'time' },
        { name: 'Value', type: 'number', labels: {} }] : [] },
        data: { values: values.length ? [values.map((row) => Date.parse(String(row.at))),
          values.map((row) => Number(row.value))] : [] } };
    return HttpResponse.json({ results: { A: { frames: [frame] } } });
  }),
  http.get(`${uptimeBase}/api/status-page/demo`, () => {
    const data = object(active?.data);
    const monitors = Array.isArray(data.monitors) ? data.monitors.map(object) : [];
    const incidents = Array.isArray(data.incidents) ? data.incidents.map(object) : [];
    return HttpResponse.json({ config: { published: true },
      publicGroupList: [{ name: 'Synthetic group', monitorList: monitors.map((monitor, index) =>
        ({ id: index + 1, name: String(monitor.name ?? 'synthetic monitor') })) }],
      incidents: incidents.map((incident) => ({ title: incident.title, status: incident.status,
        createdDate: incident.createdAt })) });
  }),
  http.get(`${uptimeBase}/api/status-page/heartbeat/demo`, () => {
    const data = object(active?.data);
    const monitors = Array.isArray(data.monitors) ? data.monitors.map(object) : [];
    const heartbeatList = Object.fromEntries(monitors.map((monitor, index) => {
      const sourceAt = Date.parse(String(monitor.observedAt));
      const offset = Number.isFinite(sourceAt) ? sourceAt - Date.parse(window.from) : 0;
      const observedAt = new Date(Date.now() - 45 * 60_000 + offset).toISOString();
      const status = monitor.state === 'up' ? 1 : monitor.state === 'down' ? 0 : 2;
      return [String(index + 1), [{ status, time: observedAt }]];
    }));
    return HttpResponse.json({ heartbeatList, uptimeList: {} });
  }),
  http.get(`${posthogBase}/api/personal_api_keys/@current/`, () => HttpResponse.json({
    scopes: ['query:read', 'insight:read', 'error_tracking:read', 'feature_flag:read'],
    scoped_teams: [123], scoped_organizations: [],
  })),
  http.get(`${posthogBase}/api/projects/123/error_tracking/issues/`, () => HttpResponse.json({
    next: null, results: rows().map((row) => ({ id: row.reference, status: row.status,
      severity: 'synthetic', first_seen: row.firstSeen })),
  })),
);
upstream.listen({ onUnhandledRequest: 'error' });

class ReplayCloudWatch implements CloudWatchReadApi {
  async policySourceArn() { return 'arn:aws:iam::000000000000:role/synthetic-reader'; }
  async simulateWrites(_arn: string, actions: readonly string[]) {
    return Object.fromEntries(actions.map((action) => [action, false]));
  }
  async metric(): Promise<never> { throw Error('No metric replay uses CloudWatch'); }
  async alarms(limit: number) {
    const values = rows().slice(0, limit);
    return { rows: values.map((row) => ({ name: String(row.name), state: String(row.state),
      updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : null })), more: false };
  }
  async logGroup() { return null; }
  async startLogs() { return 'synthetic-query'; }
  async pollLogs() {
    const values = rows();
    return { status: 'Complete', rows: values.map((row) => [
      { field: '@timestamp', value: String(row['@timestamp']).replace('T', ' ').replace('Z', '') },
      { field: '@message', value: String(row['@message']) },
    ]), bytesScanned: 100, recordsScanned: values.length };
  }
  async stopLogs() {}
}

const config = ConfigSchema.parse({ version: 1, audit: { path: join(directory, 'audit.jsonl') },
  providers: {
    grafana: { enabled: true, baseUrl: grafanaBase, prometheusUid: 'prom', lokiUid: 'loki' },
    uptime: { enabled: true, baseUrl: uptimeBase, slug: 'demo', maxHeartbeatAgeSeconds: 3600 },
    cloudwatch: { enabled: true, region: 'us-east-1', profile: 'synthetic',
      credentialsFile: join(directory, 'unused-aws-profile'), logGroups: ['synthetic-logs'] },
    posthog: { enabled: true, baseUrl: posthogBase, tokenFile, projectIds: [123] },
  },
});
const grafana = new GrafanaProvider();
const cloudwatch = new CloudWatchProvider(() => new ReplayCloudWatch());
const posthog = new PostHogProvider();
await Promise.all([grafana.preflight(config), cloudwatch.preflight(config), posthog.preflight(config)]);
const server = createServer(config, [grafana, new UptimeProvider(), cloudwatch, posthog]);
const client = new Client({ name: 'incident-replay', version: '1.0.0' });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

function argumentsFor(source: Source): Record<string, unknown> {
  switch (source.tool) {
    case 'loki_logs': return { ...window, selector: source.query.match(/^\{[^}]+\}/)?.[0],
      query: source.query };
    case 'prometheus_range': return { ...window, query: source.query, stepSeconds: 60 };
    case 'cloudwatch_logs_insights': return { ...window, logGroups: ['synthetic-logs'], query: source.query };
    case 'posthog_error_issues': return { projectId: 123 };
    default: return {};
  }
}

async function sourcesFor(scenario: Scenario, removeKey: boolean) {
  const sources = [];
  for (const [index, source] of scenario.sources.entries()) {
    const data = removeKey && index === scenario.keySource
      ? Array.isArray(source.data) ? [] : { state: 'unknown', monitors: [], incidents: [] }
      : source.data;
    active = { source, data };
    const result = await client.callTool({ name: source.tool, arguments: argumentsFor(source) });
    if (result.isError) throw Error(`Replay source tool failed: ${source.tool}`);
    sources.push({ tool: source.tool,
      evidenceId: (result.structuredContent as { evidenceId: string }).evidenceId });
  }
  return sources;
}

let evidencePassed = 0;
let positiveControlsPassed = 0;
await server.connect(serverTransport);
await client.connect(clientTransport);
try {
  for (const scenario of suite.cases) {
    const result = await client.callTool({ name: 'incident_timeline', arguments: {
      sources: await sourcesFor(scenario, false), expectedTools: scenario.sources.map((source) => source.tool),
    } });
    if (!result.isError && evidenceScore(result.structuredContent, scenario)) evidencePassed += 1;
    else process.stderr.write(`Replay evidence failed: ${scenario.id}\n`);
    const removed = await client.callTool({ name: 'incident_timeline', arguments: {
      sources: await sourcesFor(scenario, true), expectedTools: scenario.sources.map((source) => source.tool),
    } });
    if (positiveControlScore(removed, scenario)) positiveControlsPassed += 1;
  }
} finally {
  await client.close();
  await server.close();
  upstream.close();
  rmSync(directory, { recursive: true, force: true });
}

const report = { suite: 'incident-replay-v1', scenarios: suite.cases.length,
  evidencePassed, positiveControlsPassed, providerParsed: true, modelScored: false };
process.stdout.write(`${JSON.stringify(report)}\n`);
if (evidencePassed !== suite.cases.length || positiveControlsPassed !== suite.cases.length) process.exitCode = 1;
