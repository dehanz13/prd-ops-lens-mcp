import { OpsError } from './result.js';

export const AWS_WRITE_ACTIONS = [
  'iam:CreateRole', 'logs:DeleteLogGroup', 'lambda:UpdateFunctionCode',
  'cloudformation:ExecuteChangeSet',
] as const;

export type CredentialCheck = Record<string, never>;

function refusePowerful(provider: string): never {
  throw new OpsError('REFUSED', `${provider}: credential has write permissions`);
}

export async function checkAwsCredential(
  getIdentity: () => Promise<{ arn: string }>,
  simulate: (arn: string, actions: readonly string[]) => Promise<Record<string, boolean>>,
): Promise<CredentialCheck> {
  const identity = await getIdentity();
  if (!identity.arn) throw new OpsError('REFUSED', 'AWS identity could not be verified');
  const decisions = await simulate(identity.arn, AWS_WRITE_ACTIONS);
  if (AWS_WRITE_ACTIONS.some((action) => decisions[action] === undefined)) {
    throw new OpsError('REFUSED', 'AWS permissions could not be verified');
  }
  return AWS_WRITE_ACTIONS.some((action) => decisions[action])
    ? refusePowerful('AWS') : {};
}

const grafanaRead = /(?:^|[:.])(?:read|list|query|get)$/i;
const grafanaNonWriteAccess = new Set(['plugins.app:access']);

export function checkGrafanaPermissions(permissions: Record<string, unknown>): CredentialCheck {
  if (!permissions || typeof permissions !== 'object' || Object.keys(permissions).length === 0) {
    throw new OpsError('REFUSED', 'Grafana permissions could not be verified');
  }
  const actions = Object.keys(permissions);
  if (actions.some((action) => !Array.isArray(permissions[action]))) {
    throw new OpsError('REFUSED', 'Grafana permissions could not be verified');
  }
  return actions.some((action) => !grafanaRead.test(action) && !grafanaNonWriteAccess.has(action))
    ? refusePowerful('Grafana') : {};
}

export function checkPostHogScopes(
  scopes: readonly string[], projectIds: readonly number[], scopedTeams: readonly number[],
  scopedOrganizations: readonly string[] = [],
): CredentialCheck {
  if (projectIds.length === 0 || scopes.length === 0 || scopedTeams.length === 0) {
    throw new OpsError('REFUSED', 'PostHog scopes could not be verified');
  }
  const expected = new Set(['query:read', 'insight:read', 'error_tracking:read', 'feature_flag:read']);
  if (scopes.length !== expected.size || scopes.some((scope) => !expected.has(scope)) ||
    new Set(scopes).size !== expected.size || scopedOrganizations.length !== 0 ||
    scopedTeams.length !== projectIds.length ||
    scopedTeams.some((id) => !projectIds.includes(id)) || new Set(scopedTeams).size !== scopedTeams.length) {
    throw new OpsError('REFUSED', 'PostHog scope exceeds configured read access');
  }
  return {};
}

export function checkHostingerScopes(scopes: readonly string[] | undefined): never {
  void scopes;
  // Personal API tokens inherit the owner's permissions. A string claiming
  // "read" cannot prove the credential is unable to write.
  throw new OpsError('REFUSED', 'Hostinger personal tokens cannot prove zero write access');
}
