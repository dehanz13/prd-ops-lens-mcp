import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function checkTraceability(mapText, tests) {
  const listed = new Set([...mapText.matchAll(/^\| (G\d+\.\d+) \|/gm)].map((match) => match[1]));
  const tagged = new Set(tests.flatMap((source) =>
    [...source.matchAll(/@guardrail\s+(G\d+\.\d+)/g)].map((match) => match[1])));
  const missing = [...listed].filter((id) => !tagged.has(id));
  const unknown = [...tagged].filter((id) => !listed.has(id));
  return { missing, unknown };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const map = readFileSync('GUARDRAILS.md', 'utf8');
  const tests = readdirSync('test').filter((name) => name.endsWith('.test.ts'))
    .map((name) => readFileSync(join('test', name), 'utf8'));
  const { missing, unknown } = checkTraceability(map, tests);
  if (missing.length || unknown.length) {
    process.stderr.write(`Guardrail traceability failed: missing tests=${missing.join(',') || 'none'}; unknown tags=${unknown.join(',') || 'none'}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`Guardrail traceability passed: ${[...map.matchAll(/^\| G\d+\.\d+ \|/gm)].length} active IDs\n`);
  }
}
