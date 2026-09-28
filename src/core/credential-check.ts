import { OpsError } from './result.js';

export const AWS_WRITE_ACTIONS = [
  'iam:CreateRole', 'logs:DeleteLogGroup', 'lambda:UpdateFunctionCode',
  'cloudformation:ExecuteChangeSet',
] as const;

export type CredentialCheck = { warning?: string };

function refusePowerful(provider: string, override: boolean): CredentialCheck {
  if (!override) throw new OpsError('REFUSED', `${provider}: credential has write permissions`);
  return { warning: `WARNING: ${provider} credential has write permissions; use a read-only credential` };
}

export async function checkAwsCredential(
  getIdentity: () => Promise<{ arn: string }>,
  simulate: (arn: string, actions: readonly string[]) => Promise<Record<string, boolean>>,
  override = false,
): Promise<CredentialCheck> {
  const identity = await getIdentity();
  if (!identity.arn) throw new OpsError('REFUSED', 'AWS identity could not be verified');
  const decisions = await simulate(identity.arn, AWS_WRITE_ACTIONS);
  if (AWS_WRITE_ACTIONS.some((action) => decisions[action] === undefined)) {
    throw new OpsError('REFUSED', 'AWS permissions could not be verified');
  }
  return AWS_WRITE_ACTIONS.some((action) => decisions[action])
    ? refusePowerful('AWS', override) : {};
}

const grafanaWrite = /(?:^|[:.])(?:create|write|update|delete|admin|provision|execute)$/i;

export function checkGrafanaPermissions(
  permissions: Record<string, unknown>, override = false,
): CredentialCheck {
  if (!permissions || typeof permissions !== 'object' || Object.keys(permissions).length === 0) {
    throw new OpsError('REFUSED', 'Grafana permissions could not be verified');
  }
  const actions = Object.keys(permissions);
  if (actions.some((action) => !Array.isArray(permissions[action]))) {
    throw new OpsError('REFUSED', 'Grafana permissions could not be verified');
  }
  return actions.some((action) => action === '*' || grafanaWrite.test(action))
    ? refusePowerful('Grafana', override) : {};
}

export function checkPostHogScopes(
  scopes: readonly string[], projectIds: readonly string[],
): CredentialCheck {
  if (projectIds.length === 0 || scopes.length === 0) {
    throw new OpsError('REFUSED', 'PostHog scopes could not be verified');
  }
  for (const projectId of projectIds) {
    if (!scopes.includes(`project:${projectId}:read`)) {
      throw new OpsError('REFUSED', 'PostHog project read scope is missing');
    }
  }
  if (scopes.some((scope) => !/^project:[^:]+:read$/.test(scope) ||
    !projectIds.includes(scope.split(':')[1] ?? ''))) {
    throw new OpsError('REFUSED', 'PostHog scope exceeds configured read access');
  }
  return {};
}

export function checkHostingerScopes(scopes: readonly string[] | undefined): CredentialCheck {
  if (!scopes || scopes.length === 0 || scopes.some((scope) => !scope.endsWith(':read'))) {
    throw new OpsError('REFUSED', 'Hostinger read-only scope could not be verified');
  }
  return {};
}
