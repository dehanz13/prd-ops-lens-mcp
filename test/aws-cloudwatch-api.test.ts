import { DescribeAlarmsCommand, GetMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { DescribeLogGroupsCommand, GetQueryResultsCommand, StartQueryCommand,
  StopQueryCommand } from '@aws-sdk/client-cloudwatch-logs';
import { GetRoleCommand, SimulatePrincipalPolicyCommand } from '@aws-sdk/client-iam';
import { GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { ConfigSchema } from '../src/core/config.js';
import { readIsolatedAwsProfile, SdkCloudWatchReadApi } from '../src/providers/aws-cloudwatch-api.js';
import metricFixture from './fixtures/cloudwatch/metric.json' with { type: 'json' };
import logsFixture from './fixtures/cloudwatch/logs-query.json' with { type: 'json' };

function adapter() {
  const credentialsFile = join(mkdtempSync(join(tmpdir(), 'ops-aws-adapter-')), 'credentials');
  writeFileSync(credentialsFile, '[synthetic]\naws_access_key_id = synthetic\naws_secret_access_key = synthetic\n',
    { mode: 0o600 });
  const config = ConfigSchema.parse({ version: 1, audit: { path: '/tmp/synthetic-audit' },
    providers: { cloudwatch: { enabled: true, region: 'us-east-1', profile: 'synthetic',
      credentialsFile, logGroups: ['/demo/allowed'] } },
  }).providers.cloudwatch!;
  return new SdkCloudWatchReadApi(config, 1000);
}

function replaceClient(api: SdkCloudWatchReadApi, key: string, send: (command: unknown) => unknown) {
  Object.assign(api, { [key]: { send: async (command: unknown) => send(command) } });
}

// @guardrail G4.1: the real SDK adapter constructs only named read and query-lifecycle commands.
it('maps CloudWatch metric, alarm, group and Logs Insights reads to fixed SDK commands', async () => {
  const api = adapter();
  const calls: string[] = [];
  replaceClient(api, 'metricClient', (command) => {
    calls.push(command!.constructor.name);
    if (command instanceof GetMetricDataCommand) {
      expect(command.input.MetricDataQueries?.[0]?.MetricStat?.Metric?.MetricName).toBe('CPUUtilization');
      return { MetricDataResults: metricFixture.MetricDataResults.map((series) => ({ ...series,
        Timestamps: series.Timestamps.map((timestamp) => new Date(timestamp)),
      })) };
    }
    if (command instanceof DescribeAlarmsCommand) {
      return { MetricAlarms: [{ AlarmName: 'demo-alarm', StateValue: 'OK',
        StateUpdatedTimestamp: new Date('2026-01-01T00:00:00Z') }] };
    }
    throw new Error('unexpected CloudWatch command');
  });
  replaceClient(api, 'logsClient', (command) => {
    calls.push(command!.constructor.name);
    if (command instanceof DescribeLogGroupsCommand) {
      expect(command.input.logGroupNamePrefix).toBe('/demo/allowed');
      return { logGroups: [{ logGroupName: '/demo/allowed', storedBytes: 42 }] };
    }
    if (command instanceof StartQueryCommand) {
      expect(command.input.logGroupNames).toEqual(['/demo/allowed']);
      expect(command.input.limit).toBe(1);
      return { queryId: 'synthetic-query' };
    }
    if (command instanceof GetQueryResultsCommand) {
      return logsFixture;
    }
    if (command instanceof StopQueryCommand) return { success: true };
    throw new Error('unexpected Logs command');
  });
  const metric = await api.metric({ namespace: 'AWS/EC2', metricName: 'CPUUtilization',
    dimensions: {}, statistic: 'Average', periodSeconds: 60, from: '2026-01-01T00:00:00Z',
    to: '2026-01-01T00:01:00Z', maxPoints: 2 });
  expect(metric).toEqual({ points: [{ at: '2026-01-01T00:00:00.000Z', value: 3 }], partial: false });
  expect(await api.alarms(1)).toMatchObject({ rows: [{ name: 'demo-alarm', state: 'OK' }], more: false });
  expect(await api.logGroup('/demo/allowed')).toEqual({ name: '/demo/allowed', storedBytes: 42 });
  const queryId = await api.startLogs(['/demo/allowed'], '2026-01-01T00:00:00Z',
    '2026-01-01T00:01:00Z', 'fields @message | limit 1', 1, 500);
  expect(queryId).toBe('synthetic-query');
  expect(await api.pollLogs(queryId, 500)).toMatchObject({ status: 'Complete',
    bytesScanned: 512, recordsScanned: 2 });
  await api.stopLogs(queryId);
  expect(calls).toEqual(['GetMetricDataCommand', 'DescribeAlarmsCommand',
    'DescribeLogGroupsCommand', 'StartQueryCommand', 'GetQueryResultsCommand', 'StopQueryCommand']);
});

it('verifies AWS identities and refuses incomplete permission simulation', async () => {
  const api = adapter();
  replaceClient(api, 'stsClient', (command) => {
    expect(command).toBeInstanceOf(GetCallerIdentityCommand);
    return { Arn: 'arn:aws:sts::000000000000:assumed-role/synthetic-role/session',
      Account: '000000000000', UserId: 'ROLEID:session' };
  });
  replaceClient(api, 'iamClient', (command) => {
    if (command instanceof GetRoleCommand) return { Role: {
      Arn: 'arn:aws:iam::000000000000:role/synthetic-role', RoleId: 'ROLEID',
    } };
    if (command instanceof SimulatePrincipalPolicyCommand) return { EvaluationResults: [
      { EvalActionName: 'iam:CreateRole', EvalDecision: 'explicitDeny' },
    ] };
    throw new Error('unexpected IAM command');
  });
  expect(await api.policySourceArn()).toBe('arn:aws:iam::000000000000:role/synthetic-role');
  expect(await api.simulateWrites('arn:aws:iam::000000000000:role/synthetic-role',
    ['iam:CreateRole'])).toEqual({ 'iam:CreateRole': false });
});

// @guardrail G0.9: the CloudWatch provider cannot inherit another AWS profile or run a credential process.
it('accepts only one isolated static or temporary credential profile', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'ops-aws-isolation-')), 'credentials');
  const write = (body: string) => writeFileSync(path, body, { mode: 0o600 });
  write('[synthetic]\naws_access_key_id = synthetic\naws_secret_access_key = synthetic\n');
  expect(readIsolatedAwsProfile(path, 'synthetic')).toMatchObject({ accessKeyId: 'synthetic' });
  write('[synthetic]\ncredential_process = echo unexpected\n');
  expect(() => readIsolatedAwsProfile(path, 'synthetic')).toThrow('unsupported setting');
  write('[synthetic]\nsource_profile = admin\n');
  expect(() => readIsolatedAwsProfile(path, 'synthetic')).toThrow('unsupported setting');
  write('[synthetic]\naws_access_key_id = synthetic\naws_secret_access_key = synthetic\n[admin]\n');
  expect(() => readIsolatedAwsProfile(path, 'synthetic')).toThrow('only the configured profile');
});
