import type { SimulatePrincipalPolicyCommandOutput } from '@aws-sdk/client-iam';
import { OpsError } from '../core/result.js';

/** A missing condition value cannot prove that a credential lacks write access. */
export function completeWriteSimulation(
  actions: readonly string[], response: SimulatePrincipalPolicyCommandOutput,
): Record<string, boolean> {
  const results = response.EvaluationResults;
  if (response.IsTruncated || !results || results.length !== actions.length) {
    throw new OpsError('REFUSED', 'AWS permission simulation was incomplete');
  }
  const requested = new Map(actions.map((action) => [action.toLowerCase(), action]));
  const decisions: Record<string, boolean> = {};
  for (const result of results) {
    const action = result.EvalActionName && requested.get(result.EvalActionName.toLowerCase());
    if (!action || decisions[action] !== undefined || result.MissingContextValues?.length ||
      !['allowed', 'explicitDeny', 'implicitDeny'].includes(result.EvalDecision ?? '')) {
      throw new OpsError('REFUSED', 'AWS permission simulation was incomplete');
    }
    decisions[action] = result.EvalDecision === 'allowed';
  }
  return decisions;
}
