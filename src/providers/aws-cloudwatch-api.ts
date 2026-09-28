import { CloudWatchClient, DescribeAlarmsCommand, GetMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { CloudWatchLogsClient, DescribeLogGroupsCommand, GetQueryResultsCommand,
  StartQueryCommand, StopQueryCommand } from '@aws-sdk/client-cloudwatch-logs';
import { GetRoleCommand, IAMClient, SimulatePrincipalPolicyCommand } from '@aws-sdk/client-iam';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { readPrivateCredentialFile, type Config } from '../core/config.js';
import { OpsError } from '../core/result.js';
import { installAwsReadGuard } from './aws-read-guard.js';
import { completeWriteSimulation } from './aws-write-simulation.js';

type CloudWatchConfig = NonNullable<Config['providers']['cloudwatch']>;

export type MetricRequest = {
  namespace: string;
  metricName: string;
  dimensions: Record<string, string>;
  statistic: 'Average' | 'Sum' | 'Minimum' | 'Maximum' | 'SampleCount';
  periodSeconds: number;
  from: string;
  to: string;
  maxPoints: number;
};

export type LogQueryResult = {
  status: string;
  rows: Array<Array<{ field: string; value: string }>>;
  bytesScanned: number | null;
  recordsScanned: number | null;
};

export interface CloudWatchReadApi {
  policySourceArn(): Promise<string>;
  simulateWrites(arn: string, actions: readonly string[]): Promise<Record<string, boolean>>;
  metric(request: MetricRequest): Promise<{ points: Array<{ at: string; value: number }>; partial: boolean }>;
  alarms(limit: number): Promise<{ rows: Array<{ name: string; state: string; updatedAt: string | null }>; more: boolean }>;
  logGroup(name: string, timeoutMs: number): Promise<{ name: string; storedBytes: number | null } | null>;
  startLogs(groups: string[], from: string, to: string, query: string, limit: number,
    timeoutMs: number): Promise<string>;
  pollLogs(queryId: string, timeoutMs: number): Promise<LogQueryResult>;
  stopLogs(queryId: string): Promise<void>;
}

export function readIsolatedAwsProfile(path: string, profile: string) {
  const content = readPrivateCredentialFile(path);
  const values: Record<string, string> = {};
  let inProfile = false;
  let sections = 0;
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const section = line.match(/^\[([^\]]+)\]$/);
    if (section) {
      sections += 1;
      inProfile = section[1] === profile;
      if (!inProfile || sections > 1) throw new OpsError('REFUSED', 'AWS credential file must contain only the configured profile');
      continue;
    }
    const entry = line.match(/^([a-z_]+)\s*=\s*(.+)$/);
    if (!inProfile || !entry || !['aws_access_key_id', 'aws_secret_access_key', 'aws_session_token'].includes(entry[1]!) ||
      values[entry[1]!] !== undefined) {
      throw new OpsError('REFUSED', 'AWS credential file contains an unsupported setting');
    }
    values[entry[1]!] = entry[2]!.trim();
  }
  if (sections !== 1 || !values.aws_access_key_id || !values.aws_secret_access_key) {
    throw new OpsError('REFUSED', 'AWS credential file lacks the configured static profile');
  }
  return { accessKeyId: values.aws_access_key_id, secretAccessKey: values.aws_secret_access_key,
    ...(values.aws_session_token ? { sessionToken: values.aws_session_token } : {}) };
}

export class SdkCloudWatchReadApi implements CloudWatchReadApi {
  private readonly metricClient: CloudWatchClient;
  private readonly logsClient: CloudWatchLogsClient;
  private readonly iamClient: IAMClient;
  private readonly stsClient: STSClient;

  constructor(private readonly config: CloudWatchConfig, private readonly timeoutMs: number) {
    const credentials = readIsolatedAwsProfile(config.credentialsFile, config.profile);
    const options = { region: config.region, credentials, maxAttempts: 1 };
    this.metricClient = installAwsReadGuard(new CloudWatchClient(options));
    this.logsClient = installAwsReadGuard(new CloudWatchLogsClient(options));
    this.iamClient = installAwsReadGuard(new IAMClient(options));
    this.stsClient = installAwsReadGuard(new STSClient(options));
  }

  private signal(timeoutMs = this.timeoutMs): AbortSignal {
    return AbortSignal.timeout(Math.max(1, Math.min(timeoutMs, this.timeoutMs)));
  }

  async policySourceArn(): Promise<string> {
    const identity = await this.stsClient.send(new GetCallerIdentityCommand({}), { abortSignal: this.signal() });
    if (!identity.Arn || !identity.Account || !identity.UserId) {
      throw new OpsError('REFUSED', 'AWS identity could not be verified');
    }
    if (/^arn:aws:iam::\d{12}:user\//.test(identity.Arn)) return identity.Arn;
    const match = identity.Arn.match(/^arn:aws:sts::(\d{12}):assumed-role\/([^/]+)\/[^/]+$/);
    if (!match || match[1] !== identity.Account) {
      throw new OpsError('REFUSED', 'AWS assumed role could not be verified');
    }
    const role = await this.iamClient.send(new GetRoleCommand({ RoleName: match[2] }),
      { abortSignal: this.signal() });
    if (!role.Role?.Arn || !role.Role.RoleId ||
      !role.Role.Arn.startsWith(`arn:aws:iam::${identity.Account}:role/`) ||
      identity.UserId.split(':')[0] !== role.Role.RoleId) {
      throw new OpsError('REFUSED', 'AWS assumed role could not be verified');
    }
    return role.Role.Arn;
  }

  async simulateWrites(arn: string, actions: readonly string[]): Promise<Record<string, boolean>> {
    const response = await this.iamClient.send(new SimulatePrincipalPolicyCommand({
      PolicySourceArn: arn, ActionNames: [...actions], ResourceArns: ['*'],
    }), { abortSignal: this.signal() });
    return completeWriteSimulation(actions, response);
  }

  async metric(request: MetricRequest): Promise<{ points: Array<{ at: string; value: number }>; partial: boolean }> {
    const response = await this.metricClient.send(new GetMetricDataCommand({
      StartTime: new Date(request.from), EndTime: new Date(request.to),
      MetricDataQueries: [{ Id: 'metric1', MetricStat: {
        Metric: { Namespace: request.namespace, MetricName: request.metricName,
          Dimensions: Object.entries(request.dimensions).map(([Name, Value]) => ({ Name, Value })) },
        Period: request.periodSeconds, Stat: request.statistic,
      } }],
      MaxDatapoints: request.maxPoints, ScanBy: 'TimestampAscending',
    }), { abortSignal: this.signal() });
    const series = response.MetricDataResults?.[0];
    const timestamps = series?.Timestamps ?? [];
    const values = series?.Values ?? [];
    if (timestamps.length !== values.length) throw new OpsError('UPSTREAM', 'CloudWatch metric response was malformed');
    return { points: timestamps.map((at, index) => ({ at: at.toISOString(), value: values[index]! })),
      partial: Boolean(response.NextToken || series?.StatusCode !== 'Complete') };
  }

  async alarms(limit: number): Promise<{ rows: Array<{ name: string; state: string; updatedAt: string | null }>; more: boolean }> {
    const response = await this.metricClient.send(new DescribeAlarmsCommand({
      MaxRecords: limit, AlarmTypes: ['MetricAlarm', 'CompositeAlarm'],
    }),
      { abortSignal: this.signal() });
    const all = [...(response.MetricAlarms ?? []), ...(response.CompositeAlarms ?? [])];
    return { rows: all.slice(0, limit).map((alarm) => ({
      name: alarm.AlarmName ?? 'Unnamed alarm', state: alarm.StateValue ?? 'UNKNOWN',
      updatedAt: alarm.StateUpdatedTimestamp?.toISOString() ?? null,
    })), more: Boolean(response.NextToken || all.length > limit) };
  }

  async logGroup(name: string, timeoutMs = this.timeoutMs): Promise<{ name: string; storedBytes: number | null } | null> {
    const deadline = Date.now() + Math.min(timeoutMs, this.timeoutMs);
    let nextToken: string | undefined;
    for (let page = 0; page < 3; page += 1) {
      if (Date.now() >= deadline) throw new OpsError('QUERY_LIMIT', 'CloudWatch log group lookup timed out');
      const response = await this.logsClient.send(new DescribeLogGroupsCommand({
        logGroupNamePrefix: name, limit: 50, nextToken,
      }), { abortSignal: this.signal(deadline - Date.now()) });
      const exact = response.logGroups?.find((group) => group.logGroupName === name);
      if (exact) return { name, storedBytes: exact.storedBytes ?? null };
      nextToken = response.nextToken;
      if (!nextToken) return null;
    }
    throw new OpsError('QUERY_LIMIT', 'CloudWatch log group lookup exceeded its page cap');
  }

  async startLogs(groups: string[], from: string, to: string, query: string, limit: number,
    timeoutMs: number): Promise<string> {
    if (Date.parse(from) % 1000 !== 0 || Date.parse(to) % 1000 !== 0) {
      throw new OpsError('QUERY_LIMIT', 'CloudWatch log window must use whole UTC seconds');
    }
    const response = await this.logsClient.send(new StartQueryCommand({
      queryLanguage: 'CWLI', logGroupNames: groups,
      startTime: Math.floor(Date.parse(from) / 1000), endTime: Math.floor(Date.parse(to) / 1000),
      queryString: query, limit,
    }), { abortSignal: this.signal(timeoutMs) });
    if (!response.queryId) throw new OpsError('UPSTREAM', 'CloudWatch did not return a query ID');
    return response.queryId;
  }

  async pollLogs(queryId: string, timeoutMs: number): Promise<LogQueryResult> {
    const response = await this.logsClient.send(new GetQueryResultsCommand({ queryId }),
      { abortSignal: this.signal(timeoutMs) });
    return { status: response.status ?? 'Unknown',
      rows: (response.results ?? []).map((row) => row.flatMap((entry) =>
        entry.field && entry.value !== undefined ? [{ field: entry.field, value: entry.value }] : [])),
      bytesScanned: response.statistics?.bytesScanned ?? null,
      recordsScanned: response.statistics?.recordsScanned ?? null };
  }

  async stopLogs(queryId: string): Promise<void> {
    await this.logsClient.send(new StopQueryCommand({ queryId }), { abortSignal: this.signal() });
  }
}
