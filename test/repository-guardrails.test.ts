import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { checkTraceability } from '../scripts/check-guardrails.mjs';

const read = (path: string) => readFileSync(path, 'utf8');
const workflow = read('.github/workflows/checks.yml');

// @guardrail G11.1: secret scans run before a local commit and in CI.
it('installs local and CI secret-scan gates', () => {
  expect(read('.githooks/pre-commit')).toContain('gitleaks git --staged');
  expect(workflow).toContain('gitleaks/gitleaks-action@');
});

// @guardrail G11.3: pinned actions, lockfile, repeatable install and SBOM are required.
it('pins every CI action and generates an SBOM from a locked install', () => {
  const actions = [...workflow.matchAll(/uses:\s+[^@\s]+@([^\s#]+)/g)].map((match) => match[1]);
  expect(actions.length).toBeGreaterThan(3);
  expect(actions.every((revision) => /^[a-f0-9]{40}$/.test(revision ?? ''))).toBe(true);
  expect(workflow).toContain('npm ci --ignore-scripts');
  expect(workflow).toContain('npm sbom --package-lock-only --sbom-format cyclonedx');
  expect(read('package-lock.json')).toContain('lockfileVersion');
  expect(read('.github/dependabot.yml')).toContain('package-ecosystem: github-actions');
  expect(read('docs/dependencies.md')).toContain('CycloneDX');
});

// @guardrail G11.4: default CI token is read-only and jobs never contact live providers.
it('keeps CI offline and defaults to read-only permissions', () => {
  expect(workflow).toMatch(/permissions:\s*\n\s+contents: read/);
  expect(workflow).not.toContain('pull_request_target');
  expect(workflow).not.toMatch(/OPS_LENS_CONFIG|GRAFANA_TOKEN|POSTHOG_TOKEN|AWS_ACCESS_KEY_ID/);
  expect(workflow).not.toMatch(/curl.*https?:\/\/|ssh\s|docker\s/);
});

// @guardrail G11.5: repository fixtures and examples carry synthetic values only.
it('keeps private example configuration out of public tracking', () => {
  const ignore = read('.gitignore');
  expect(ignore).toContain('*-codex-answers-*.md');
  expect(ignore).toContain('*-codex-prompt-*.md');
  expect(ignore).not.toContain('2026-09-28-codex-answers-ops-lens-mcp.md');
  expect(read('config.example.yaml')).not.toMatch(/Bearer\s+[A-Za-z0-9]|AKIA[A-Z0-9]{16}/);
  const cast = read('docs/demo.cast').trim().split('\n').map((line) => JSON.parse(line));
  expect(cast[0]).toMatchObject({ version: 2, title: 'Synthetic MCP demo' });
  expect(cast).toHaveLength(3);
  const summary = JSON.parse((cast[2] as [number, string, string])[2].trim());
  expect(summary).toMatchObject({ result: 'pass', hostMetricRows: 1 });
  expect(Object.keys(summary).sort()).toEqual([
    'dashboards', 'hostMetricRows', 'logRows', 'lokiScannedBytes', 'metricRows', 'result',
  ]);
  expect(read('docs/demo.cast')).not.toMatch(/https?:\/\/|Bearer\s+|@[a-z]+\./i);
});

it('fails traceability for both missing tests and unknown tags', () => {
  expect(checkTraceability('| G0.1 | thing | `test/one.test.ts` |', []))
    .toEqual({ missing: ['G0.1'], unknown: [], malformed: [], parsedCount: 1 });
  expect(checkTraceability('', ['// @guardrail G0.2']))
    .toEqual({ missing: [], unknown: ['G0.2'], malformed: [], parsedCount: 0 });
  expect(checkTraceability('| G0.1 | thing | `test/one.test.ts` |', [
    { path: 'test/other.test.ts', source: '// @guardrail G0.1' },
  ])).toEqual({ missing: ['G0.1'], unknown: [], malformed: [], parsedCount: 1 });
});

it('fails traceability when a guardrail row has no parseable test path', () => {
  const result = checkTraceability('| G7.2 | SSH read path | pending |', []);
  expect(result).toMatchObject({ malformed: ['G7.2'], parsedCount: 0 });
});
