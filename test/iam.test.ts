import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigSchema } from '../src/core/config.js';
import { IamProvider, summarizePolicy, summarizeTrust } from '../src/providers/iam.js';
import type { FindingRecord, IamReadApi, PolicyRecord, RoleRecord, Simulation } from '../src/providers/aws-iam-api.js';
import { createServer } from '../src/server.js';

const roleArn = 'arn:aws:iam::000000000000:role/demo-reader';
const trustDocument = JSON.stringify({ Version: '2012-10-17', Statement: [{
  Effect: 'Allow', Principal: { AWS: 'arn:aws:iam::000000000000:root' },
  Condition: { StringEquals: { 'sts:ExternalId': 'planted-private-external-id' } },
}] });
const policyDocument = JSON.stringify({ Version: '2012-10-17', Statement: [
  { Sid: 'ReadOnly', Effect: 'Allow', Action: 's3:GetObject', Resource: '*' },
  { Sid: 'DenyWrites', Effect: 'Deny', Action: 's3:PutObject', Resource: '*' },
] });

class FakeIam implements IamReadApi {
  calls: string[] = [];
  writesAllowed = false;
  simulation: Simulation = { decision: 'allowed', matchedStatementId: 'demo-policy@3:2', missingContext: false };
  rolesResult: RoleRecord[] = [{ name: 'demo-reader', arn: roleArn, trustDocument }];
  findingsResult: FindingRecord[] = [{ id: 'synthetic-finding', status: 'ACTIVE',
    resourceType: 'AWS::IAM::Role', createdAt: '2026-01-01T00:00:00.000Z' }];

  async policySourceArn() { this.calls.push('GetCallerIdentity'); return roleArn; }
  async simulateWrites(_arn: string, actions: readonly string[]) {
    this.calls.push('SimulatePrincipalPolicy preflight');
    return Object.fromEntries(actions.map((action) => [action, this.writesAllowed]));
  }
  async identity() { this.calls.push('GetCallerIdentity'); return {
    arn: roleArn, account: '000000000000', principalType: 'assumed-role',
  }; }
  async roles() { this.calls.push('ListRoles'); return {
    rows: this.rolesResult, scannedCount: this.rolesResult.length, truncated: false,
  }; }
  async role(name: string) { this.calls.push('GetRole'); return name === 'demo-reader'
    ? { name, arn: roleArn, trustDocument } : null; }
  async policies(): Promise<{ rows: PolicyRecord[]; truncated: boolean }> {
    this.calls.push('ListAttachedRolePolicies', 'GetPolicy', 'GetPolicyVersion');
    return { rows: [{ name: 'demo-policy', document: policyDocument }], truncated: false };
  }
  async simulate() { this.calls.push('SimulatePrincipalPolicy'); return this.simulation; }
  async findings() { this.calls.push('ListFindings'); return { rows: this.findingsResult, truncated: false }; }
}

async function harness(api: FakeIam, analyzerArn: string | null =
  'arn:aws:access-analyzer:us-east-1:000000000000:analyzer/demo-external') {
  const auditPath = join(mkdtempSync(join(tmpdir(), 'ops-iam-')), 'audit.jsonl');
  const config = ConfigSchema.parse({ version: 1, audit: { path: auditPath }, providers: { iam: {
    enabled: true, region: 'us-east-1', profile: 'synthetic',
    credentialsFile: '/tmp/synthetic-iam-credentials', roleNames: ['demo-reader'],
    analyzerArn: analyzerArn ?? undefined,
  } } });
  const provider = new IamProvider(() => api);
  await provider.preflight(config);
  const server = createServer(config, [provider]);
  const client = new Client({ name: 'iam-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, auditPath, close: async () => { await client.close(); await server.close(); } };
}

describe('IAM read boundary', () => {
  // @guardrail G5.1: startup refuses writes and each tool uses a fixed read-only operation.
  it('refuses a writable identity before exposing tools', async () => {
    const api = new FakeIam();
    api.writesAllowed = true;
    await expect(harness(api)).rejects.toThrow('write permissions');
    expect(api.calls).toEqual(['GetCallerIdentity', 'SimulatePrincipalPolicy preflight']);
  });

  it('uses fixed read actions and refuses an unconfigured role before an AWS call', async () => {
    const api = new FakeIam();
    const fixture = await harness(api);
    try {
      const requests = [
        ['iam_whoami', {}], ['iam_roles', {}],
        ['iam_role_policies', { roleName: 'demo-reader' }],
        ['iam_simulate_access', { roleName: 'demo-reader', action: 's3:GetObject',
          resourceArn: 'arn:aws:s3:::demo-bucket/object' }],
        ['iam_analyzer_findings', {}],
      ] as const;
      for (const [name, args] of requests) {
        const result = await fixture.client.callTool({ name, arguments: args });
        expect(result.isError).toBe(false);
      }
      expect(api.calls).toEqual(['GetCallerIdentity', 'SimulatePrincipalPolicy preflight',
        'GetCallerIdentity', 'ListRoles', 'GetRole', 'ListAttachedRolePolicies', 'GetPolicy',
        'GetPolicyVersion', 'GetRole', 'SimulatePrincipalPolicy', 'ListFindings']);
      const before = api.calls.length;
      const refused = await fixture.client.callTool({ name: 'iam_role_policies',
        arguments: { roleName: 'not-configured' } });
      expect(refused.structuredContent).toMatchObject({ data: { code: 'QUERY_LIMIT' } });
      expect(api.calls).toHaveLength(before);
    } finally { await fixture.close(); }
  });

  // @guardrail G5.2: principal and external-id values never enter the result or audit.
  it('returns only trust shape and hides condition values', async () => {
    const summary = summarizeTrust(trustDocument);
    expect(summary).toEqual({ statements: [{ effect: 'Allow', principalTypes: ['AWS'],
      broadPrincipal: false, hasCondition: true, externalIdRequired: true }], truncated: false });
    expect(summarizeTrust(JSON.stringify({ Statement: { Effect: 'Allow',
      Principal: { AWS: '*' } } })).statements[0]).toMatchObject({
      principalTypes: ['AWS'], broadPrincipal: true, hasCondition: false,
    });
    for (const principal of [{ Service: '*' }, { Federated: ['tenant', '*'] },
      { CanonicalUser: '*' }]) {
      expect(summarizeTrust(JSON.stringify({ Statement: { Effect: 'Allow', Principal: principal } }))
        .statements[0]?.broadPrincipal).toBe(true);
    }
    expect(summarizeTrust(JSON.stringify({ Statement: { Effect: 'Allow',
      NotPrincipal: { AWS: 'arn:aws:iam::000000000000:role/excluded' } } }))
      .statements[0]).toMatchObject({ broadPrincipal: true,
        principalTypes: ['NotPrincipal'] });
    expect(summarizePolicy(policyDocument)).toEqual({ statementCount: 2, denyStatementCount: 1 });
    const api = new FakeIam();
    api.rolesResult.push({ name: 'not-configured', arn: roleArn, trustDocument });
    const fixture = await harness(api);
    try {
      const result = await fixture.client.callTool({ name: 'iam_roles', arguments: {} });
      const output = JSON.stringify(result.structuredContent);
      expect(output).toContain('externalIdRequired');
      expect(output).not.toContain('planted-private-external-id');
      expect(output).not.toContain('not-configured');
      expect(output).not.toContain('000000000000:root');
      expect(readFileSync(fixture.auditPath, 'utf8')).not.toContain('planted-private-external-id');
    } finally { await fixture.close(); }
  });

  // @guardrail G5.3: simulation reports decision and matched reference, never a policy document.
  it('reports a bounded simulation decision and marks missing context unknown', async () => {
    const api = new FakeIam();
    const fixture = await harness(api);
    try {
      const args = { roleName: 'demo-reader', action: 's3:GetObject',
        resourceArn: 'arn:aws:s3:::demo-bucket/object' };
      const allowed = await fixture.client.callTool({ name: 'iam_simulate_access', arguments: args });
      expect(allowed.structuredContent).toMatchObject({ data: {
        decision: 'allow', matchedStatementId: 'demo-policy@3:2', missingContext: false,
      } });
      expect(JSON.stringify(allowed.structuredContent)).not.toContain('ReadOnly');
      api.simulation = { decision: 'implicitDeny', matchedStatementId: null, missingContext: true };
      const unknown = await fixture.client.callTool({ name: 'iam_simulate_access', arguments: args });
      expect(unknown.structuredContent).toMatchObject({ data: { decision: 'unknown', missingContext: true } });
    } finally { await fixture.close(); }
  });

  it('refuses findings without a configured analyzer', async () => {
    const api = new FakeIam();
    const fixture = await harness(api, null);
    try {
      const result = await fixture.client.callTool({ name: 'iam_analyzer_findings', arguments: {} });
      expect(result.structuredContent).toMatchObject({ data: { code: 'REFUSED' } });
      expect(api.calls).not.toContain('ListFindings');
    } finally { await fixture.close(); }
  });
});
