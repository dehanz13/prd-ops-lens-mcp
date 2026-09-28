import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { auditedInput, runValidatedTool } from '../core/audited-input.js';
import type { Config } from '../core/config.js';
import { BoundedHttpClient } from '../core/http.js';
import { examined, OpsError, ToolResultSchema, type ToolResult } from '../core/result.js';
import { UNTRUSTED_DATA_NOTICE, type ToolRuntime } from '../core/tool.js';
import type { ProviderModule } from './provider.js';

const inputSchema = z.object({});
const heartbeatSchema = z.object({
  status: z.number().int(), time: z.string(),
}).passthrough();
const groupSchema = z.object({
  name: z.string(),
  monitorList: z.array(z.object({
    id: z.union([z.string(), z.number()]), name: z.string(), url: z.string().optional(),
  }).passthrough()),
}).passthrough();

type UptimeConfig = NonNullable<Config['providers']['uptime']>;
type Context = { config: Config; runtime: ToolRuntime; uptime: UptimeConfig; client: BoundedHttpClient };

export function uptimeRoutes(slug: string) {
  return [
    { method: 'GET' as const, path: `/api/status-page/${slug}` },
    { method: 'GET' as const, path: `/api/status-page/heartbeat/${slug}` },
  ];
}

function safeLabel(value: string, monitorUrl?: string): string {
  let result = value.replace(/https?:\/\/[^\s]+/gi, '[REDACTED]')
    .replace(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b/gi, '[REDACTED]')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[REDACTED]');
  if (monitorUrl) {
    try {
      const host = new URL(monitorUrl).hostname;
      if (host) result = result.replace(new RegExp(escapeRegExp(host), 'gi'), '[REDACTED]');
    } catch { /* The untrusted URL is discarded below. */ }
  }
  return result.slice(0, 200);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function statusName(value: number): 'down' | 'up' | 'pending' | 'maintenance' | 'unknown' {
  return ({ 0: 'down', 1: 'up', 2: 'pending', 3: 'maintenance' } as Record<number, 'down' | 'up' | 'pending' | 'maintenance'>)[value] ?? 'unknown';
}

function unambiguousTime(value: string): string | null {
  if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

export class UptimeProvider implements ProviderModule {
  readonly id = 'uptime';

  register(server: McpServer, context: { config: Config; runtime: ToolRuntime }): void {
    const uptime = context.config.providers.uptime;
    if (!uptime?.enabled) return;
    const client = new BoundedHttpClient(uptime.baseUrl, undefined, context.config.limits.timeoutMs,
      context.config.limits.maxResponseBytes, 'Uptime Kuma', uptimeRoutes(uptime.slug));
    const ctx: Context = { ...context, uptime, client };
    server.registerTool('uptime_status', {
      description: `Read a public status page, current monitor heartbeat, and incident summaries. ${UNTRUSTED_DATA_NOTICE}`,
      inputSchema: auditedInput(inputSchema), outputSchema: ToolResultSchema,
      annotations: { readOnlyHint: true },
    }, async (raw) => runValidatedTool(ctx.runtime, 'uptime_status', 'uptime', raw, inputSchema,
      () => this.status(ctx)));
  }

  private async status(ctx: Context): Promise<ToolResult> {
    const started = new Date().toISOString();
    const statusPath = `/api/status-page/${ctx.uptime.slug}`;
    const heartbeatPath = `/api/status-page/heartbeat/${ctx.uptime.slug}`;
    let statusBody: unknown;
    let heartbeatBody: unknown;
    let bytes = 0;
    try {
      const status = await ctx.client.get(statusPath);
      const heartbeats = await ctx.client.get(heartbeatPath);
      statusBody = status.body;
      heartbeatBody = heartbeats.body;
      bytes = status.bytes + heartbeats.bytes;
    } catch (error) {
      if (error instanceof OpsError && error.code === 'NOT_FOUND') {
        return this.unavailable(started, 'Public status page is not published', 0, 'not_published');
      }
      return this.unavailable(started, 'Public status page data is unavailable');
    }

    const publication = z.object({ config: z.object({ published: z.boolean() }).passthrough() })
      .passthrough().safeParse(statusBody);
    if (publication.success && !publication.data.config.published) {
      return this.unavailable(started, 'Public status page is not published', bytes, 'not_published');
    }
    const page = z.object({ config: z.object({ published: z.boolean() }).passthrough(),
      incidents: z.array(z.unknown()), publicGroupList: z.array(groupSchema),
    }).passthrough().safeParse(statusBody);
    const heartbeat = z.object({
      heartbeatList: z.record(z.string(), z.array(heartbeatSchema)),
      uptimeList: z.record(z.string(), z.number()),
    }).passthrough().safeParse(heartbeatBody);
    if (!page.success || !heartbeat.success) {
      return this.unavailable(started, 'Public status page data is incomplete', bytes);
    }

    const warnings: string[] = [];
    let scanned = 0;
    const monitors = page.data.publicGroupList.flatMap((group) => group.monitorList.map((monitor) => {
      const list = heartbeat.data.heartbeatList[String(monitor.id)];
      scanned += list?.length ?? 0;
      const newest = list?.at(-1);
      const state = newest ? statusName(newest.status) : 'unknown';
      if (state === 'unknown') warnings.push('A monitor has no usable heartbeat');
      if (newest && !unambiguousTime(newest.time)) warnings.push('A heartbeat time lacked a UTC offset; timestamp omitted');
      const uptime24 = heartbeat.data.uptimeList[`${monitor.id}_24`];
      return {
        group: safeLabel(group.name), name: safeLabel(monitor.name, monitor.url), state,
        observedAt: newest ? unambiguousTime(newest.time) : null,
        uptime24h: uptime24 !== undefined && uptime24 >= 0 && uptime24 <= 1 ? uptime24 : null,
      };
    }));
    const limit = ctx.config.limits.maxRows;
    const incidents = page.data.incidents.slice(0, limit).map((item) => {
      const parsed = z.object({ title: z.string().optional(), status: z.string().optional() })
        .passthrough().safeParse(item);
      return { title: parsed.success ? safeLabel(parsed.data.title ?? 'Untitled incident') : 'Untitled incident',
        status: parsed.success ? safeLabel(parsed.data.status ?? 'unknown') : 'unknown' };
    });
    const trimmed = monitors.slice(0, limit);
    const truncated = monitors.length > limit || page.data.incidents.length > limit;
    if (truncated) warnings.push('Status page result capped');
    return { data: { state: 'available', monitors: trimmed, incidents },
      examined: examined('uptime', `GET public status page and heartbeat for configured slug`, {
        window: { from: started, to: new Date().toISOString() },
        rowCount: trimmed.length + incidents.length, scannedCount: Math.max(scanned, monitors.length),
        byteCount: bytes, truncated, warnings: [...new Set(warnings)],
      }) };
  }

  private unavailable(started: string, warning: string, bytes = 0,
    state: 'unknown' | 'not_published' = 'unknown'): ToolResult {
    return { data: { state, monitors: [], incidents: [] },
      examined: examined('uptime', 'GET public status page and heartbeat for configured slug', {
        window: { from: started, to: new Date().toISOString() }, byteCount: bytes,
        warnings: [warning],
      }) };
  }
}
