import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function checkTraceability(mapText, tests) {
  const listed = [...mapText.matchAll(/^\| (G\d+\.\d+) \|[^|]*\| `([^`]+)` \|/gm)]
    .map((match) => ({ id: match[1], path: match[2] }));
  const sources = tests.map((item) => typeof item === 'string' ? { path: '', source: item } : item);
  const tagged = new Set(sources.flatMap(({ source }) =>
    [...source.matchAll(/@guardrail\s+(G\d+\.\d+)/g)].map((match) => match[1])));
  const missing = listed.filter(({ id, path }) => !sources.some((item) =>
    item.path === path && item.source.includes(`@guardrail ${id}`))).map(({ id }) => id);
  const listedIds = new Set(listed.map(({ id }) => id));
  const unknown = [...tagged].filter((id) => !listedIds.has(id));
  return { missing, unknown };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const map = readFileSync('GUARDRAILS.md', 'utf8');
  const tests = readdirSync('test').filter((name) => name.endsWith('.test.ts'))
    .map((name) => ({ path: join('test', name), source: readFileSync(join('test', name), 'utf8') }));
  const { missing, unknown } = checkTraceability(map, tests);
  if (missing.length || unknown.length) {
    process.stderr.write(`Guardrail traceability failed: missing tests=${missing.join(',') || 'none'}; unknown tags=${unknown.join(',') || 'none'}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`Guardrail traceability passed: ${[...map.matchAll(/^\| G\d+\.\d+ \|/gm)].length} active IDs\n`);
  }
}
