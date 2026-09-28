import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { auditedInput, runValidatedTool } from '../core/audited-input.js';
import { providerToken, providerTokenFile, type Config } from '../core/config.js';
import { checkGrafanaPermissions } from '../core/credential-check.js';
import { BoundedHttpClient } from '../core/http.js';
import { examined, OpsError, ToolResultSchema, type ToolResult } from '../core/result.js';
import { UNTRUSTED_DATA_NOTICE, type ToolRuntime } from '../core/tool.js';
import type { ProviderModule } from './provider.js';

const iso = z.iso.datetime();
const expression = z.string().min(1).max(2000);
const timeWindow = z.object({ from: iso, to: iso });
const dashboardInput = z.object({ query: z.string().max(100).default(''), limit: z.number().int().min(1).max(100).default(20) });
const alertInput = z.object({ limit: z.number().int().min(1).max(100).default(50) });
const instantInput = z.object({ query: expression, at: iso.optional() });
const rangeInput = timeWindow.extend({ query: expression, stepSeconds: z.number().int().min(60).max(3600).default(60) });
const lokiInput = z.object({
  from: iso.optional(), to: iso.optional(),
  selector: z.string().regex(/^\{[^{}]{1,256}\}$/),
  query: expression,
  logCode: z.string().regex(/^[A-Za-z0-9_:-]{1,80}$/).optional(),
  limit: z.number().int().min(1).max(1000).default(100),
});

const dashboardResponse = z.array(z.object({ uid: z.string(), title: z.string(), type: z.string() }).passthrough());
const alertResponse = z.object({ data: z.object({ groups: z.array(z.object({
  name: z.string(), rules: z.array(z.object({ name: z.string(), state: z.string().optional(), health: z.string().optional() }).passthrough()),
}).passthrough()) }) });
const lokiStats = z.object({ bytes: z.number().int().nonnegative(), entries: z.number().int().nonnegative() });
const frameResponse = z.object({ results: z.object({ A: z.object({
  frames: z.array(z.object({
    schema: z.object({ fields: z.array(z.object({
      name: z.string(), type: z.string(), labels: z.record(z.string(), z.string()).optional(),
    }).passthrough()) }),
    data: z.object({ values: z.array(z.array(z.unknown())) }),
  })) }),
}) });
type Frame = z.output<typeof frameResponse>['results']['A']['frames'][number];

function frames(body: unknown): Frame[] {
  return frameResponse.parse(body).results.A.frames;
}

function metricRows(source: Frame[], maxRows: number): { rows: unknown[]; series: number; scanned: number } {
  const rows: unknown[] = [];
  let series = 0;
  let scanned = 0;
  for (const frame of source) {
    if (frame.schema.fields.length === 0 && frame.data.values.length === 0) continue;
    const timeIndex = frame.schema.fields.findIndex((field) => field.type === 'time');
    if (timeIndex < 0) throw new OpsError('UPSTREAM', 'Prometheus: time field missing');
    for (let column = 0; column < frame.schema.fields.length; column += 1) {
      const field = frame.schema.fields[column];
      if (field?.type !== 'number') continue;
      series += 1;
      const values = frame.data.values[column] ?? [];
      const times = frame.data.values[timeIndex] ?? [];
      if (values.length !== times.length) throw new OpsError('UPSTREAM', 'Prometheus: malformed frame');
      scanned += values.length;
      if (series > 200) continue;
      for (let row = 0; row < values.length && rows.length < maxRows; row += 1) {
        const timestamp = Number(times[row]);
        if (!Number.isFinite(timestamp)) throw new OpsError('UPSTREAM', 'Prometheus: invalid timestamp');
        rows.push({ labels: field.labels ?? {}, at: new Date(timestamp).toISOString(),
          value: String(values[row]) });
      }
    }
  }
  return { rows, series, scanned };
}

function logRows(source: Frame[], limit: number): { rows: unknown[]; scanned: number } {
  const rows: unknown[] = [];
  let scanned = 0;
  for (const frame of source) {
    const timeIndex = frame.schema.fields.findIndex((field) => field.type === 'time');
    const lineIndex = frame.schema.fields.findIndex((field) => field.name === 'Line' && field.type === 'string');
    const labelsIndex = frame.schema.fields.findIndex((field) => field.name === 'labels');
    if (timeIndex < 0 || lineIndex < 0) throw new OpsError('UPSTREAM', 'Loki: log fields missing');
    const times = frame.data.values[timeIndex] ?? [];
    const lines = frame.data.values[lineIndex] ?? [];
    const labels = labelsIndex >= 0 ? frame.data.values[labelsIndex] ?? [] : [];
    if (times.length !== lines.length) throw new OpsError('UPSTREAM', 'Loki: malformed frame');
    scanned += lines.length;
    for (let row = 0; row < lines.length && rows.length < limit; row += 1) {
      const timestamp = Number(times[row]);
      if (!Number.isFinite(timestamp)) throw new OpsError('UPSTREAM', 'Loki: invalid timestamp');
      rows.push({ labels: labels[row] ?? {}, at: new Date(timestamp).toISOString(),
        line: String(lines[row]) });
    }
  }
  return { rows, scanned };
}

type GrafanaConfig = NonNullable<Config['providers']['grafana']>;
type GrafanaContext = { config: Config; runtime: ToolRuntime; client: BoundedHttpClient; grafana: GrafanaConfig };

export function grafanaRoutes(grafana: GrafanaConfig) {
  return [
    { method: 'GET' as const, path: '/api/access-control/user/permissions' },
    { method: 'GET' as const, path: '/api/search/' },
    { method: 'GET' as const, path: '/api/prometheus/grafana/api/v1/rules' },
    { method: 'GET' as const, path: `/api/datasources/proxy/uid/${grafana.lokiUid}/loki/api/v1/index/stats` },
    { method: 'POST' as const, path: '/api/ds/query' },
  ];
}

export class GrafanaProvider implements ProviderModule {
  readonly id = 'grafana';
  private client?: BoundedHttpClient;

  async preflight(config: Config, env: NodeJS.ProcessEnv = process.env): Promise<void> {
    const grafana = config.providers.grafana;
    if (!grafana?.enabled) return;
    const token = grafana.tokenFile ? providerTokenFile(grafana.tokenFile)
      : grafana.tokenEnv ? providerToken(grafana.tokenEnv, env) : undefined;
    const client = new BoundedHttpClient(grafana.baseUrl, token, config.limits.timeoutMs,
      config.limits.maxResponseBytes, 'Grafana', grafanaRoutes(grafana));
    const { body } = await client.get('/api/access-control/user/permissions');
    checkGrafanaPermissions(body as Record<string, unknown>);
    this.client = client;
  }

  register(server: McpServer, context: { config: Config; runtime: ToolRuntime }): void {
    const grafana = context.config.providers.grafana;
    if (!grafana?.enabled) return;
    if (!this.client) throw new OpsError('REFUSED', 'Grafana credential preflight was not completed');
    const ctx: GrafanaContext = { ...context, client: this.client, grafana };

    server.registerTool('grafana_search_dashboards', {
      description: `Search accessible dashboards by title, capped at 100 results. ${UNTRUSTED_DATA_NOTICE}`,
      inputSchema: auditedInput(dashboardInput), outputSchema: ToolResultSchema, annotations: { readOnlyHint: true },
    }, async (input) => runValidatedTool(ctx.runtime, 'grafana_search_dashboards', 'grafana', input,
      dashboardInput, (validated) => this.searchDashboards(ctx, validated)));

    server.registerTool('grafana_alert_rules', {
      description: `List Grafana-managed alert rule names and current state. ${UNTRUSTED_DATA_NOTICE}`,
      inputSchema: auditedInput(alertInput), outputSchema: ToolResultSchema, annotations: { readOnlyHint: true },
    }, async (input) => runValidatedTool(ctx.runtime, 'grafana_alert_rules', 'grafana', input,
      alertInput, (validated) => this.alertRules(ctx, validated)));

    server.registerTool('prometheus_instant', {
      description: `Run a bounded PromQL instant query through a configured Grafana data source. ${UNTRUSTED_DATA_NOTICE}`,
      inputSchema: auditedInput(instantInput), outputSchema: ToolResultSchema, annotations: { readOnlyHint: true },
    }, async (input) => runValidatedTool(ctx.runtime, 'prometheus_instant', 'grafana', input,
      instantInput, (validated) => this.prometheusInstant(ctx, validated)));

    server.registerTool('prometheus_range', {
      description: `Run a PromQL range query with a maximum window and at least 60-second steps. ${UNTRUSTED_DATA_NOTICE}`,
      inputSchema: auditedInput(rangeInput), outputSchema: ToolResultSchema, annotations: { readOnlyHint: true },
    }, async (input) => runValidatedTool(ctx.runtime, 'prometheus_range', 'grafana', input,
      rangeInput, (validated) => this.prometheusRange(ctx, validated)));

    server.registerTool('loki_logs', {
      description: `Run a capped LogQL stream query after checking Loki index scan estimates. ${UNTRUSTED_DATA_NOTICE}`,
      inputSchema: auditedInput(lokiInput), outputSchema: ToolResultSchema, annotations: { readOnlyHint: true },
    }, async (input) => runValidatedTool(ctx.runtime, 'loki_logs', 'grafana', input,
      lokiInput, (validated) => this.lokiLogs(ctx, validated)));
  }

  private async searchDashboards(ctx: GrafanaContext, input: z.output<typeof dashboardInput>): Promise<ToolResult> {
    const limit = Math.min(input.limit, ctx.config.limits.maxRows);
    const { body, bytes } = await ctx.client.get('/api/search/', { query: input.query, type: 'dash-db', limit: String(limit) });
    const dashboards = dashboardResponse.parse(body);
    const data = dashboards.slice(0, limit).map(({ uid, title, type }) => ({ uid, title, type }));
    return { data, examined: examined('grafana', `GET /api/search/?query=${input.query}`, {
      rowCount: data.length, byteCount: bytes, truncated: dashboards.length >= limit,
      warnings: dashboards.length >= limit ? ['Search may have more results'] : [],
    }) };
  }

  private async alertRules(ctx: GrafanaContext, input: z.output<typeof alertInput>): Promise<ToolResult> {
    const limit = Math.min(input.limit, ctx.config.limits.maxRows);
    const { body, bytes } = await ctx.client.get('/api/prometheus/grafana/api/v1/rules');
    const groups = alertResponse.parse(body).data.groups;
    const rules = groups.flatMap((group) => group.rules.map((rule) => ({ group: group.name, name: rule.name,
      state: rule.state ?? 'unknown', health: rule.health ?? 'unknown' })));
    return { data: rules.slice(0, limit), examined: examined('grafana', 'GET Grafana-managed alert rules', {
      rowCount: Math.min(rules.length, limit), scannedCount: rules.length,
      byteCount: bytes, truncated: rules.length > limit,
      warnings: rules.length > limit ? ['Alert rule result capped'] : [],
    }) };
  }

  private async prometheusInstant(ctx: GrafanaContext, input: z.output<typeof instantInput>): Promise<ToolResult> {
    const at = input.at ?? new Date().toISOString();
    const { body, bytes } = await ctx.client.post('/api/ds/query', {
      from: String(Date.parse(at) - 60_000), to: String(Date.parse(at)),
      queries: [{ refId: 'A', datasource: { uid: ctx.grafana.prometheusUid }, expr: input.query,
        format: 'time_series', instant: true, range: false, intervalMs: 60_000, maxDataPoints: 200 }],
    });
    const parsed = metricRows(frames(body), ctx.config.limits.maxRows);
    const truncated = parsed.series > 200 || parsed.scanned > parsed.rows.length;
    return { data: parsed.rows, examined: examined('grafana/prometheus', input.query, {
      window: { from: at, to: at }, rowCount: parsed.rows.length, scannedCount: parsed.scanned,
      byteCount: bytes, truncated,
      warnings: truncated ? ['Prometheus result capped at 200 series or configured rows'] : [],
    }) };
  }

  private async prometheusRange(ctx: GrafanaContext, input: z.output<typeof rangeInput>): Promise<ToolResult> {
    checkWindow(input.from, input.to, Math.min(1440, ctx.config.limits.maxWindowMinutes));
    const steps = Math.ceil((Date.parse(input.to) - Date.parse(input.from)) / (input.stepSeconds * 1000)) + 1;
    if (steps > ctx.config.limits.maxRows) throw new OpsError('QUERY_LIMIT', 'Prometheus: requested step count exceeds row cap');
    const { body, bytes } = await ctx.client.post('/api/ds/query', {
      from: String(Date.parse(input.from)), to: String(Date.parse(input.to)),
      queries: [{ refId: 'A', datasource: { uid: ctx.grafana.prometheusUid }, expr: input.query,
        format: 'time_series', instant: false, range: true, intervalMs: input.stepSeconds * 1000,
        maxDataPoints: steps }],
    });
    const parsed = metricRows(frames(body), ctx.config.limits.maxRows);
    const truncated = parsed.series > 200 || parsed.scanned > parsed.rows.length;
    return { data: parsed.rows, examined: examined('grafana/prometheus', input.query, {
      window: { from: input.from, to: input.to }, rowCount: parsed.rows.length,
      scannedCount: parsed.scanned, byteCount: bytes, truncated,
      warnings: truncated ? ['Prometheus result capped at 200 series or configured rows'] : [],
    }) };
  }

  private async lokiLogs(ctx: GrafanaContext, input: z.output<typeof lokiInput>): Promise<ToolResult> {
    const to = input.to ?? new Date().toISOString();
    const from = input.from ?? new Date(Date.parse(to) - 3_600_000).toISOString();
    checkWindow(from, to, Math.min(360, ctx.config.limits.maxWindowMinutes));
    if (!input.selector.includes('=') || !input.query.startsWith(input.selector) || input.query.slice(input.selector.length).includes('{')) {
      throw new OpsError('QUERY_LIMIT', 'Loki: query must start with its single nonempty stream selector');
    }
    const regexes = [...input.query.matchAll(/(?:=~|!~|\|~)\s*"((?:\\.|[^"\\])*)"/g)];
    if (regexes.some((match) => (match[1]?.length ?? 0) > 200)) {
      throw new OpsError('QUERY_LIMIT', 'Loki: regex exceeds 200 characters');
    }
    const query = input.logCode ? buildStructuredLogCodeQuery(input.query, input.logCode) : input.query;
    const limit = Math.min(input.limit, ctx.config.limits.maxRows, 1000);
    const prefix = `/api/datasources/proxy/uid/${ctx.grafana.lokiUid}/loki/api/v1`;
    const start = String(BigInt(Date.parse(from)) * 1_000_000n);
    const end = String(BigInt(Date.parse(to)) * 1_000_000n);
    const estimate = await ctx.client.get(`${prefix}/index/stats`, { query: input.selector, start, end });
    const index = lokiStats.parse(estimate.body);
    if (index.bytes > ctx.config.limits.maxLokiScanBytes) {
      throw new OpsError('QUERY_LIMIT', 'Loki: estimated scan exceeds configured byte cap; narrow the selector or window');
    }
    const { body } = await ctx.client.post('/api/ds/query', {
      from: String(Date.parse(from)), to: String(Date.parse(to)),
      queries: [{ refId: 'A', datasource: { uid: ctx.grafana.lokiUid }, expr: query,
        queryType: 'range', format: 'table', maxLines: limit, intervalMs: 60_000,
        maxDataPoints: limit }],
    });
    const parsed = logRows(frames(body), limit);
    const warnings = ['Loki index scan estimate is approximate and excludes ingester data'];
    warnings.push('Actual bytes scanned are unavailable through this Grafana frame; showing index estimate');
    if (parsed.scanned >= limit) warnings.push('Log result may contain more lines');
    return { data: parsed.rows, examined: examined('grafana/loki', query, {
      window: { from, to }, rowCount: parsed.rows.length,
      scannedCount: Math.max(index.entries, parsed.scanned),
      byteCount: index.bytes, lineCount: parsed.scanned, truncated: parsed.scanned >= limit, warnings,
    }) };
  }
}

export function buildStructuredLogCodeQuery(query: string, logCode: string): string {
  if (!/^[A-Za-z0-9_:-]{1,80}$/.test(logCode)) throw new OpsError('QUERY_LIMIT', 'Invalid structured log code');
  return `${query} | json | logCode="${logCode}"`;
}

function checkWindow(from: string, to: string, maxMinutes: number): void {
  const duration = Date.parse(to) - Date.parse(from);
  if (duration <= 0 || duration > maxMinutes * 60_000) {
    throw new OpsError('QUERY_LIMIT', `Query window must be greater than zero and at most ${maxMinutes} minutes`);
  }
}
