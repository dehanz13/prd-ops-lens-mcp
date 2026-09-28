import { createHash } from 'node:crypto';
import { closeSync, constants, createReadStream, fstatSync, lstatSync, openSync } from 'node:fs';
import { createInterface } from 'node:readline';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { auditedInput, runValidatedTool } from '../core/audited-input.js';
import type { Config } from '../core/config.js';
import { examined, OpsError, ToolResultSchema, type ToolResult } from '../core/result.js';
import { UNTRUSTED_DATA_NOTICE, type ToolRuntime } from '../core/tool.js';
import type { ProviderModule } from './provider.js';

type UsageConfig = NonNullable<Config['providers']['agentUsage']>;
type JobKind = 'feature' | 'bug' | 'review' | 'docs' | 'ops' | 'other';
export type UsageJob = {
  label: string; kind: JobKind; source: 'codex' | 'claude'; model: string;
  startedAt: string; endedAt: string; durationMs: number;
  inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number;
  toolCalls: number | null; tokensPerToolCall: number | null; cacheHitRate: number | null;
  estimatedCostUsd: number | null; costBasis: 'estimated' | 'unknown';
};
type ParsedFile = { job: UsageJob | null; lines: number; bytes: number; warnings: string[] };
const windowInput = z.strictObject({
  from: z.iso.datetime(), to: z.iso.datetime(), limit: z.number().int().min(1).max(100).default(20),
});

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}
function count(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}
function time(value: unknown): number | null {
  return typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
}
function safeModel(value: unknown): string | null {
  return typeof value === 'string' && /^[a-zA-Z0-9._:-]{1,80}$/.test(value) ? value : null;
}
function checkFile(path: string): number {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() ||
    (stat.mode & 0o077) !== 0) {
    throw new OpsError('REFUSED', 'Agent transcript must be an owner-only regular file');
  }
  if (stat.size > 50_000_000) throw new OpsError('QUERY_LIMIT', 'Agent transcript exceeds 50 MB');
  return stat.size;
}

/** Project only named usage metadata; message content and tool payloads are never accessed. */
export async function parseUsageFile(path: string, config: UsageConfig): Promise<ParsedFile> {
  checkFile(path);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const opened = fstatSync(fd);
  if (!opened.isFile() || opened.uid !== process.getuid?.() || (opened.mode & 0o077) !== 0 ||
    opened.size > 50_000_000) {
    closeSync(fd);
    throw new OpsError('REFUSED', 'Agent transcript changed after its file check');
  }
  const bytes = opened.size;
  let lines = 0;
  let sessionId: string | null = null;
  let source: 'codex' | 'claude' | null = null;
  let first: number | null = null;
  let last: number | null = null;
  let toolCalls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let codexTotal: { input: number; output: number; cache: number } | null = null;
  const models = new Set<string>();
  const claudeUsage = new Map<string, number[]>();
  const warnings: string[] = [];
  const stream = createReadStream(path, { encoding: 'utf8', fd, autoClose: true });
  try {
    for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) {
      lines += 1;
      if (lines > 100_000 || line.length > 1_000_000) {
        throw new OpsError('QUERY_LIMIT', 'Agent transcript line or row cap exceeded');
      }
      let value: unknown;
      try { value = JSON.parse(line); } catch { warnings.push('A malformed usage record was skipped'); continue; }
      const item = record(value);
      if (!item) continue;
      const at = time(item.timestamp);
      if (at !== null) { first = first === null ? at : Math.min(first, at);
        last = last === null ? at : Math.max(last, at); }
      const payload = record(item.payload);
      if (item.type === 'session_meta' && payload && typeof payload.id === 'string') {
        sessionId = payload.id;
      }
      if (item.type === 'turn_context' && payload) {
        const model = safeModel(payload.model);
        if (model) models.add(model);
      }
      if (item.type === 'response_item' && payload?.type === 'function_call') toolCalls += 1;
      if (item.type === 'event_msg' && payload?.type === 'token_count') {
        source = 'codex';
        const info = record(payload.info);
        const total = record(info?.total_token_usage);
        if (total) codexTotal = { input: count(total.input_tokens),
          output: count(total.output_tokens), cache: count(total.cached_input_tokens) };
        else {
          const recent = record(info?.last_token_usage);
          if (recent) {
            inputTokens += count(recent.input_tokens);
            outputTokens += count(recent.output_tokens);
            cacheReadTokens += count(recent.cached_input_tokens);
          }
        }
      }
      if (item.type === 'assistant') {
        const message = record(item.message);
        const usage = record(message?.usage);
        if (!usage) continue;
        source = 'claude';
        if (typeof item.sessionId === 'string') sessionId = item.sessionId;
        const model = safeModel(message?.model);
        if (model) models.add(model);
        const raw = [count(usage.input_tokens), count(usage.output_tokens),
          count(usage.cache_read_input_tokens), count(usage.cache_creation_input_tokens)];
        const id = typeof message?.id === 'string' && message.id.length > 0
          ? `id:${message.id}` : `snapshot:${at ?? 'none'}:${model ?? 'unknown'}:${raw.join(':')}`;
        const previous = claudeUsage.get(id);
        claudeUsage.set(id, previous ? raw.map((value, index) => Math.max(value, previous[index] ?? 0)) : raw);
      }
    }
  } finally { stream.destroy(); }
  if (source === 'claude') for (const raw of claudeUsage.values()) {
    inputTokens += raw[0]! + raw[2]! + raw[3]!;
    outputTokens += raw[1]!;
    cacheReadTokens += raw[2]!;
    cacheWriteTokens += raw[3]!;
  }
  if (codexTotal) {
    inputTokens = codexTotal.input;
    outputTokens = codexTotal.output;
    cacheReadTokens = codexTotal.cache;
    cacheWriteTokens = 0;
  }
  if (!sessionId || !source || first === null || last === null ||
    inputTokens + outputTokens === 0) {
    return { job: null, lines, bytes, warnings: [...warnings, 'A file had no complete usage session'] };
  }
  const mapped = Object.hasOwn(config.jobLabels, sessionId) ? config.jobLabels[sessionId] : undefined;
  const label = mapped ?? `job_${createHash('sha256').update(sessionId).digest('hex').slice(0, 12)}`;
  const kind = Object.hasOwn(config.jobKinds, sessionId) ? config.jobKinds[sessionId]! : 'other';
  const model = models.size === 1 ? [...models][0]! : models.size > 1 ? 'mixed' : 'unknown';
  const rate = config.priceTable?.models[model];
  const uncachedInput = Math.max(0, inputTokens - cacheReadTokens - cacheWriteTokens);
  const estimatedCostUsd = rate ? Math.round((uncachedInput * rate.inputPerMillionUsd +
    outputTokens * rate.outputPerMillionUsd + cacheReadTokens * rate.cacheReadPerMillionUsd +
    cacheWriteTokens * rate.cacheWritePerMillionUsd) / 1_000_000 * 1_000_000) / 1_000_000 : null;
  const totalTokens = inputTokens + outputTokens;
  return { job: {
    label, kind, source, model, startedAt: new Date(first).toISOString(),
    endedAt: new Date(last).toISOString(), durationMs: last - first,
    inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens,
    toolCalls: source === 'codex' ? toolCalls : null,
    tokensPerToolCall: source === 'codex' && toolCalls > 0 ? Math.round(totalTokens / toolCalls) : null,
    cacheHitRate: inputTokens > 0 ? Math.round(cacheReadTokens / inputTokens * 10_000) / 10_000 : null,
    estimatedCostUsd, costBasis: estimatedCostUsd === null ? 'unknown' : 'estimated',
  }, lines, bytes, warnings };
}

function percentile(values: number[], fraction: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]!;
}
function weekStart(iso: string): string {
  const date = new Date(iso);
  const shift = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - shift);
  return date.toISOString().slice(0, 10);
}
function money(value: number | null): string { return value === null ? 'unknown' : `$${value.toFixed(6)} estimated`; }
function markdown(jobs: UsageJob[]): string {
  const header = '| Job | Kind | Input | Output | Cache read | Cache write | Cost | Duration ms | Tool calls | Tokens/call | Cache hit |';
  const divider = '| --- | --- | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: |';
  return [header, divider, ...jobs.map((job) => `| ${job.label} | ${job.kind} | ${job.inputTokens} | ${job.outputTokens} | ${job.cacheReadTokens} | ${job.cacheWriteTokens} | ${money(job.estimatedCostUsd)} | ${job.durationMs} | ${job.toolCalls ?? 'unknown'} | ${job.tokensPerToolCall ?? 'unknown'} | ${job.cacheHitRate ?? 'unknown'} |`)].join('\n');
}

export function usageReport(jobs: UsageJob[], priceAsOf: string | null) {
  const kinds = [...new Set(jobs.map((job) => job.kind))].sort();
  const benchmarks = kinds.map((kind) => {
    const group = jobs.filter((job) => job.kind === kind);
    return { kind, jobs: group.length,
      p50Tokens: percentile(group.map((job) => job.inputTokens + job.outputTokens), 0.5),
      p95Tokens: percentile(group.map((job) => job.inputTokens + job.outputTokens), 0.95),
      p50DurationMs: percentile(group.map((job) => job.durationMs), 0.5),
      p95DurationMs: percentile(group.map((job) => job.durationMs), 0.95) };
  });
  const totalEstimatedCost = jobs.length > 0 && jobs.every((job) => job.estimatedCostUsd !== null)
    ? Math.round(jobs.reduce((sum, job) => sum + (job.estimatedCostUsd ?? 0), 0) * 1_000_000) / 1_000_000
    : null;
  return { jobs, benchmarks, totals: { jobs: jobs.length,
    inputTokens: jobs.reduce((sum, job) => sum + job.inputTokens, 0),
    outputTokens: jobs.reduce((sum, job) => sum + job.outputTokens, 0),
    cacheReadTokens: jobs.reduce((sum, job) => sum + job.cacheReadTokens, 0),
    cacheWriteTokens: jobs.reduce((sum, job) => sum + job.cacheWriteTokens, 0),
    estimatedCostUsd: totalEstimatedCost,
    costBasis: totalEstimatedCost === null ? 'unknown' as const : 'estimated' as const,
    priceAsOf }, markdown: markdown(jobs) };
}

export function usageTrend(jobs: UsageJob[], to: string) {
  const buckets = new Map<string, { week: string; kind: JobKind; jobs: number; tokens: number }>();
  for (const job of jobs) {
    const week = weekStart(job.endedAt);
    const key = `${week}:${job.kind}`;
    const current = buckets.get(key) ?? { week, kind: job.kind, jobs: 0, tokens: 0 };
    current.jobs += 1;
    current.tokens += job.inputTokens + job.outputTokens;
    buckets.set(key, current);
  }
  const weeks = [...buckets.values()].sort((a, b) => a.week.localeCompare(b.week) || a.kind.localeCompare(b.kind));
  const latest = weekStart(to);
  const previous = weekStart(new Date(Date.parse(latest) - 7 * 86_400_000).toISOString());
  const kinds = [...new Set(jobs.map((job) => job.kind))].sort();
  const drift = kinds.map((kind) => {
    const current = buckets.get(`${latest}:${kind}`)?.tokens ?? 0;
    const prior = buckets.get(`${previous}:${kind}`)?.tokens ?? 0;
    return { kind, currentWeekTokens: current, previousWeekTokens: prior,
      weekOverWeekPct: prior > 0 ? Math.round((current - prior) / prior * 10_000) / 100 : null };
  });
  const table = ['| Week (UTC) | Kind | Jobs | Tokens |', '| --- | --- | ---: | ---: |',
    ...weeks.map((item) => `| ${item.week} | ${item.kind} | ${item.jobs} | ${item.tokens} |`)].join('\n');
  return { weeks, drift, markdown: table };
}

/** Pure numeric projection; this module does not send a PostHog event. */
export function usagePostHogEvent(job: UsageJob) {
  return { event: 'ops_lens_agent_usage', properties: { job_label: job.label,
    job_kind: job.kind, input_tokens: job.inputTokens, output_tokens: job.outputTokens,
    cache_read_tokens: job.cacheReadTokens, cache_write_tokens: job.cacheWriteTokens,
    duration_ms: job.durationMs, tool_calls: job.toolCalls, privacy_mode: true } };
}

export class AgentUsageProvider implements ProviderModule {
  readonly id = 'agent-usage';

  preflight(config: Config): void {
    const usage = config.providers.agentUsage;
    if (!usage?.enabled) return;
    for (const file of usage.files) checkFile(file);
  }

  register(server: McpServer, context: { config: Config; runtime: ToolRuntime }): void {
    const usage = context.config.providers.agentUsage;
    if (!usage?.enabled) return;
    for (const [name, trend] of [['agent_usage_report', false], ['agent_usage_trend', true]] as const) {
      server.registerTool(name, { description: `Summarize allowlisted numeric fields from configured local transcripts. ${UNTRUSTED_DATA_NOTICE}`,
        inputSchema: auditedInput(windowInput), outputSchema: ToolResultSchema,
        annotations: { readOnlyHint: true },
      }, async (raw) => runValidatedTool(context.runtime, name, this.id, raw, windowInput,
        (input) => this.query(usage, input, trend)));
    }
  }

  private async query(usage: UsageConfig, input: z.output<typeof windowInput>, trend: boolean): Promise<ToolResult> {
    const from = Date.parse(input.from);
    const to = Date.parse(input.to);
    if (to <= from || to - from > 90 * 86_400_000) {
      throw new OpsError('QUERY_LIMIT', 'Agent usage window must be positive and at most 90 days');
    }
    const files = await Promise.all(usage.files.map((file) => parseUsageFile(file, usage)));
    const all = files.flatMap((file) => file.job ? [file.job] : [])
      .filter((job) => Date.parse(job.endedAt) >= from && Date.parse(job.endedAt) <= to)
      .sort((a, b) => b.endedAt.localeCompare(a.endedAt));
    const jobs = all.slice(0, input.limit);
    const truncated = !trend && all.length > jobs.length;
    const warnings = [...new Set(files.flatMap((file) => file.warnings))];
    if (truncated) warnings.push('Agent usage result capped');
    if (!usage.priceTable) warnings.push('Estimated cost unavailable without a dated price table');
    if (jobs.some((job) => job.toolCalls === null)) warnings.push('Tool-call count unavailable for some transcript sources');
    const data = trend ? usageTrend(all, input.to) : usageReport(jobs, usage.priceTable?.asOf ?? null);
    return { data,
      examined: examined(this.id, 'Usage-only fields from configured local transcripts', {
        window: { from: input.from, to: input.to }, rowCount: trend ? (data as ReturnType<typeof usageTrend>).weeks.length : jobs.length,
        scannedCount: files.reduce((sum, file) => sum + file.lines, 0),
        byteCount: files.reduce((sum, file) => sum + file.bytes, 0), truncated, warnings,
      }) };
  }
}
