import { AccessAnalyzerClient, ListFindingsCommand } from '@aws-sdk/client-accessanalyzer';
import { GetPolicyCommand, GetPolicyVersionCommand, GetRoleCommand, IAMClient,
  ListAttachedRolePoliciesCommand, ListRolesCommand, SimulatePrincipalPolicyCommand } from '@aws-sdk/client-iam';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import type { Config } from '../core/config.js';
import { OpsError } from '../core/result.js';
import { readIsolatedAwsProfile } from './aws-cloudwatch-api.js';
import { installAwsReadGuard } from './aws-read-guard.js';

type IamConfig = NonNullable<Config['providers']['iam']>;

export type RoleRecord = { name: string; arn: string; trustDocument: string };
export type PolicyRecord = { name: string; document: string };
export type Simulation = { decision: string; matchedStatementId: string | null; missingContext: boolean };
export type FindingRecord = { id: string; status: string; resourceType: string; createdAt: string | null };

export interface IamReadApi {
  policySourceArn(): Promise<string>;
  simulateWrites(arn: string, actions: readonly string[]): Promise<Record<string, boolean>>;
  identity(): Promise<{ arn: string; account: string; principalType: string }>;
  roles(names: readonly string[], limit: number): Promise<{ rows: RoleRecord[]; scannedCount: number; truncated: boolean }>;
  role(name: string): Promise<RoleRecord | null>;
  policies(name: string, limit: number): Promise<{ rows: PolicyRecord[]; truncated: boolean }>;
  simulate(roleArn: string, action: string, resourceArn: string): Promise<Simulation>;
  findings(analyzerArn: string, limit: number): Promise<{ rows: FindingRecord[]; truncated: boolean }>;
}

export class SdkIamReadApi implements IamReadApi {
  private readonly iam: IAMClient;
  private readonly sts: STSClient;
  private readonly analyzer: AccessAnalyzerClient;

  constructor(config: IamConfig, private readonly timeoutMs: number) {
    const credentials = readIsolatedAwsProfile(config.credentialsFile, config.profile);
    const options = { region: config.region, credentials, maxAttempts: 1 };
    this.iam = installAwsReadGuard(new IAMClient(options));
    this.sts = installAwsReadGuard(new STSClient(options));
    this.analyzer = installAwsReadGuard(new AccessAnalyzerClient(options));
  }

  private signal(): AbortSignal { return AbortSignal.timeout(this.timeoutMs); }

  async policySourceArn(): Promise<string> {
    const response = await this.sts.send(new GetCallerIdentityCommand({}), { abortSignal: this.signal() });
    if (!response.Arn || !response.Account || !response.UserId) {
      throw new OpsError('REFUSED', 'AWS identity could not be verified');
    }
    if (/^arn:aws:iam::\d{12}:user\//.test(response.Arn)) return response.Arn;
    const match = response.Arn.match(/^arn:aws:sts::(\d{12}):assumed-role\/([^/]+)\/[^/]+$/);
    if (!match || match[1] !== response.Account) throw new OpsError('REFUSED', 'AWS assumed role could not be verified');
    const role = await this.iam.send(new GetRoleCommand({ RoleName: match[2] }), { abortSignal: this.signal() });
    if (!role.Role?.Arn || !role.Role.RoleId ||
      !role.Role.Arn.startsWith(`arn:aws:iam::${response.Account}:role/`) ||
      response.UserId.split(':')[0] !== role.Role.RoleId) {
      throw new OpsError('REFUSED', 'AWS assumed role could not be verified');
    }
    return role.Role.Arn;
  }

  async simulateWrites(arn: string, actions: readonly string[]): Promise<Record<string, boolean>> {
    const response = await this.iam.send(new SimulatePrincipalPolicyCommand({
      PolicySourceArn: arn, ActionNames: [...actions], ResourceArns: ['*'],
    }), { abortSignal: this.signal() });
    if (response.IsTruncated) throw new OpsError('REFUSED', 'AWS permission simulation was incomplete');
    return Object.fromEntries((response.EvaluationResults ?? []).flatMap((result) =>
      result.EvalActionName && result.EvalDecision
        ? [[result.EvalActionName, result.EvalDecision === 'allowed']] : []));
  }

  async identity(): Promise<{ arn: string; account: string; principalType: string }> {
    const response = await this.sts.send(new GetCallerIdentityCommand({}), { abortSignal: this.signal() });
    if (!response.Arn || !response.Account) throw new OpsError('UPSTREAM', 'AWS identity response was incomplete');
    const principalType = response.Arn.includes(':assumed-role/') ? 'assumed-role'
      : response.Arn.includes(':user/') ? 'user' : 'other';
    return { arn: response.Arn, account: response.Account, principalType };
  }

  async roles(names: readonly string[], limit: number): Promise<{ rows: RoleRecord[]; scannedCount: number; truncated: boolean }> {
    const allowed = new Set(names);
    const rows: RoleRecord[] = [];
    let marker: string | undefined;
    let scannedCount = 0;
    for (let page = 0; page < 5; page += 1) {
      const response = await this.iam.send(new ListRolesCommand({ MaxItems: 100, Marker: marker }),
        { abortSignal: this.signal() });
      for (const role of response.Roles ?? []) {
        scannedCount += 1;
        if (role.RoleName && allowed.has(role.RoleName) && role.Arn && role.AssumeRolePolicyDocument) {
          rows.push({ name: role.RoleName, arn: role.Arn, trustDocument: role.AssumeRolePolicyDocument });
        }
      }
      marker = response.IsTruncated ? response.Marker : undefined;
      if (!marker || rows.length >= limit) break;
    }
    return { rows: rows.slice(0, limit), scannedCount, truncated: Boolean(marker || rows.length > limit) };
  }

  async role(name: string): Promise<RoleRecord | null> {
    const response = await this.iam.send(new GetRoleCommand({ RoleName: name }), { abortSignal: this.signal() });
    const role = response.Role;
    return role?.RoleName && role.Arn && role.AssumeRolePolicyDocument
      ? { name: role.RoleName, arn: role.Arn, trustDocument: role.AssumeRolePolicyDocument } : null;
  }

  async policies(name: string, limit: number): Promise<{ rows: PolicyRecord[]; truncated: boolean }> {
    const attached = await this.iam.send(new ListAttachedRolePoliciesCommand({ RoleName: name, MaxItems: limit }),
      { abortSignal: this.signal() });
    const rows: PolicyRecord[] = [];
    for (const policy of attached.AttachedPolicies ?? []) {
      if (!policy.PolicyArn || !policy.PolicyName) continue;
      const metadata = await this.iam.send(new GetPolicyCommand({ PolicyArn: policy.PolicyArn }),
        { abortSignal: this.signal() });
      const versionId = metadata.Policy?.DefaultVersionId;
      if (!versionId) throw new OpsError('UPSTREAM', 'IAM policy version was missing');
      const version = await this.iam.send(new GetPolicyVersionCommand({
        PolicyArn: policy.PolicyArn, VersionId: versionId,
      }), { abortSignal: this.signal() });
      if (!version.PolicyVersion?.Document) throw new OpsError('UPSTREAM', 'IAM policy document was missing');
      rows.push({ name: policy.PolicyName, document: version.PolicyVersion.Document });
    }
    return { rows: rows.slice(0, limit), truncated: Boolean(attached.IsTruncated || rows.length > limit) };
  }

  async simulate(roleArn: string, action: string, resourceArn: string): Promise<Simulation> {
    const response = await this.iam.send(new SimulatePrincipalPolicyCommand({
      PolicySourceArn: roleArn, ActionNames: [action], ResourceArns: [resourceArn],
    }), { abortSignal: this.signal() });
    if (response.IsTruncated || response.EvaluationResults?.length !== 1) {
      throw new OpsError('UPSTREAM', 'IAM policy simulation was incomplete');
    }
    const result = response.EvaluationResults[0]!;
    const match = result.MatchedStatements?.[0];
    const position = match?.StartPosition;
    const matchedStatementId = match?.SourcePolicyId
      ? `${match.SourcePolicyId}@${position?.Line ?? 0}:${position?.Column ?? 0}` : null;
    return { decision: result.EvalDecision ?? 'unknown', matchedStatementId,
      missingContext: Boolean(result.MissingContextValues?.length) };
  }

  async findings(analyzerArn: string, limit: number): Promise<{ rows: FindingRecord[]; truncated: boolean }> {
    const response = await this.analyzer.send(new ListFindingsCommand({
      analyzerArn, maxResults: limit,
    }), { abortSignal: this.signal() });
    return { rows: (response.findings ?? []).slice(0, limit).map((finding) => ({
      id: finding.id ?? 'unknown', status: finding.status ?? 'UNKNOWN',
      resourceType: finding.resourceType ?? 'UNKNOWN', createdAt: finding.createdAt?.toISOString() ?? null,
    })), truncated: Boolean(response.nextToken) };
  }
}
