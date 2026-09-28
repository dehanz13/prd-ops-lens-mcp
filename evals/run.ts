import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigSchema } from '../src/core/config.js';
import { examined } from '../src/core/result.js';
import { createServer } from '../src/server.js';
import { evidenceScore, suiteSchema, type Scenario } from './scoring.js';

const suite = suiteSchema.parse(JSON.parse(readFileSync('evals/fixtures/scenarios.json', 'utf8')));
const directory = mkdtempSync(join(tmpdir(), 'ops-lens-evals-'));
const server = createServer(ConfigSchema.parse({ version: 1,
  audit: { path: join(directory, 'audit.jsonl') } }));
const client = new Client({ name: 'incident-replay', version: '1.0.0' });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const window = { from: '2026-01-01T00:00:00.000Z', to: '2026-01-01T01:00:00.000Z' };

function sourcesFor(scenario: Scenario, removeKey: boolean) {
  return scenario.sources.map((source, index) => {
    const data = removeKey && index === scenario.keySource
      ? Array.isArray(source.data) ? [] : { state: 'unknown', monitors: [], incidents: [] }
      : source.data;
    const rowCount = Array.isArray(data) ? data.length :
      typeof data === 'object' && data !== null && 'monitors' in data && Array.isArray(data.monitors)
        ? data.monitors.length : 0;
    return { tool: source.tool, result: { data, examined: examined(source.provider,
      source.query, { window, rowCount }) } };
  });
}

let evidencePassed = 0;
let positiveControlsPassed = 0;
await server.connect(serverTransport);
await client.connect(clientTransport);
try {
  for (const scenario of suite.cases) {
    const result = await client.callTool({ name: 'incident_timeline', arguments: {
      sources: sourcesFor(scenario, false), expectedTools: scenario.sources.map((source) => source.tool),
    } });
    if (!result.isError && evidenceScore(result.structuredContent, scenario)) evidencePassed += 1;
    const removed = await client.callTool({ name: 'incident_timeline', arguments: {
      sources: sourcesFor(scenario, true), expectedTools: scenario.sources.map((source) => source.tool),
    } });
    if (!evidenceScore(removed.structuredContent, scenario)) positiveControlsPassed += 1;
  }
} finally {
  await client.close();
  await server.close();
  rmSync(directory, { recursive: true, force: true });
}

const report = { suite: 'incident-replay-v1', scenarios: suite.cases.length,
  evidencePassed, positiveControlsPassed, modelScored: false };
process.stdout.write(`${JSON.stringify(report)}\n`);
if (evidencePassed !== suite.cases.length || positiveControlsPassed !== suite.cases.length) process.exitCode = 1;
