import { createHash } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { auditedInput, runValidatedTool } from '../core/audited-input.js';
import type { Config } from '../core/config.js';
import { providerToken, providerTokenFile } from '../core/config.js';
import { checkPostHogScopes } from '../core/credential-check.js';
import { BoundedHttpClient } from '../core/http.js';
import { examined, OpsError, ToolResultSchema, type ToolResult } from '../core/result.js';
import { UNTRUSTED_DATA_NOTICE, type ToolRuntime } from '../core/tool.js';
import type { ProviderModule } from './provider.js';
import { boundedHogql } from './posthog-query.js';

type PostHogConfig = NonNullable<Config['providers']['posthog']>;
type Context = { config: Config; posthog: PostHogConfig; runtime: ToolRuntime; client: BoundedHttpClient };
const projectId = z.number().int().positive();
const queryInput = z.object({ projectId, query: z.string().min(1).max(4000),
  from: z.string().min(1), to: z.string().min(1) });
const insightInput = z.object({ projectId, insightId: z.number().int().positive() });
const issuesInput = z.object({ projectId, limit: z.number().int().min(1).max(100).default(20) });
const flagInput = z.object({ projectId, flagId: z.number().int().positive() });
const keySchema = z.object({ scopes: z.array(z.string()), scoped_teams: z.array(z.number().int()),
  scoped_organizations: z.array(z.string()) }).passthrough();

export function posthogRoutes(projectIds: readonly number[]) {
  const ids = projectIds.join('|');
  return [
    { method: 'GET' as const, path: '/api/personal_api_keys/@current/' },
    { method: 'POST' as const, path: new RegExp(`^/api/projects/(?:${ids})/query/$`) },
    { method: 'GET' as const, path: new RegExp(`^/api/projects/(?:${ids})/insights/[1-9]\\d*/$`) },
    { method: 'GET' as const, path: new RegExp(`^/api/projects/(?:${ids})/error_tracking/issues/$`) },
    { method: 'GET' as const, path: new RegExp(`^/api/projects/(?:${ids})/feature_flags/[1-9]\\d*/$`) },
  ];
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new OpsError('UPSTREAM', 'PostHog returned an unexpected response');
  }
  return value as Record<string, unknown>;
}

function date(value: unknown): string | null {
  return typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
}

function safeCell(column: string, value: unknown): unknown {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string' && ['event', 'timestamp', 'day', 'hour'].includes(column.toLowerCase())) {
    return value.slice(0, 200);
  }
  return '[REDACTED]';
}

export class PostHogProvider implements ProviderModule {
  readonly id = 'posthog';
  private client: BoundedHttpClient | undefined;

  async preflight(config: Config): Promise<void> {
    this.client = undefined;
    const posthog = config.providers.posthog;
    if (!posthog?.enabled) return;
    const token = posthog.tokenFile ? providerTokenFile(posthog.tokenFile) : providerToken(posthog.tokenEnv!);
    const client = new BoundedHttpClient(posthog.baseUrl, token, config.limits.timeoutMs,
      config.limits.maxResponseBytes, 'PostHog', posthogRoutes(posthog.projectIds));
    const { body } = await client.get('/api/personal_api_keys/@current/');
    const parsed = keySchema.safeParse(body);
    if (!parsed.success) throw new OpsError('REFUSED', 'PostHog key metadata could not be verified');
    checkPostHogScopes(parsed.data.scopes, posthog.projectIds,
      parsed.data.scoped_teams, parsed.data.scoped_organizations);
    this.client = client;
  }

  register(server: McpServer, context: { config: Config; runtime: ToolRuntime }): void {
    const posthog = context.config.providers.posthog;
    if (!posthog?.enabled) return;
    if (!this.client) throw new OpsError('REFUSED', 'PostHog credential preflight was not completed');
    const ctx: Context = { ...context, posthog, client: this.client };
    server.registerTool('posthog_hogql', {
      description: `Run a bounded event-only SELECT for a UTC window. ${UNTRUSTED_DATA_NOTICE}`,
      inputSchema: auditedInput(queryInput), outputSchema: ToolResultSchema,
      annotations: { readOnlyHint: true },
    }, async (raw) => runValidatedTool(ctx.runtime, 'posthog_hogql', 'posthog', raw,
      queryInput, (input) => this.query(ctx, input)));
    server.registerTool('posthog_insight', {
      description: `Read safe metadata for a saved insight. ${UNTRUSTED_DATA_NOTICE}`,
      inputSchema: auditedInput(insightInput), outputSchema: ToolResultSchema,
      annotations: { readOnlyHint: true },
    }, async (raw) => runValidatedTool(ctx.runtime, 'posthog_insight', 'posthog', raw,
      insightInput, (input) => this.insight(ctx, input)));
    server.registerTool('posthog_error_issues', {
      description: `Read bounded error issue state without event payloads. ${UNTRUSTED_DATA_NOTICE}`,
      inputSchema: auditedInput(issuesInput), outputSchema: ToolResultSchema,
      annotations: { readOnlyHint: true },
    }, async (raw) => runValidatedTool(ctx.runtime, 'posthog_error_issues', 'posthog', raw,
      issuesInput, (input) => this.issues(ctx, input)));
    server.registerTool('posthog_flag', {
      description: `Read a feature flag's active state without targeting data. ${UNTRUSTED_DATA_NOTICE}`,
      inputSchema: auditedInput(flagInput), outputSchema: ToolResultSchema,
      annotations: { readOnlyHint: true },
    }, async (raw) => runValidatedTool(ctx.runtime, 'posthog_flag', 'posthog', raw,
      flagInput, (input) => this.flag(ctx, input)));
  }

  private allowed(ctx: Context, id: number): void {
    if (!ctx.posthog.projectIds.includes(id)) throw new OpsError('REFUSED', 'PostHog project is not configured');
  }

  private async query(ctx: Context, input: z.output<typeof queryInput>): Promise<ToolResult> {
    this.allowed(ctx, input.projectId);
    const bounded = boundedHogql(input.query, input.from, input.to,
      ctx.config.limits.maxRows, ctx.config.limits.maxWindowMinutes);
    const { body, bytes } = await ctx.client.post(`/api/projects/${input.projectId}/query/`, {
      query: { kind: 'HogQLQuery', query: bounded.query }, name: 'ops-lens bounded incident query',
    });
    const value = record(body);
    if (!Array.isArray(value.columns) || !Array.isArray(value.results) ||
      value.columns.some((column) => typeof column !== 'string') ||
      value.results.some((row) => !Array.isArray(row))) {
      throw new OpsError('UPSTREAM', 'PostHog query did not return complete rows');
    }
    const columns = value.columns as string[];
    if (columns.length > 50 || value.results.some((row) => (row as unknown[]).length !== columns.length)) {
      throw new OpsError('UPSTREAM', 'PostHog query columns were malformed');
    }
    const rows = (value.results as unknown[][]).slice(0, bounded.limit)
      .map((row) => row.map((cell, index) => safeCell(columns[index] ?? '', cell)));
    const truncated = value.results.length > rows.length || value.hasMore === true;
    return { data: { columns, rows }, examined: examined('posthog', 'bounded HogQL events SELECT', {
      window: bounded.window, rowCount: rows.length, scannedCount: value.results.length,
      byteCount: bytes, truncated,
      warnings: truncated ? ['Additional query rows were omitted'] : [],
    }) };
  }

  private async insight(ctx: Context, input: z.output<typeof insightInput>): Promise<ToolResult> {
    this.allowed(ctx, input.projectId);
    const { body, bytes } = await ctx.client.get(`/api/projects/${input.projectId}/insights/${input.insightId}/`);
    const value = record(body);
    return { data: { id: input.insightId, shortId: typeof value.short_id === 'string' ? value.short_id : null,
      kind: typeof value.insight === 'string' ? value.insight : null,
      lastRefresh: date(value.last_refresh) },
    examined: examined('posthog', 'GET configured insight metadata', {
      rowCount: 1, scannedCount: 1, byteCount: bytes,
    }) };
  }

  private async issues(ctx: Context, input: z.output<typeof issuesInput>): Promise<ToolResult> {
    this.allowed(ctx, input.projectId);
    const limit = Math.min(input.limit, ctx.config.limits.maxRows);
    const { body, bytes } = await ctx.client.get(`/api/projects/${input.projectId}/error_tracking/issues/`,
      { limit: String(limit), offset: '0' });
    const value = record(body);
    if (!Array.isArray(value.results)) throw new OpsError('UPSTREAM', 'PostHog issues response was malformed');
    const rows = value.results.slice(0, limit).map((item: unknown) => {
      const issue = record(item);
      return { reference: typeof issue.id === 'string'
        ? createHash('sha256').update(issue.id).digest('hex').slice(0, 12) : null,
      status: typeof issue.status === 'string' ? issue.status.slice(0, 40) : 'unknown',
      severity: typeof issue.severity === 'string' ? issue.severity.slice(0, 40) : 'unknown',
      firstSeen: date(issue.first_seen) };
    });
    const truncated = value.next !== null && value.next !== undefined || value.results.length > rows.length;
    return { data: rows, examined: examined('posthog', 'GET error issue summaries', {
      rowCount: rows.length, scannedCount: value.results.length, byteCount: bytes, truncated,
      warnings: truncated ? ['More error issues exist'] : [],
    }) };
  }

  private async flag(ctx: Context, input: z.output<typeof flagInput>): Promise<ToolResult> {
    this.allowed(ctx, input.projectId);
    let body: unknown; let bytes: number;
    try {
      ({ body, bytes } = await ctx.client.get(`/api/projects/${input.projectId}/feature_flags/${input.flagId}/`));
    } catch (error) {
      if (error instanceof OpsError && error.code === 'NOT_FOUND') {
        return { data: { id: input.flagId, state: 'unknown' },
          examined: examined('posthog', 'GET feature flag state', { warnings: ['Flag was not found'] }) };
      }
      throw error;
    }
    const value = record(body);
    const state = typeof value.active === 'boolean' ? value.active ? 'active' : 'inactive' : 'unknown';
    return { data: { id: input.flagId, state, archived: value.archived === true },
      examined: examined('posthog', 'GET feature flag state', {
        rowCount: 1, scannedCount: 1, byteCount: bytes,
        warnings: state === 'unknown' ? ['Flag active state was unavailable'] : [],
      }) };
  }
}
