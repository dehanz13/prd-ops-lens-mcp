import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { ConfigSchema } from '../src/core/config.js';
import { checkHostingerScopes } from '../src/core/credential-check.js';

// @guardrail G7.1: no owner-scoped Hostinger token can enable an API provider.
it('has no Hostinger config or permissive token path', () => {
  expect(() => ConfigSchema.parse({ version: 1, audit: { path: '/tmp/ops-lens-test-audit' },
    providers: { hostinger: { enabled: true, tokenEnv: 'HOSTINGER_TOKEN' } },
  })).toThrow();
  expect(() => checkHostingerScopes(['vps:read'])).toThrow('cannot prove zero write access');
});

// @guardrail G7.2: host metrics are scraped in the demo and queried via Grafana.
it('scrapes demo node metrics and uses the Grafana metric tool for proof', () => {
  const compose = readFileSync('compose.yaml', 'utf8');
  const prometheus = readFileSync('demo/prometheus/prometheus.yml', 'utf8');
  const smoke = readFileSync('scripts/smoke-demo.mjs', 'utf8');
  expect(compose).toMatch(/node-exporter:[\s\S]*quay\.io\/prometheus\/node-exporter:v1\.12\.1/);
  expect(prometheus).toContain('node-exporter:9100');
  expect(smoke).toContain("prometheus_instant', { query: 'node_load1{job=\"node-exporter\"}'");
  expect(smoke).toContain('hostMetric.data.length < 1');
});
