import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('refuses the PR checkout as a status-posting runner', () => {
  const result = spawnSync('bash', ['scripts/local-gates.sh', 'invalid-sha'], { encoding: 'utf8' });
  expect(result.status).toBe(2);
  expect(result.stderr).toContain('Refusing a runner from the repository checkout');
  const script = readFileSync('scripts/local-gates.sh', 'utf8');
  expect(script).toContain('--network "$network"');
  expect(script).toContain('--cap-drop ALL');
  expect(script).toContain('-e HOME=/tmp');
  expect(script).not.toContain('-v "$HOME');
  expect(script).not.toContain('/var/run/docker.sock');
  expect(script).toContain('"$trusted_dir/private-denylist.mjs"');
});
