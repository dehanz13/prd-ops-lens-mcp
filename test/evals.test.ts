import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { positiveControlScore, suiteSchema } from '../evals/scoring.js';
import { lintFixtureText } from '../scripts/lint-fixtures.mjs';

const suite = suiteSchema.parse(JSON.parse(readFileSync('evals/fixtures/scenarios.json', 'utf8')));

it('does not count a failed timeline call as a positive control', () => {
  const scenario = suite.cases[0]!;
  expect(positiveControlScore({ isError: true, structuredContent: { data: { events: [] } } }, scenario)).toBe(false);
  expect(positiveControlScore({ isError: false, structuredContent: { data: { events: [] } } }, scenario)).toBe(true);
  expect(positiveControlScore({ isError: false, structuredContent: { data: {} } }, scenario)).toBe(false);
});

// @guardrail G10.1: fixtures are synthetic and reject identity, real network, credential, and private-term patterns.
it('keeps ten documented synthetic worlds and detects planted fixture violations', () => {
  expect(suite.cases).toHaveLength(10);
  expect(new Set(suite.cases.map((scenario) => scenario.id)).size).toBe(10);
  expect(suite.cases.every((scenario) => scenario.keySource < scenario.sources.length &&
    scenario.shapeSource.length > 0)).toBe(true);
  expect(lintFixtureText('synthetic@example.test')).toContain('email');
  expect(lintFixtureText('198.18.0.1')).toContain('non-documentation IPv4');
  expect(lintFixtureText('fc00::1')).toContain('non-documentation IPv6');
  expect(lintFixtureText('Bearer synthetic-credential')).toContain('credential-like value');
  expect(lintFixtureText('quiet-private-marker', ['quiet-private-marker'])).toContain('private term');
  expect(lintFixtureText('192.0.2.1 and 2001:db8::1')).toEqual([]);
});

// @guardrail G10.2: a real MCP replay fails its score when each case's key observation is removed.
it('reports evidence and positive-control scores from the MCP replay runner', () => {
  const output = execFileSync(process.execPath, ['--import', 'tsx', 'evals/run.ts'],
    { encoding: 'utf8' });
  const report = JSON.parse(output.trim().split('\n').at(-1)!) as Record<string, unknown>;
  expect(report).toMatchObject({ suite: 'incident-replay-v1', scenarios: 10,
    evidencePassed: 10, positiveControlsPassed: 10, providerParsed: true, modelScored: false });
  const readme = readFileSync('README.md', 'utf8');
  expect(readme).toContain('10/10 evidence checks');
  expect(readme).toContain('10/10 positive controls');
});
