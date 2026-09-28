import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigSchema } from '../src/core/config.js';
import { Redactor } from '../src/core/redaction.js';
import { CloudWatchProvider, cloudWatchLogLimit } from '../src/providers/cloudwatch.js';
import type { CloudWatchReadApi, LogQueryResult } from '../src/providers/aws-cloudwatch-api.js';
import { createServer } from '../src/server.js';

const from = '2026-01-01T00:00:00.000Z';
const to = '2026-01-01T00:30:00.000Z';

class FakeCloudWatch implements CloudWatchReadApi {
  calls: string[] = [];
  stopped = false;
  nextLogs: LogQueryResult = { status: 'Complete', rows: [[{ field: '@message', value: 'synthetic' }]],
    bytesScanned: 128, recordsScanned: 1 };

  async policySourceArn(): Promise<string> { this.calls.push('GetCallerIdentity'); return 'arn:aws:iam::000000000000:user/demo'; }
  async simulateWrites(_arn: string, actions: readonly string[]): Promise<Record<string, boolean>> {
    void _arn;
    this.calls.push('SimulatePrincipalPolicy');
    return Object.fromEntries(actions.map((action) => [action, false]));
  }
  async metric() {
    this.calls.push('GetMetricData');
    return { points: [{ at: from, value: 1 }], partial: false };
  }
  async alarms() {
    this.calls.push('DescribeAlarms');
    return { rows: [{ name: 'demo-alarm', state: 'OK', updatedAt: from }], more: false };
  }
  async logGroup(name: string) {
    this.calls.push('DescribeLogGroups');
    return { name, storedBytes: 42 };
  }
  async startLogs(): Promise<string> {
    this.calls.push('StartQuery');
    return 'synthetic-query';
  }
  async pollLogs(): Promise<LogQueryResult> {
    this.calls.push('GetQueryResults');
    return this.nextLogs;
  }
  async stopLogs(): Promise<void> { this.calls.push('StopQuery'); this.stopped = true; }
}

async function harness(api: FakeCloudWatch, timeoutMs = 20000) {
  const auditPath = join(mkdtempSync(join(tmpdir(), 'ops-cloudwatch-')), 'audit.jsonl');
  const config = ConfigSchema.parse({ version: 1, audit: { path: auditPath },
    limits: { timeoutMs },
    providers: { cloudwatch: { enabled: true, region: 'us-east-1', profile: 'synthetic',
      credentialsFile: '/tmp/synthetic-cloudwatch-credentials', logGroups: ['/demo/allowed'],
      maxScanBytes: 1024 } },
  });
  const provider = new CloudWatchProvider(() => api);
  await provider.preflight(config);
  const server = createServer(config, [provider]);
  const client = new Client({ name: 'cloudwatch-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

describe('CloudWatch read boundary', () => {
  // @guardrail G4.1: the adapter exposes fixed read calls, and the provider issues only them.
  it('uses only named CloudWatch read actions for its four tools', async () => {
    const api = new FakeCloudWatch();
    const fixture = await harness(api);
    try {
      const requests = [
        ['cloudwatch_metric_data', { from, to, namespace: 'AWS/EC2', metricName: 'CPUUtilization' }],
        ['cloudwatch_alarms', {}],
        ['cloudwatch_log_groups', {}],
        ['cloudwatch_logs_insights', { from, to, logGroups: ['/demo/allowed'],
          query: 'fields @message | limit 1' }],
      ] as const;
      for (const [name, args] of requests) {
        const result = await fixture.client.callTool({ name, arguments: args });
        expect(result.isError).toBe(false);
      }
      expect(api.calls).toEqual(['GetCallerIdentity', 'SimulatePrincipalPolicy', 'GetMetricData',
        'DescribeAlarms', 'DescribeLogGroups', 'StartQuery', 'GetQueryResults']);
    } finally { await fixture.close(); }
  });

  // @guardrail G4.2: an unconfigured log group is rejected before StartQuery.
  it('refuses Logs Insights on a group outside the config allowlist', async () => {
    const api = new FakeCloudWatch();
    const fixture = await harness(api);
    try {
      const result = await fixture.client.callTool({ name: 'cloudwatch_logs_insights', arguments: {
        from, to, logGroups: ['/demo/other'], query: 'fields @message | limit 1',
      } });
      expect(result.structuredContent).toMatchObject({ data: { code: 'QUERY_LIMIT' } });
      expect(api.calls).not.toContain('StartQuery');
    } finally { await fixture.close(); }
  });

  // @guardrail G4.3: bounded query text, time, scan accounting and StopQuery on refusal.
  it('requires a terminal limit and reports scanned bytes when it stops an over-cap query', async () => {
    expect(() => cloudWatchLogLimit('fields @message')).toThrow('must end');
    expect(() => cloudWatchLogLimit('fields @message | limit 1001')).toThrow('must end');
    expect(() => cloudWatchLogLimit('SOURCE /demo/other | limit 1')).toThrow('SOURCE');
    const api = new FakeCloudWatch();
    api.nextLogs = { status: 'Running', rows: [], bytesScanned: 1025, recordsScanned: 11 };
    const fixture = await harness(api);
    try {
      const result = await fixture.client.callTool({ name: 'cloudwatch_logs_insights', arguments: {
        from, to, logGroups: ['/demo/allowed'], query: 'fields @message | limit 1',
      } });
      expect(result.structuredContent).toMatchObject({ data: { code: 'QUERY_LIMIT' },
        examined: { byteCount: 1025, scannedCount: 11, truncated: true } });
      expect(api.stopped).toBe(true);
    } finally { await fixture.close(); }
  });

  it('refuses a Logs Insights window over one hour before starting a query', async () => {
    const api = new FakeCloudWatch();
    const fixture = await harness(api);
    try {
      const result = await fixture.client.callTool({ name: 'cloudwatch_logs_insights', arguments: {
        from, to: '2026-01-01T01:01:00.000Z', logGroups: ['/demo/allowed'],
        query: 'fields @message | limit 1',
      } });
      expect(result.structuredContent).toMatchObject({ data: { code: 'QUERY_LIMIT' } });
      expect(api.calls).not.toContain('StartQuery');
    } finally { await fixture.close(); }
  });

  it('stops a running Logs Insights query when the deadline expires', async () => {
    const api = new FakeCloudWatch();
    api.nextLogs = { status: 'Running', rows: [], bytesScanned: 64, recordsScanned: 2 };
    const fixture = await harness(api, 1000);
    try {
      const result = await fixture.client.callTool({ name: 'cloudwatch_logs_insights', arguments: {
        from, to, logGroups: ['/demo/allowed'], query: 'fields @message | limit 1',
      } });
      expect(result.structuredContent).toMatchObject({ data: { code: 'QUERY_LIMIT' },
        examined: { byteCount: 64, scannedCount: 2, truncated: true } });
      expect(api.stopped).toBe(true);
    } finally { await fixture.close(); }
  });

  // @guardrail G4.4: account IDs and ARNs are redacted by default, with an explicit config switch.
  it('redacts AWS identifiers by default and permits an explicit local opt-out', () => {
    const configured = ConfigSchema.parse({ version: 1, audit: { path: '/tmp/synthetic-audit' } });
    const planted = 'account 000000000000 arn:aws:iam::000000000000:role/synthetic';
    expect(new Redactor(configured.redaction).text(planted)).not.toContain('000000000000');
    expect(new Redactor(configured.redaction).text(planted)).not.toContain('arn:aws:iam');
    const disabled = ConfigSchema.parse({ version: 1, audit: { path: '/tmp/synthetic-audit' },
      redaction: { awsIdentifiers: false } });
    expect(new Redactor(disabled.redaction).text(planted)).toContain('000000000000');
  });
});
