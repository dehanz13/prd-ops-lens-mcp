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
  expect(ignore).toContain('2026-09-28-codex-answers-ops-lens-mcp.md');
  expect(ignore).toContain('2026-09-27-codex-prompt-sre-observability-mcp-server.md');
  expect(read('config.example.yaml')).not.toMatch(/Bearer\s+[A-Za-z0-9]|AKIA[A-Z0-9]{16}/);
});

it('fails traceability for both missing tests and unknown tags', () => {
  expect(checkTraceability('| G0.1 | thing | test |', [])).toEqual({ missing: ['G0.1'], unknown: [] });
  expect(checkTraceability('', ['// @guardrail G0.2'])).toEqual({ missing: [], unknown: ['G0.2'] });
});
