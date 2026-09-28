import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
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

it('checks merge patches, root history, and the final pushed tree', () => {
  const oldOid = '1'.repeat(40);
  const newOid = '2'.repeat(40);
  const calls: string[][] = [];
  const git = ((_program: string, args: string[]) => {
    calls.push(args);
    return args[0] === 'diff' ? '+private-service' : '';
  }) as unknown as typeof execFileSync;
  expect(scanProposedPush(`refs/heads/develop ${newOid} refs/heads/develop ${oldOid}`,
    ['private-service'], git)).toBe(false);
  expect(calls[0]).toContain('--diff-merges=separate');
  expect(calls[0]).toContain('--root');
  expect(calls[1]).toEqual(['diff', '--no-ext-diff', oldOid, newOid]);
  calls.length = 0;
  expect(scanProposedPush(`refs/heads/new ${newOid} refs/heads/new ${'0'.repeat(40)}`,
    ['private-service'], git)).toBe(true);
  expect(calls).toHaveLength(1);
});

it('blocks a private term introduced only by a merge commit', () => {
  const directory = mkdtempSync(join(tmpdir(), 'denylist-merge-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', directory, ...args], {
    encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Synthetic',
      GIT_AUTHOR_EMAIL: 'synthetic@example.invalid', GIT_COMMITTER_NAME: 'Synthetic',
      GIT_COMMITTER_EMAIL: 'synthetic@example.invalid' },
  }).trim();
  try {
    git('init', '-q');
    writeFileSync(join(directory, 'base.txt'), 'base\n');
    git('add', '.'); git('commit', '-qm', 'base');
    const base = git('rev-parse', 'HEAD');
    git('checkout', '-qb', 'left');
    writeFileSync(join(directory, 'left.txt'), 'left\n');
    git('add', '.'); git('commit', '-qm', 'left');
    git('checkout', '-qb', 'right', base);
    writeFileSync(join(directory, 'right.txt'), 'right\n');
    git('add', '.'); git('commit', '-qm', 'right');
    git('checkout', '-q', 'left');
    git('merge', '-q', '--no-commit', 'right');
    writeFileSync(join(directory, 'merge-only.txt'), 'private-service\n');
    git('add', '.'); git('commit', '-qm', 'merge content');
    const head = git('rev-parse', 'HEAD');
    const inRepo = ((_program: string, args: string[], options: object) => execFileSync('git',
      ['-C', directory, ...args], options)) as typeof execFileSync;
    expect(scanProposedPush(`refs/heads/left ${head} refs/heads/left ${base}`,
      ['private-service'], inRepo)).toBe(false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
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
