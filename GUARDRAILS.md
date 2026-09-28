# Guardrail traceability

Each active guardrail below has a tagged automated test. The checker rejects missing
tests and tags for unknown IDs. New milestone IDs are added when that milestone is
implemented, so each milestone can end with a green build.

| ID | Enforcement | Positive-control test |
| --- | --- | --- |
| G0.1 | Exact method and endpoint allowlist | `test/guardrails-foundation.test.ts` |
| G0.2 | Single audited MCP result exit | `test/guardrails-foundation.test.ts` |
| G0.3 | Central value and field redaction | `test/guardrails-foundation.test.ts` |
| G0.4 | 64 KB default output cap | `test/guardrails-foundation.test.ts` |
| G0.5 | Untrusted result envelope | `test/guardrails-foundation.test.ts` |
| G0.6 | Required examined metadata | `test/guardrails-foundation.test.ts` |
| G0.7 | Bounded provider concurrency | `test/guardrails-foundation.test.ts` |
| G0.8 | Private credential files | `test/guardrails-foundation.test.ts` |
| G0.9 | Provider credential isolation | `test/guardrails-foundation.test.ts` |
| G0.10 | Local stdio transport | `test/guardrails-foundation.test.ts` |
| G0.11 | Private append-only audit | `test/guardrails-foundation.test.ts` |
| G1.1 | AWS write permission preflight | `test/guardrails-foundation.test.ts` |
| G1.2 | Grafana write permission preflight | `test/guardrails-foundation.test.ts` |
| G1.3 | PostHog scope preflight | `test/guardrails-foundation.test.ts` |
| G1.4 | Hostinger scope preflight | `test/guardrails-foundation.test.ts` |
| G11.1 | Git secret scans | `test/repository-guardrails.test.ts` |
| G11.2 | Private pre-push denylist | `test/private-denylist.test.ts` |
| G11.3 | Pinned supply chain and SBOM | `test/repository-guardrails.test.ts` |
| G11.4 | Restricted offline CI | `test/repository-guardrails.test.ts` |
| G11.5 | Synthetic public fixtures | `test/repository-guardrails.test.ts` |
