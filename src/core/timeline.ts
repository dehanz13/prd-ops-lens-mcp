import { z } from 'zod';
import { examined, OpsError, type Examined, type ToolResult } from './result.js';

const sourceTool = z.enum([
  'loki_logs', 'uptime_status', 'cloudwatch_alarms', 'cloudwatch_logs_insights',
  'posthog_error_issues', 'prometheus_range', 'cloudwatch_metric_data',
]);
export const timelineInput = z.strictObject({
  sources: z.array(z.strictObject({ tool: sourceTool, evidenceId: z.uuid() })).min(1).max(8),
  expectedTools: z.array(sourceTool).max(8).default([]),
});
export type TimelineInput = z.output<typeof timelineInput>;

type Event = { at: string; summary: string; citations: Array<{ tool: string; examined: Examined }> };
const providerFor: Record<z.output<typeof sourceTool>, string> = {
  loki_logs: 'grafana/loki', uptime_status: 'uptime', cloudwatch_alarms: 'cloudwatch',
  cloudwatch_logs_insights: 'cloudwatch', posthog_error_issues: 'posthog',
  prometheus_range: 'grafana/prometheus', cloudwatch_metric_data: 'cloudwatch',
};

function row(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function utc(value: unknown): string | null {
  if (typeof value !== 'string' || !/(?:Z|[+-]\d{2}:\d{2})$/.test(value) ||
    !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

function cloudWatchUtc(value: unknown): string | null {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,3})?$/.test(value)) {
    return utc(`${value.replace(' ', 'T')}Z`);
  }
  return utc(value);
}

function short(value: unknown): string {
  return typeof value === 'string' ? value.slice(0, 300) : 'unknown';
}

function extract(tool: z.output<typeof sourceTool>, data: unknown): Array<{ at: string; summary: string }> {
  const values = Array.isArray(data) ? data : [];
  if (tool === 'uptime_status') {
    const object = row(data);
    const incidents = Array.isArray(object?.incidents) ? object.incidents : [];
    const monitors = Array.isArray(object?.monitors) ? object.monitors : [];
    return [
      ...incidents.map((value) => {
        const item = row(value); return { at: utc(item?.createdAt),
          summary: `Incident: ${short(item?.title)} (${short(item?.status)})` };
      }),
      ...monitors.map((value) => {
        const item = row(value); return { at: utc(item?.observedAt),
          summary: `Monitor: ${short(item?.name)} (${short(item?.state)})` };
      }),
    ].filter((event): event is { at: string; summary: string } => event.at !== null);
  }
  return values.flatMap((value) => {
    const item = row(value);
    if (!item) return [];
    let at: string | null = null;
    let summary = '';
    if (tool === 'loki_logs') {
      at = utc(item.at); summary = `Log: ${short(item.line)}`;
    } else if (tool === 'cloudwatch_alarms') {
      at = utc(item.updatedAt); summary = `Alarm: ${short(item.name)} (${short(item.state)})`;
    } else if (tool === 'cloudwatch_logs_insights') {
      at = cloudWatchUtc(item['@timestamp']); summary = `Log: ${short(item['@message'])}`;
    } else if (tool === 'posthog_error_issues') {
      at = utc(item.firstSeen); summary = `Error issue: ${short(item.reference)} (${short(item.status)})`;
    } else if (tool === 'prometheus_range' || tool === 'cloudwatch_metric_data') {
      at = utc(item.at); summary = `Metric value: ${short(item.value)}`;
    }
    return at ? [{ at, summary }] : [];
  });
}

/** Correlate only timestamps and observations present in supplied MCP tool results. */
export function incidentTimeline(input: TimelineInput, maxRows: number,
  evidence: ReadonlyMap<string, { tool: string; result: ToolResult }>): ToolResult {
  if (Buffer.byteLength(JSON.stringify(input)) > 262_144) {
    throw new OpsError('QUERY_LIMIT', 'Timeline input exceeds 256 KiB');
  }
  const events = new Map<string, Event>();
  const warnings: string[] = [];
  let examinedRows = 0;
  for (const source of input.sources) {
    const stored = evidence.get(source.evidenceId);
    if (!stored || stored.tool !== source.tool ||
      stored.result.examined.provider !== providerFor[source.tool]) {
      throw new OpsError('REFUSED', 'Timeline evidence ID is missing or does not match its source tool');
    }
    const result = stored.result;
    const extracted = extract(source.tool, result.data);
    examinedRows += extracted.length;
    if (result.examined.truncated) warnings.push(`${source.tool}: source result was truncated`);
    if (result.examined.warnings.length) warnings.push(`${source.tool}: source has warnings`);
    if (extracted.length === 0) warnings.push(`${source.tool}: no timestamped events were available`);
    for (const event of extracted) {
      const key = `${event.at}\n${event.summary}`;
      const citation = { tool: source.tool, examined: result.examined };
      const existing = events.get(key);
      if (existing) existing.citations.push(citation);
      else events.set(key, { ...event, citations: [citation] });
    }
  }
  const present = new Set(input.sources.map((source) => source.tool));
  const expected = [...new Set(input.expectedTools)];
  const sourceStatus = expected.map((tool) => ({ tool, state: present.has(tool) ? 'supplied' : 'unknown' }));
  if (sourceStatus.some((source) => source.state === 'unknown')) warnings.push('An expected source was not supplied');
  const ordered = [...events.values()].sort((a, b) => a.at.localeCompare(b.at) ||
    a.summary.localeCompare(b.summary));
  const output = ordered.slice(0, maxRows);
  const windows = input.sources.flatMap((source) => {
    const window = evidence.get(source.evidenceId)!.result.examined.window;
    return [window.from, window.to];
  }).sort();
  return {
    data: { events: output, sourceStatus },
    examined: examined('local', 'Correlate supplied MCP tool results', {
      window: { from: windows[0]!, to: windows.at(-1)! },
      rowCount: output.length, scannedCount: examinedRows, truncated: ordered.length > maxRows,
      warnings: [...new Set(warnings)],
    }),
  };
}
