import { ListFindingsCommand } from '@aws-sdk/client-accessanalyzer';
import { GetPolicyCommand, GetPolicyVersionCommand, GetRoleCommand,
  ListAttachedRolePoliciesCommand, ListRolesCommand, SimulatePrincipalPolicyCommand,
  CreateRoleCommand } from '@aws-sdk/client-iam';
import { GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { ConfigSchema } from '../src/core/config.js';
import { SdkIamReadApi } from '../src/providers/aws-iam-api.js';

const roleArn = 'arn:aws:iam::000000000000:role/demo-reader';
const trustDocument = JSON.stringify({ Statement: [{ Effect: 'Allow', Principal: { Service: 'demo.amazonaws.com' } }] });
const policyDocument = JSON.stringify({ Statement: [{ Effect: 'Allow', Action: 's3:GetObject', Resource: '*' }] });

function adapter() {
  const credentialsFile = join(mkdtempSync(join(tmpdir(), 'ops-iam-adapter-')), 'credentials');
  writeFileSync(credentialsFile, '[synthetic]\naws_access_key_id = synthetic\naws_secret_access_key = synthetic\n',
    { mode: 0o600 });
  const config = ConfigSchema.parse({ version: 1, audit: { path: '/tmp/synthetic-audit' },
    providers: { iam: { enabled: true, region: 'us-east-1', profile: 'synthetic',
      credentialsFile, roleNames: ['demo-reader'],
      analyzerArn: 'arn:aws:access-analyzer:us-east-1:000000000000:analyzer/demo-external',
    } },
  }).providers.iam!;
  return new SdkIamReadApi(config, 1000);
}

function replaceClient(api: SdkIamReadApi, key: string, send: (command: unknown) => unknown) {
  Object.assign(api, { [key]: { send: async (command: unknown) => send(command) } });
}

// @guardrail G5.1: the real adapter can construct only the named IAM, STS and analyzer read commands.
it('maps each IAM tool operation to fixed SDK commands and projects safe responses', async () => {
  const api = adapter();
  const calls: string[] = [];
  replaceClient(api, 'sts', (command) => {
    expect(command).toBeInstanceOf(GetCallerIdentityCommand);
    calls.push(command!.constructor.name);
    return { Arn: 'arn:aws:iam::000000000000:user/synthetic',
      Account: '000000000000', UserId: 'synthetic-id' };
  });
  replaceClient(api, 'iam', (command) => {
    calls.push(command!.constructor.name);
    if (command instanceof SimulatePrincipalPolicyCommand) {
      if (command.input.ActionNames?.[0] === 'iam:CreateRole') return { EvaluationResults: [
        { EvalActionName: 'iam:CreateRole', EvalDecision: 'explicitDeny' },
      ] };
      expect(command.input.ResourceArns).toEqual(['arn:aws:s3:::demo-bucket/object']);
      return { EvaluationResults: [{ EvalDecision: 'allowed', MatchedStatements: [{
        SourcePolicyId: 'demo-policy', StartPosition: { Line: 3, Column: 2 },
      }] }] };
    }
    if (command instanceof ListRolesCommand) return { Roles: [{ RoleName: 'demo-reader',
      Arn: roleArn, AssumeRolePolicyDocument: trustDocument }] };
    if (command instanceof GetRoleCommand) return { Role: { RoleName: 'demo-reader',
      Arn: roleArn, RoleId: 'ROLEID', AssumeRolePolicyDocument: trustDocument } };
    if (command instanceof ListAttachedRolePoliciesCommand) return { AttachedPolicies: [{
      PolicyName: 'demo-policy', PolicyArn: 'arn:aws:iam::000000000000:policy/demo-policy',
    }] };
    if (command instanceof GetPolicyCommand) return { Policy: { DefaultVersionId: 'v1' } };
    if (command instanceof GetPolicyVersionCommand) return { PolicyVersion: {
      Document: encodeURIComponent(policyDocument),
    } };
    throw new Error('unexpected IAM command');
  });
  replaceClient(api, 'analyzer', (command) => {
    calls.push(command!.constructor.name);
    expect(command).toBeInstanceOf(ListFindingsCommand);
    return { findings: [{ id: 'synthetic-finding', status: 'ACTIVE',
      resourceType: 'AWS::IAM::Role', createdAt: new Date('2026-01-01T00:00:00Z') }] };
  });

  expect(await api.policySourceArn()).toBe('arn:aws:iam::000000000000:user/synthetic');
  expect(await api.simulateWrites(roleArn, ['iam:CreateRole'])).toEqual({ 'iam:CreateRole': false });
  expect(await api.identity()).toMatchObject({ account: '000000000000', principalType: 'user' });
  expect(await api.roles(['demo-reader'], 1)).toMatchObject({ rows: [{ name: 'demo-reader' }], scannedCount: 1 });
  expect(await api.role('demo-reader')).toMatchObject({ name: 'demo-reader' });
  expect(await api.policies('demo-reader', 1)).toMatchObject({ rows: [{ name: 'demo-policy' }] });
  expect(await api.simulate(roleArn, 's3:GetObject', 'arn:aws:s3:::demo-bucket/object'))
    .toEqual({ decision: 'allowed', matchedStatementId: 'demo-policy@3:2', missingContext: false });
  expect(await api.findings('arn:aws:access-analyzer:us-east-1:000000000000:analyzer/demo-external', 1))
    .toMatchObject({ rows: [{ id: 'synthetic-finding', status: 'ACTIVE' }], truncated: false });
  expect(calls).toEqual(['GetCallerIdentityCommand', 'SimulatePrincipalPolicyCommand',
    'GetCallerIdentityCommand', 'ListRolesCommand', 'GetRoleCommand',
    'ListAttachedRolePoliciesCommand', 'GetPolicyCommand', 'GetPolicyVersionCommand',
    'SimulatePrincipalPolicyCommand', 'ListFindingsCommand']);
});

it('verifies the assumed role identity before using it for permission preflight', async () => {
  const api = adapter();
  replaceClient(api, 'sts', () => ({ Arn: 'arn:aws:sts::000000000000:assumed-role/demo-reader/session',
    Account: '000000000000', UserId: 'ROLEID:session' }));
  replaceClient(api, 'iam', (command) => {
    expect(command).toBeInstanceOf(GetRoleCommand);
    return { Role: { RoleName: 'demo-reader', Arn: roleArn, RoleId: 'ROLEID' } };
  });
  expect(await api.policySourceArn()).toBe(roleArn);
});

// @guardrail G1.1: adapter construction installs the SDK read guard.
it('rejects IAM write commands on the actual constructed client', async () => {
  const api = adapter() as unknown as { iam: { send: (command: unknown) => Promise<unknown> } };
  await expect(api.iam.send(new CreateRoleCommand({ RoleName: 'synthetic',
    AssumeRolePolicyDocument: '{}' }))).rejects.toMatchObject({ code: 'REFUSED' });
});

it('rejects a truncated write simulation and an assumed role with the wrong RoleId', async () => {
  const api = adapter();
  replaceClient(api, 'sts', () => ({ Arn: 'arn:aws:sts::000000000000:assumed-role/demo-reader/session',
    Account: '000000000000', UserId: 'ROLEID:session' }));
  replaceClient(api, 'iam', (command) => command instanceof GetRoleCommand
    ? { Role: { RoleName: 'demo-reader', Arn: roleArn, RoleId: 'OTHER' } }
    : { IsTruncated: true, EvaluationResults: [{ EvalActionName: 'iam:CreateRole', EvalDecision: 'allowed' }] });
  await expect(api.policySourceArn()).rejects.toMatchObject({ code: 'REFUSED' });
  await expect(api.simulateWrites(roleArn, ['iam:CreateRole'])).rejects.toMatchObject({ code: 'REFUSED' });
  replaceClient(api, 'iam', () => ({
    EvaluationResults: [{ EvalActionName: 'iam:CreateRole', EvalDecision: 'allowed' }],
  }));
  expect(await api.simulateWrites(roleArn, ['iam:CreateRole'])).toEqual({ 'iam:CreateRole': true });
});

// @guardrail G1.1: IAM startup refuses a conditional write decision without its context.
it('refuses an IAM write simulation with missing context', async () => {
  const api = adapter();
  replaceClient(api, 'iam', () => ({ EvaluationResults: [{
    EvalActionName: 'iam:CreateRole', EvalDecision: 'implicitDeny',
    MissingContextValues: ['aws:RequestTag/synthetic'],
  }] }));
  await expect(api.simulateWrites(roleArn, ['iam:CreateRole']))
    .rejects.toMatchObject({ code: 'REFUSED' });
});
