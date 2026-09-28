import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { auditedInput, runValidatedTool } from '../core/audited-input.js';
import { type Config } from '../core/config.js';
import { AWS_WRITE_ACTIONS, checkAwsCredential } from '../core/credential-check.js';
import { examined, OpsError, ToolResultSchema, type ToolResult } from '../core/result.js';
import { UNTRUSTED_DATA_NOTICE, type ToolRuntime } from '../core/tool.js';
import { SdkCloudWatchReadApi, type CloudWatchReadApi } from './aws-cloudwatch-api.js';
import type { ProviderModule } from './provider.js';

const utc = z.iso.datetime().regex(/Z$/, 'Use an absolute UTC timestamp');
const window = z.object({ from: utc, to: utc });
const metricInput = window.extend({
  namespace: z.string().min(1).max(256).regex(/^[A-Za-z0-9/_.-]+$/),
  metricName: z.string().min(1).max(256).regex(/^[A-Za-z0-9_.-]+$/),
  dimensions: z.record(z.string().min(1).max(255), z.string().min(1).max(255)).default({}),
  statistic: z.enum(['Average', 'Sum', 'Minimum', 'Maximum', 'SampleCount']).default('Average'),
  periodSeconds: z.number().int().min(60).max(3600).default(60),
});
const alarmsInput = z.object({ limit: z.number().int().min(1).max(100).default(50) });
const groupsInput = z.object({ limit: z.number().int().min(1).max(10).default(10) });
const logsInput = window.extend({
  logGroups: z.array(z.string().min(1).max(512)).min(1).max(10),
  query: z.string().min(1).max(2000),
});

type CloudWatchConfig = NonNullable<Config['providers']['cloudwatch']>;
type Context = { config: Config; cloudwatch: CloudWatchConfig; runtime: ToolRuntime; api: CloudWatchReadApi };

function checkWindow(from: string, to: string, maxMinutes: number): void {
  const duration = Date.parse(to) - Date.parse(from);
  if (duration <= 0 || duration > maxMinutes * 60_000) {
    throw new OpsError('QUERY_LIMIT', `CloudWatch window must be greater than zero and at most ${maxMinutes} minutes`);
  }
}

export function cloudWatchLogLimit(query: string): number {
  if (/\bSOURCE\b/i.test(query)) {
    throw new OpsError('QUERY_LIMIT', 'CloudWatch SOURCE is refused; use configured log groups');
  }
  const match = query.match(/\|\s*limit\s+(\d+)\s*$/i);
  const limit = match ? Number(match[1]) : Number.NaN;
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new OpsError('QUERY_LIMIT', 'CloudWatch query must end in | limit 1..1000');
  }
  return limit;
}

export class CloudWatchProvider implements ProviderModule {
  readonly id = 'cloudwatch';
  private api?: CloudWatchReadApi;

  constructor(private readonly makeApi: (config: CloudWatchConfig, timeoutMs: number) => CloudWatchReadApi =
    (config, timeoutMs) => new SdkCloudWatchReadApi(config, timeoutMs)) {}

  async preflight(config: Config): Promise<void> {
    const cloudwatch = config.providers.cloudwatch;
    if (!cloudwatch?.enabled) return;
    const api = this.makeApi(cloudwatch, config.limits.timeoutMs);
    await checkAwsCredential(() => api.policySourceArn().then((arn) => ({ arn })),
      (arn, actions) => api.simulateWrites(arn, actions));
    this.api = api;
  }

  register(server: McpServer, context: { config: Config; runtime: ToolRuntime }): void {
    const cloudwatch = context.config.providers.cloudwatch;
    if (!cloudwatch?.enabled) return;
    if (!this.api) throw new OpsError('REFUSED', 'CloudWatch credential preflight was not completed');
    const ctx: Context = { ...context, cloudwatch, api: this.api };

    server.registerTool('cloudwatch_metric_data', {
      description: `Read one bounded CloudWatch metric. ${UNTRUSTED_DATA_NOTICE}`,
      inputSchema: auditedInput(metricInput), outputSchema: ToolResultSchema,
      annotations: { readOnlyHint: true },
    }, async (raw) => runValidatedTool(ctx.runtime, 'cloudwatch_metric_data', 'cloudwatch', raw,
      metricInput, (input) => this.metric(ctx, input)));

    server.registerTool('cloudwatch_alarms', {
      description: `Read capped CloudWatch alarm states. ${UNTRUSTED_DATA_NOTICE}`,
      inputSchema: auditedInput(alarmsInput), outputSchema: ToolResultSchema,
      annotations: { readOnlyHint: true },
    }, async (raw) => runValidatedTool(ctx.runtime, 'cloudwatch_alarms', 'cloudwatch', raw,
      alarmsInput, (input) => this.alarms(ctx, input)));

    server.registerTool('cloudwatch_log_groups', {
      description: `Check configured CloudWatch log groups only. ${UNTRUSTED_DATA_NOTICE}`,
      inputSchema: auditedInput(groupsInput), outputSchema: ToolResultSchema,
      annotations: { readOnlyHint: true },
    }, async (raw) => runValidatedTool(ctx.runtime, 'cloudwatch_log_groups', 'cloudwatch', raw,
      groupsInput, (input) => this.groups(ctx, input)));

    server.registerTool('cloudwatch_logs_insights', {
      description: `Run a bounded CloudWatch Logs Insights read with scan accounting. ${UNTRUSTED_DATA_NOTICE}`,
      inputSchema: auditedInput(logsInput), outputSchema: ToolResultSchema,
      annotations: { readOnlyHint: true },
    }, async (raw) => runValidatedTool(ctx.runtime, 'cloudwatch_logs_insights', 'cloudwatch', raw,
      logsInput, (input) => this.logs(ctx, input)));
  }

  private async metric(ctx: Context, input: z.output<typeof metricInput>): Promise<ToolResult> {
    checkWindow(input.from, input.to, Math.min(1440, ctx.config.limits.maxWindowMinutes));
    if (Object.keys(input.dimensions).length > 10) throw new OpsError('QUERY_LIMIT', 'CloudWatch dimension cap exceeded');
    const steps = Math.ceil((Date.parse(input.to) - Date.parse(input.from)) / (input.periodSeconds * 1000)) + 1;
    if (steps > ctx.config.limits.maxRows) throw new OpsError('QUERY_LIMIT', 'CloudWatch point cap exceeded');
    const result = await ctx.api.metric({ ...input, maxPoints: steps });
    return { data: result.points.slice(0, ctx.config.limits.maxRows),
      examined: examined('cloudwatch', 'GetMetricData', {
        window: { from: input.from, to: input.to }, rowCount: Math.min(result.points.length, ctx.config.limits.maxRows),
        scannedCount: result.points.length, truncated: result.partial || result.points.length > ctx.config.limits.maxRows,
        warnings: result.partial ? ['CloudWatch returned partial metric data'] : [],
      }) };
  }

  private async alarms(ctx: Context, input: z.output<typeof alarmsInput>): Promise<ToolResult> {
    const limit = Math.min(input.limit, ctx.config.limits.maxRows);
    const result = await ctx.api.alarms(limit);
    return { data: result.rows, examined: examined('cloudwatch', 'DescribeAlarms', {
      rowCount: result.rows.length, scannedCount: result.rows.length,
      truncated: result.more, warnings: result.more ? ['Alarm list has more pages'] : [],
    }) };
  }

  private async groups(ctx: Context, input: z.output<typeof groupsInput>): Promise<ToolResult> {
    const configured = ctx.cloudwatch.logGroups.slice(0, input.limit);
    const rows = [];
    for (const name of configured) {
      rows.push(await ctx.api.logGroup(name) ?? { name, state: 'unknown' });
    }
    const truncated = configured.length < ctx.cloudwatch.logGroups.length;
    return { data: rows, examined: examined('cloudwatch', 'DescribeLogGroups for configured names', {
      rowCount: rows.length, scannedCount: configured.length, truncated,
      warnings: truncated ? ['Configured log group list capped'] : [],
    }) };
  }

  private async logs(ctx: Context, input: z.output<typeof logsInput>): Promise<ToolResult> {
    checkWindow(input.from, input.to, Math.min(ctx.cloudwatch.maxLogWindowMinutes, 1440));
    if (input.logGroups.some((group) => !ctx.cloudwatch.logGroups.includes(group)) ||
      new Set(input.logGroups).size !== input.logGroups.length) {
      throw new OpsError('QUERY_LIMIT', 'CloudWatch log group is not on the configured allowlist');
    }
    const limit = cloudWatchLogLimit(input.query);
    if (limit > ctx.config.limits.maxRows) throw new OpsError('QUERY_LIMIT', 'CloudWatch result cap exceeded');
    const deadline = Date.now() + ctx.config.limits.timeoutMs;
    const remaining = () => Math.max(1, deadline - Date.now());
    const queryId = await ctx.api.startLogs(input.logGroups, input.from, input.to, input.query,
      limit, remaining());
    let complete = false;
    let bytesScanned: number | null = null;
    let recordsScanned: number | null = null;
    try {
      while (Date.now() < deadline) {
        const result = await ctx.api.pollLogs(queryId, remaining());
        bytesScanned = result.bytesScanned;
        recordsScanned = result.recordsScanned;
        if (result.bytesScanned !== null && result.bytesScanned > ctx.cloudwatch.maxScanBytes) {
          throw new OpsError('QUERY_LIMIT', 'CloudWatch scanned-byte cap exceeded', {
            byteCount: result.bytesScanned, scannedCount: result.recordsScanned ?? 0,
            lineCount: result.recordsScanned, truncated: true,
          });
        }
        if (result.status === 'Complete') {
          if (result.bytesScanned === null || result.recordsScanned === null) {
            throw new OpsError('UPSTREAM', 'CloudWatch scan statistics are missing');
          }
          complete = true;
          const rows = result.rows.slice(0, limit).map((row) => Object.fromEntries(row
            .filter((field) => field.field !== '@ptr').map((field) => [field.field, field.value])));
          const truncated = result.rows.length >= limit;
          return { data: rows, examined: examined('cloudwatch', 'Logs Insights configured groups', {
            window: { from: input.from, to: input.to }, rowCount: rows.length,
            scannedCount: result.recordsScanned, byteCount: result.bytesScanned,
            lineCount: result.recordsScanned, truncated,
            warnings: truncated ? ['Log result may contain more rows'] : [],
          }) };
        }
        if (!['Scheduled', 'Running'].includes(result.status)) {
          throw new OpsError('UPSTREAM', 'CloudWatch Logs Insights query failed');
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      throw new OpsError('QUERY_LIMIT', 'CloudWatch Logs Insights timed out', {
        byteCount: bytesScanned, scannedCount: recordsScanned ?? 0, lineCount: recordsScanned,
        truncated: true,
      });
    } finally {
      if (!complete) await ctx.api.stopLogs(queryId).catch(() => undefined);
    }
  }
}

export { AWS_WRITE_ACTIONS };
