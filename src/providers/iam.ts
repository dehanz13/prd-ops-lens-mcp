import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { auditedInput, runValidatedTool } from '../core/audited-input.js';
import type { Config } from '../core/config.js';
import { checkAwsCredential } from '../core/credential-check.js';
import { examined, OpsError, ToolResultSchema, type ToolResult } from '../core/result.js';
import { UNTRUSTED_DATA_NOTICE, type ToolRuntime } from '../core/tool.js';
import { SdkIamReadApi, type IamReadApi } from './aws-iam-api.js';
import type { ProviderModule } from './provider.js';

type IamConfig = NonNullable<Config['providers']['iam']>;
type Context = { config: Config; iam: IamConfig; runtime: ToolRuntime; api: IamReadApi };

const emptyInput = z.object({});
const rolesInput = z.object({ limit: z.number().int().min(1).max(20).default(20) });
const roleInput = z.object({ roleName: z.string().regex(/^[a-zA-Z0-9_+=,.@-]{1,64}$/),
  limit: z.number().int().min(1).max(10).default(10) });
const simulateInput = z.object({
  roleName: z.string().regex(/^[a-zA-Z0-9_+=,.@-]{1,64}$/),
  action: z.string().min(3).max(128).regex(/^[a-zA-Z0-9-]+:[a-zA-Z0-9]+$/),
  resourceArn: z.string().min(15).max(512).regex(/^arn:aws:[a-z0-9-]+:[a-z0-9-]*:\d{0,12}:[a-zA-Z0-9_./:=+@-]+$/),
});
const findingsInput = z.object({ limit: z.number().int().min(1).max(50).default(20) });

function policyDocument(value: string): Record<string, unknown> {
  try {
    let parsed: unknown;
    try { parsed = JSON.parse(value); } catch { parsed = JSON.parse(decodeURIComponent(value)); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Not an object');
    return parsed as Record<string, unknown>;
  } catch {
    throw new OpsError('UPSTREAM', 'IAM policy document was malformed');
  }
}

function statements(document: string): Record<string, unknown>[] {
  const value = policyDocument(document).Statement;
  const entries = Array.isArray(value) ? value : [value];
  if (entries.length > 100 || entries.some((entry) => !entry || typeof entry !== 'object' || Array.isArray(entry))) {
    throw new OpsError('UPSTREAM', 'IAM policy statements were malformed');
  }
  return entries as Record<string, unknown>[];
}

export function summarizeTrust(document: string) {
  const all = statements(document);
  const rows = all.slice(0, 20).map((statement) => {
    const principal = statement.Principal;
    const principalTypes = statement.NotPrincipal !== undefined ? ['NotPrincipal']
      : principal === '*' ? ['wildcard']
      : principal && typeof principal === 'object' && !Array.isArray(principal)
        ? Object.keys(principal).filter((key) => ['AWS', 'Service', 'Federated', 'CanonicalUser'].includes(key)).sort()
        : [];
    const broadPrincipal = statement.NotPrincipal !== undefined || hasWildcard(principal);
    const condition = statement.Condition;
    const hasCondition = Boolean(condition && typeof condition === 'object' && !Array.isArray(condition)
      && Object.keys(condition).length);
    const externalIdRequired = statement.Effect === 'Allow' && hasCondition &&
      Object.values(condition as Record<string, unknown>).some((clause) =>
        clause && typeof clause === 'object' && !Array.isArray(clause) &&
        Object.keys(clause).some((key) => key.toLowerCase() === 'sts:externalid'));
    return { effect: statement.Effect === 'Allow' ? 'Allow' : 'Deny', principalTypes,
      broadPrincipal: statement.Effect === 'Allow' && broadPrincipal,
      hasCondition, externalIdRequired };
  });
  return { statements: rows, truncated: all.length > 20 };
}

function hasWildcard(value: unknown): boolean {
  if (typeof value === 'string') return value.includes('*');
  if (Array.isArray(value)) return value.some(hasWildcard);
  return value !== null && typeof value === 'object' &&
    Object.values(value).some(hasWildcard);
}

export function summarizePolicy(document: string) {
  const rows = statements(document);
  return { statementCount: rows.length, denyStatementCount: rows.filter((row) => row.Effect === 'Deny').length };
}

export class IamProvider implements ProviderModule {
  readonly id = 'iam';
  private api?: IamReadApi;

  constructor(private readonly makeApi: (config: IamConfig, timeoutMs: number) => IamReadApi =
    (config, timeoutMs) => new SdkIamReadApi(config, timeoutMs)) {}

  async preflight(config: Config): Promise<void> {
    const iam = config.providers.iam;
    if (!iam?.enabled) return;
    const api = this.makeApi(iam, config.limits.timeoutMs);
    await checkAwsCredential(() => api.policySourceArn().then((arn) => ({ arn })),
      (arn, actions) => api.simulateWrites(arn, actions));
    this.api = api;
  }

  register(server: McpServer, context: { config: Config; runtime: ToolRuntime }): void {
    const iam = context.config.providers.iam;
    if (!iam?.enabled) return;
    if (!this.api) throw new OpsError('REFUSED', 'IAM credential preflight was not completed');
    const ctx: Context = { ...context, iam, api: this.api };
    server.registerTool('iam_whoami', {
      description: `Summarize the verified AWS caller. ${UNTRUSTED_DATA_NOTICE}`,
      inputSchema: auditedInput(emptyInput), outputSchema: ToolResultSchema,
      annotations: { readOnlyHint: true },
    }, async (raw) => runValidatedTool(ctx.runtime, 'iam_whoami', 'iam', raw,
      emptyInput, () => this.whoami(ctx)));
    server.registerTool('iam_roles', {
      description: `Summarize trust for configured IAM roles. ${UNTRUSTED_DATA_NOTICE}`,
      inputSchema: auditedInput(rolesInput), outputSchema: ToolResultSchema,
      annotations: { readOnlyHint: true },
    }, async (raw) => runValidatedTool(ctx.runtime, 'iam_roles', 'iam', raw,
      rolesInput, (input) => this.roles(ctx, input)));
    server.registerTool('iam_role_policies', {
      description: `Summarize attached policy counts for one configured role. ${UNTRUSTED_DATA_NOTICE}`,
      inputSchema: auditedInput(roleInput), outputSchema: ToolResultSchema,
      annotations: { readOnlyHint: true },
    }, async (raw) => runValidatedTool(ctx.runtime, 'iam_role_policies', 'iam', raw,
      roleInput, (input) => this.rolePolicies(ctx, input)));
    server.registerTool('iam_simulate_access', {
      description: `Simulate one action and resource for a configured role. ${UNTRUSTED_DATA_NOTICE}`,
      inputSchema: auditedInput(simulateInput), outputSchema: ToolResultSchema,
      annotations: { readOnlyHint: true },
    }, async (raw) => runValidatedTool(ctx.runtime, 'iam_simulate_access', 'iam', raw,
      simulateInput, (input) => this.simulate(ctx, input)));
    server.registerTool('iam_analyzer_findings', {
      description: `Summarize findings from the configured external-access analyzer. ${UNTRUSTED_DATA_NOTICE}`,
      inputSchema: auditedInput(findingsInput), outputSchema: ToolResultSchema,
      annotations: { readOnlyHint: true },
    }, async (raw) => runValidatedTool(ctx.runtime, 'iam_analyzer_findings', 'iam', raw,
      findingsInput, (input) => this.findings(ctx, input)));
  }

  private roleAllowed(ctx: Context, name: string): void {
    if (!ctx.iam.roleNames.includes(name)) throw new OpsError('QUERY_LIMIT', 'IAM role is not configured');
  }

  private async whoami(ctx: Context): Promise<ToolResult> {
    const identity = await ctx.api.identity();
    return { data: identity, examined: examined('iam', 'GetCallerIdentity', { rowCount: 1, scannedCount: 1 }) };
  }

  private async roles(ctx: Context, input: z.output<typeof rolesInput>): Promise<ToolResult> {
    const result = await ctx.api.roles(ctx.iam.roleNames, input.limit);
    const rows = result.rows.filter((role) => ctx.iam.roleNames.includes(role.name))
      .map((role) => ({ name: role.name, trust: summarizeTrust(role.trustDocument) }));
    return { data: rows, examined: examined('iam', 'ListRoles allowlisted', {
      rowCount: rows.length, scannedCount: result.scannedCount, truncated: result.truncated,
      warnings: result.truncated ? ['Role list may be incomplete'] : [],
    }) };
  }

  private async rolePolicies(ctx: Context, input: z.output<typeof roleInput>): Promise<ToolResult> {
    this.roleAllowed(ctx, input.roleName);
    const role = await ctx.api.role(input.roleName);
    if (!role) throw new OpsError('NOT_FOUND', 'Configured IAM role was not found');
    const result = await ctx.api.policies(input.roleName, input.limit);
    const policies = result.rows.map((policy) => ({ name: policy.name, ...summarizePolicy(policy.document) }));
    return { data: { roleName: role.name, trust: summarizeTrust(role.trustDocument), policies },
      examined: examined('iam', 'GetRole and attached policy summaries', {
        rowCount: policies.length, scannedCount: result.rows.length, truncated: result.truncated,
        warnings: ['Inline role policies and permissions boundaries were not examined',
          ...(result.truncated ? ['Attached policy list may be incomplete'] : [])],
      }) };
  }

  private async simulate(ctx: Context, input: z.output<typeof simulateInput>): Promise<ToolResult> {
    this.roleAllowed(ctx, input.roleName);
    const role = await ctx.api.role(input.roleName);
    if (!role) throw new OpsError('NOT_FOUND', 'Configured IAM role was not found');
    const result = await ctx.api.simulate(role.arn, input.action, input.resourceArn);
    const decision = result.missingContext ? 'unknown' : result.decision === 'allowed' ? 'allow'
      : ['explicitDeny', 'implicitDeny'].includes(result.decision) ? 'deny' : 'unknown';
    return { data: { roleName: role.name, action: input.action, decision,
      matchedStatementId: result.matchedStatementId, missingContext: result.missingContext },
      examined: examined('iam', 'SimulatePrincipalPolicy one action and resource', {
        rowCount: 1, scannedCount: 1,
        warnings: result.missingContext ? ['Simulation needs additional context'] : [],
      }) };
  }

  private async findings(ctx: Context, input: z.output<typeof findingsInput>): Promise<ToolResult> {
    if (!ctx.iam.analyzerArn) throw new OpsError('REFUSED', 'IAM analyzer is not configured');
    const result = await ctx.api.findings(ctx.iam.analyzerArn, input.limit);
    return { data: result.rows, examined: examined('iam', 'Access Analyzer ListFindings', {
      rowCount: result.rows.length, scannedCount: result.rows.length, truncated: result.truncated,
      warnings: result.truncated ? ['More analyzer findings exist'] : [],
    }) };
  }
}
