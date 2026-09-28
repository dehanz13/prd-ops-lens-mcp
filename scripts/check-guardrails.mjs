import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function checkTraceability(mapText, tests) {
  const listed = [];
  const malformed = [];
  const seen = new Set();
  for (const line of mapText.split(/\r?\n/)) {
    const id = line.match(/^\|\s*(G\d+\.\d+)\s*\|/)?.[1];
    if (!id) continue;
    const parsed = line.match(/^\|\s*(G\d+\.\d+)\s*\|[^|]*\|\s*`(test\/[^`|]+\.test\.ts)`\s*\|\s*$/);
    if (!parsed || seen.has(id)) {
      malformed.push(id);
      continue;
    }
    seen.add(id);
    listed.push({ id, path: parsed[2] });
  }
  const sources = tests.map((item) => typeof item === 'string' ? { path: '', source: item } : item);
  const tagged = new Set(sources.flatMap(({ source }) =>
    [...source.matchAll(/@guardrail\s+(G\d+\.\d+)/g)].map((match) => match[1])));
  const missing = listed.filter(({ id, path }) => !sources.some((item) =>
    item.path === path && item.source.includes(`@guardrail ${id}`))).map(({ id }) => id);
  const listedIds = new Set(listed.map(({ id }) => id));
  const unknown = [...tagged].filter((id) => !listedIds.has(id));
  return { missing, unknown, malformed, parsedCount: listed.length };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const map = readFileSync('GUARDRAILS.md', 'utf8');
  const tests = readdirSync('test').filter((name) => name.endsWith('.test.ts'))
    .map((name) => ({ path: join('test', name), source: readFileSync(join('test', name), 'utf8') }));
  const { missing, unknown, malformed, parsedCount } = checkTraceability(map, tests);
  if (missing.length || unknown.length || malformed.length) {
    process.stderr.write(`Guardrail traceability failed: missing tests=${missing.join(',') || 'none'}; unknown tags=${unknown.join(',') || 'none'}; malformed rows=${malformed.join(',') || 'none'}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`Guardrail traceability passed: ${parsedCount} active IDs\n`);
  }
}
