import { chmodSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { execFileSync } from 'node:child_process';
import { containsPrivateTerm, loadPrivateTerms, scanProposedPush } from '../scripts/private-denylist.mjs';

// @guardrail G11.2: planted private terms in proposed patches block a push.
it('blocks private terms without returning the matched value', () => {
  expect(containsPrivateTerm('+private-service-host', ['PRIVATE-SERVICE'])).toBe(true);
  expect(containsPrivateTerm('+synthetic-service', ['PRIVATE-SERVICE'])).toBe(false);
  const newOid = '1'.repeat(40);
  const oldOid = '0'.repeat(40);
  const proposed = `refs/heads/main ${newOid} refs/heads/main ${oldOid}\n`;
  const fakeGit = (() => '+private-service-host') as unknown as typeof execFileSync;
  expect(scanProposedPush(proposed, ['private-service'], fakeGit)).toBe(false);
  expect(scanProposedPush(proposed, ['other'], fakeGit)).toBe(true);
});

// @guardrail G11.2: a missing or insecure local list cannot be silently ignored.
it('requires an owner-only nonempty denylist', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'denylist-test-')), 'denylist.txt');
  writeFileSync(path, '# comment\nprivate-term\n', { mode: 0o600 });
  expect(loadPrivateTerms(path)).toEqual(['private-term']);
  chmodSync(path, 0o644);
  expect(() => loadPrivateTerms(path)).toThrow('owner-only');
  chmodSync(path, 0o600);
  const link = join(mkdtempSync(join(tmpdir(), 'denylist-link-')), 'denylist.txt');
  symlinkSync(path, link);
  expect(() => loadPrivateTerms(link)).toThrow('owner-only');
});
