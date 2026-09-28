import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { chmodSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { ConfigSchema } from '../src/core/config.js';
import { AgentUsageProvider, parseUsageFile, usagePostHogEvent,
  usageReport, usageTrend, type UsageJob } from '../src/providers/agent-usage.js';
import { createServer } from '../src/server.js';

function syntheticFiles() {
  const directory = mkdtempSync(join(tmpdir(), 'ops-lens-usage-'));
  const codex = join(directory, 'codex.jsonl');
  const claude = join(directory, 'claude.jsonl');
  const planted = 'SYNTHETIC_SECRET_DO_NOT_EXPORT fake@example.test /private/synthetic/branch-name';
  writeFileSync(codex, [
    { type: 'session_meta', timestamp: '2026-01-05T00:00:00.000Z', payload: {
      id: 'session-alpha', cwd: planted } },
    { type: 'turn_context', timestamp: '2026-01-05T00:00:01.000Z', payload: {
      model: 'synthetic-model-v1', user_message: planted } },
    { type: 'response_item', timestamp: '2026-01-05T00:00:15.000Z', payload: {
      type: 'function_call', arguments: planted, output: planted } },
    { type: 'event_msg', timestamp: '2026-01-05T00:01:00.000Z', payload: { type: 'token_count',
      info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 40,
        output_tokens: 20 } }, message: planted } },
  ].map((entry) => JSON.stringify(entry)).join('\n'), { mode: 0o600 });
  const assistant = { type: 'assistant', timestamp: '2026-01-12T00:01:00.000Z',
    sessionId: 'session-beta', message: { id: 'msg-synthetic-1', model: 'synthetic-model-v1',
      usage: { input_tokens: 50, output_tokens: 10, cache_read_input_tokens: 20,
        cache_creation_input_tokens: 5 }, content: planted, tool_input: planted } };
  writeFileSync(claude, [
    { type: 'system', timestamp: '2026-01-12T00:00:00.000Z', sessionId: 'session-beta', text: planted },
    assistant, assistant, { ...assistant, timestamp: '2026-01-12T00:02:00.000Z' },
  ].map((entry) => JSON.stringify(entry)).join('\n'), { mode: 0o600 });
  return { directory, codex, claude, planted };
}

function config(files: string[], price = true) {
  return ConfigSchema.parse({ version: 1,
    audit: { path: join(mkdtempSync(join(tmpdir(), 'ops-lens-usage-audit-')), 'audit.jsonl') },
    providers: { agentUsage: { enabled: true, files,
      jobLabels: { 'session-alpha': 'PR-123' },
      jobKinds: { 'session-alpha': 'feature', 'session-beta': 'feature' },
      ...(price ? { priceTable: { asOf: '2026-01-01', models: { 'synthetic-model-v1': {
        inputPerMillionUsd: 1, outputPerMillionUsd: 2,
        cacheReadPerMillionUsd: 0.1, cacheWritePerMillionUsd: 1.25,
      } } } } : {}),
    } },
  });
}

// @guardrail G12.1: only usage metadata survives the parser; planted text and tool payloads do not.
// @guardrail G12.2: job names are explicit PR labels or hashes of session IDs, never paths.
it('projects numeric Codex and Claude usage without planted content', async () => {
  const files = syntheticFiles();
  const source = config([files.codex, files.claude]);
  const usage = source.providers.agentUsage!;
  const first = await parseUsageFile(files.codex, usage);
  const second = await parseUsageFile(files.claude, usage);
  expect(first.job).toMatchObject({ label: 'PR-123', inputTokens: 100,
    outputTokens: 20, cacheReadTokens: 40, toolCalls: 1 });
  expect(second.job).toMatchObject({ inputTokens: 75, outputTokens: 10,
    cacheReadTokens: 20, cacheWriteTokens: 5, toolCalls: null });
  expect(second.job?.label).toMatch(/^job_[a-f0-9]{12}$/);
  const raw = JSON.stringify({ first, second });
  expect(JSON.stringify(files)).toContain(files.planted);
  expect(raw).not.toContain('SYNTHETIC_SECRET_DO_NOT_EXPORT');
  expect(raw).not.toContain('fake@example.test');
  expect(raw).not.toContain('/private/synthetic');
  expect(raw).not.toContain('branch-name');
});

it('serves a bounded report and weekly trend through real MCP calls', async () => {
  const files = syntheticFiles();
  const source = config([files.codex, files.claude]);
  const provider = new AgentUsageProvider();
  provider.preflight(source);
  const server = createServer(source, [provider]);
  const client = new Client({ name: 'usage-test', version: '1.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  await client.connect(a);
  try {
    const args = { from: '2026-01-01T00:00:00.000Z', to: '2026-01-14T00:00:00.000Z' };
    const report = await client.callTool({ name: 'agent_usage_report', arguments: args });
    expect(report.isError).toBe(false);
    expect(report.structuredContent).toMatchObject({ data: { totals: {
      jobs: 2, inputTokens: 175, outputTokens: 30, costBasis: 'estimated', priceAsOf: '2026-01-01',
    }, benchmarks: [{ kind: 'feature', jobs: 2, p50Tokens: 85, p95Tokens: 120 }] },
    examined: { provider: 'agent-usage', rowCount: 2 } });
    expect(JSON.stringify(report)).not.toContain('SYNTHETIC_SECRET_DO_NOT_EXPORT');
    expect(JSON.stringify(report)).not.toContain('fake@example.test');
    expect(JSON.stringify(report)).not.toContain('/private/synthetic');
    const trend = await client.callTool({ name: 'agent_usage_trend', arguments: { ...args, limit: 1 } });
    expect(trend.structuredContent).toMatchObject({ data: { drift: [{ kind: 'feature',
      currentWeekTokens: 85, previousWeekTokens: 120 }] }, examined: { truncated: false, rowCount: 2 } });
    const refused = await client.callTool({ name: 'agent_usage_report', arguments: {
      from: args.from, to: '2026-07-01T00:00:00.000Z',
    } });
    expect(refused.isError).toBe(true);
  } finally { await client.close(); await server.close(); }
});

it('refuses exposed or linked transcript files before registering tools', () => {
  const files = syntheticFiles();
  chmodSync(files.codex, 0o644);
  expect(() => new AgentUsageProvider().preflight(config([files.codex]))).toThrow('owner-only');
  const link = join(files.directory, 'linked.jsonl');
  symlinkSync(files.claude, link);
  expect(() => new AgentUsageProvider().preflight(config([link]))).toThrow('owner-only');
});

// @guardrail G12.3: a possible PostHog projection carries only safe labels and numeric fields.
it('keeps optional PostHog event projections free of prompts and response properties', async () => {
  const files = syntheticFiles();
  const job = (await parseUsageFile(files.codex, config([files.codex]).providers.agentUsage!)).job!;
  const event = usagePostHogEvent(job);
  expect(event.properties).toMatchObject({ job_label: 'PR-123', input_tokens: 100, privacy_mode: true });
  expect(Object.keys(event.properties).sort()).toEqual([
    'cache_read_tokens', 'cache_write_tokens', 'duration_ms', 'input_tokens',
    'job_kind', 'job_label', 'output_tokens', 'privacy_mode', 'tool_calls',
  ]);
  expect(JSON.stringify(event)).not.toMatch(/\$ai_input|\$ai_output|SYNTHETIC_SECRET/);
});

// @guardrail G12.4: OTel guidance disables content logging and separates export and read credentials.
// @guardrail G12.5: no Anthropic Admin API credential is accepted by default.
it('documents privacy-first OTel and rejects an admin-key config path', () => {
  const docs = readFileSync('docs/agent-usage.md', 'utf8');
  for (const name of ['OTEL_LOG_USER_PROMPTS=0', 'OTEL_LOG_ASSISTANT_RESPONSES=0',
    'OTEL_LOG_TOOL_DETAILS=0', 'OTEL_LOG_TOOL_CONTENT=0']) expect(docs).toContain(name);
  expect(docs).toContain('OTEL_LOG_RAW_API_BODIES');
  expect(docs).toContain('OTEL_METRICS_INCLUDE_ACCOUNT_UUID=false');
  expect(docs).toContain('write-only metrics token');
  expect(() => ConfigSchema.parse({ version: 1, audit: { path: '/tmp/synthetic-audit' },
    providers: { anthropicAdmin: { enabled: true, tokenEnv: 'ADMIN_KEY' } } })).toThrow();
});

it('keeps unknown cost and zero-baseline drift explicit', () => {
  const job: UsageJob = { label: 'PR-1', kind: 'review', source: 'codex', model: 'unknown',
    startedAt: '2026-01-12T00:00:00.000Z', endedAt: '2026-01-12T00:01:00.000Z',
    durationMs: 60_000, inputTokens: 10, outputTokens: 5, cacheReadTokens: 0,
    cacheWriteTokens: 0, toolCalls: 0, tokensPerToolCall: null,
    cacheHitRate: 0, estimatedCostUsd: null, costBasis: 'unknown' };
  expect(usageReport([job], null).totals).toMatchObject({ estimatedCostUsd: null, costBasis: 'unknown' });
  expect(usageTrend([job], '2026-01-14T00:00:00.000Z').drift).toMatchObject([
    { kind: 'review', weekOverWeekPct: null },
  ]);
});
