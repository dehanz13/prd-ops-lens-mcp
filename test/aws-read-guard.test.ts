import { CloudWatchClient, DeleteAlarmsCommand } from '@aws-sdk/client-cloudwatch';
import { expect, it } from 'vitest';
import { assertAwsReadCommand, installAwsReadGuard } from '../src/providers/aws-read-guard.js';

// @guardrail G4.1: an unlisted AWS command is refused at the SDK send boundary.
it('refuses a write command before the AWS transport can run', async () => {
  expect(() => assertAwsReadCommand('GetMetricDataCommand')).not.toThrow();
  expect(() => assertAwsReadCommand('StartQueryCommand')).not.toThrow();
  expect(() => assertAwsReadCommand('StopQueryCommand')).not.toThrow();
  expect(() => assertAwsReadCommand('DeleteAlarmsCommand')).toThrow('read-query allowlist');
  const client = installAwsReadGuard(new CloudWatchClient({ region: 'us-east-1',
    endpoint: 'http://127.0.0.1:1', maxAttempts: 1,
    credentials: { accessKeyId: 'SYNTHETIC', secretAccessKey: 'SYNTHETIC' },
  }));
  try {
    await expect(client.send(new DeleteAlarmsCommand({ AlarmNames: ['synthetic'] })))
      .rejects.toMatchObject({ code: 'REFUSED' });
  } finally { client.destroy(); }
});
