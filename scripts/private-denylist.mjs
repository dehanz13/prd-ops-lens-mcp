import { execFileSync } from 'node:child_process';
import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const zero = /^0+$/;

export function containsPrivateTerm(diff, terms) {
  const lower = diff.toLowerCase();
  return terms.some((term) => lower.includes(term.toLowerCase()));
}

export function loadPrivateTerms(path) {
  if (typeof constants.O_NOFOLLOW !== 'number') {
    throw new Error('Private denylist must be an owner-only regular file');
  }
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const file = fstatSync(descriptor);
    if (!file.isFile() || (file.mode & 0o077) !== 0 || file.uid !== process.getuid?.()) {
      throw new Error('Private denylist must be an owner-only regular file');
    }
  } catch {
    if (descriptor !== undefined) closeSync(descriptor);
    throw new Error('Private denylist must be an owner-only regular file');
  }
  let content;
  try {
    content = readFileSync(descriptor, 'utf8');
  } finally {
    closeSync(descriptor);
  }
  const terms = content.split(/\r?\n/)
    .map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
  if (terms.length === 0) throw new Error('Private denylist has no terms');
  return terms;
}

export function scanProposedPush(input, terms, git = execFileSync) {
  const refs = input.trim().split(/\r?\n/).filter(Boolean);
  if (refs.length === 0) throw new Error('No proposed push references received');
  for (const line of refs) {
    const parts = line.split(/\s+/);
    if (parts.length !== 4) throw new Error('Malformed proposed push reference');
    const [, localOid, , remoteOid] = parts;
    if (zero.test(localOid)) continue;
    const newRef = zero.test(remoteOid);
    const revision = newRef ? localOid : `${remoteOid}..${localOid}`;
    const diff = git('git', ['log', '--format=', '--patch', '--diff-merges=separate', '--root',
      '--no-ext-diff', revision], {
      encoding: 'utf8', maxBuffer: 10 * 1024 * 1024,
    });
    if (containsPrivateTerm(diff, terms)) return false;
    if (!newRef) {
      const treeDiff = git('git', ['diff', '--no-ext-diff', remoteOid, localOid], {
        encoding: 'utf8', maxBuffer: 10 * 1024 * 1024,
      });
      if (containsPrivateTerm(treeDiff, terms)) return false;
    }
  }
  return true;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const path = join(homedir(), '.config', 'prd-ops-lens-mcp', 'denylist.txt');
    const allowed = scanProposedPush(readFileSync(0, 'utf8'), loadPrivateTerms(path));
    if (!allowed) throw new Error('Private denylist match');
  } catch {
    process.stderr.write('Public push refused by the private denylist gate. Check the file and proposed diff locally.\n');
    process.exitCode = 1;
  }
}
