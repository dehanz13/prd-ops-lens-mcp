import { OpsError } from '../core/result.js';

const allowed = new Set([
  'GetCallerIdentityCommand', 'GetRoleCommand', 'SimulatePrincipalPolicyCommand',
  'GetMetricDataCommand', 'DescribeAlarmsCommand', 'DescribeLogGroupsCommand',
  'StartQueryCommand', 'GetQueryResultsCommand', 'StopQueryCommand',
  'ListRolesCommand', 'ListAttachedRolePoliciesCommand', 'GetPolicyCommand',
  'GetPolicyVersionCommand', 'ListFindingsCommand',
]);

export function assertAwsReadCommand(commandName: string | undefined): void {
  if (!commandName || !allowed.has(commandName)) {
    throw new OpsError('REFUSED', 'AWS SDK command is outside the read-query allowlist');
  }
}

export function installAwsReadGuard<T extends { middlewareStack: {
  add: (middleware: never, options: { step: 'initialize'; name: string }) => void;
} }>(client: T): T {
  client.middlewareStack.add(((next: (args: unknown) => Promise<unknown>,
    context: { commandName?: string }) => async (args: unknown) => {
    assertAwsReadCommand(context.commandName);
    return next(args);
  }) as never, { step: 'initialize', name: 'opsLensAwsReadCommandGuard' });
  return client;
}
