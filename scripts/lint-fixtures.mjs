import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { isIP } from 'node:net';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const privatePath = join(homedir(), '.config/prd-ops-lens-mcp/denylist.txt');

export function lintFixtureText(content, privateTerms = []) {
  const violations = [];
  if (/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(content)) violations.push('email');
  for (const match of content.matchAll(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g)) {
    const ip = match[0];
    if (isIP(ip) !== 4 || !(/^(?:192\.0\.2|198\.51\.100|203\.0\.113)\./.test(ip))) {
      violations.push('non-documentation IPv4');
      break;
    }
  }
  for (const match of content.matchAll(/[0-9a-fA-F:]{3,}/g)) {
    if (match[0].includes(':') && isIP(match[0]) === 6 &&
      !match[0].toLowerCase().startsWith('2001:db8:')) {
      violations.push('non-documentation IPv6');
      break;
    }
  }
  if (/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b|\b(?:sk-|phx_|glsa_)[A-Za-z0-9_-]{8,}\b|-----BEGIN (?:RSA |EC )?PRIVATE KEY-----|\bBearer\s+\S+/i.test(content)) {
    violations.push('credential-like value');
  }
  const lower = content.toLowerCase();
  if (privateTerms.some((term) => lower.includes(term.toLowerCase()))) violations.push('private term');
  return violations;
}

function fixtureFiles(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? fixtureFiles(path)
      : /\.(?:json|md|txt)$/.test(entry.name) ? [path] : [];
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const requirePrivate = process.argv.includes('--require-private');
  if (requirePrivate && !existsSync(privatePath)) {
    process.stderr.write('Fixture lint cannot run the required private-term check.\n');
    process.exit(2);
  }
  const terms = existsSync(privatePath) ? readFileSync(privatePath, 'utf8').split(/\r?\n/)
    .map((line) => line.trim()).filter((line) => line && !line.startsWith('#')) : [];
  const files = [...fixtureFiles('test/fixtures'), ...fixtureFiles('evals/fixtures')];
  let violations = 0;
  for (const path of files) {
    const found = lintFixtureText(readFileSync(path, 'utf8'), terms);
    if (found.length) {
      violations += found.length;
      process.stderr.write(`${path}: ${found.length} fixture policy violation(s)\n`);
    }
  }
  process.stdout.write(`${JSON.stringify({ files: files.length, violations,
    privateCheck: existsSync(privatePath) ? 'run' : 'unavailable' })}\n`);
  if (violations) process.exitCode = 1;
}
