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
| G1.4 | Hostinger personal tokens inherit owner permissions, so the check always refuses them; no Hostinger provider is registered | `test/guardrails-foundation.test.ts` |
| G2.1 | Grafana data-source query route only | `test/grafana.test.ts` |
| G2.2 | PromQL length, range, step and series caps | `test/grafana.test.ts` |
| G2.3 | LogQL selector, window, regex and scan caps | `test/grafana.test.ts` |
| G2.4 | Structured log-code matching | `test/grafana.test.ts` |
| G3.1 | Public status-page JSON only | `test/uptime.test.ts` |
| G3.2 | Safe monitor projection and newest heartbeat | `test/uptime.test.ts` |
| G4.1 | Fixed CloudWatch read actions | `test/cloudwatch.test.ts` |
| G4.2 | Configured log group allowlist | `test/cloudwatch.test.ts` |
| G4.3 | Logs Insights window, row and scan caps | `test/cloudwatch.test.ts` |
| G4.4 | Configurable AWS identifier redaction | `test/cloudwatch.test.ts` |
| G5.1 | Fixed IAM, STS, and Access Analyzer read actions | `test/iam.test.ts` |
| G5.2 | Trust policy type-only summary | `test/iam.test.ts` |
| G5.3 | Simulation decision and statement reference only | `test/iam.test.ts` |
| G6.1 | Single SELECT, UTC window, row limit and timeout | `test/posthog.test.ts` |
| G6.2 | Identity-safe projections; no recording or console route | `test/posthog.test.ts` |
| G6.3 | Exact project allowlist and key scope binding | `test/posthog.test.ts` |
| G7.1 | No Hostinger API provider or owner-scoped token path | `test/host-health.test.ts` |
| G7.4 | Demo node exporter metrics read through Grafana only | `test/host-health.test.ts` |
| G7.5 | Reachability from public Kuma status JSON; missing page is not healthy | `test/uptime.test.ts` |
| G8.1 | Server-issued evidence IDs, ordered events, unknown missing sources | `test/timeline.test.ts` |
| G8.2 | Explicit owner-only resources confined to configured directory | `test/resources-prompts.test.ts` |
| G8.3 | Prompts preserve untrusted-data and read-only guidance | `test/resources-prompts.test.ts` |
| G9.1 | Demo write startup flag, exact allowlist, and absent kill switch | `test/restart.test.ts` |
| G9.2 | Two-step, single-use, two-minute host and target-bound confirmation | `test/restart.test.ts` |
| G9.3 | Self-target, deploy lock, non-allowlisted name, and durable cooldown refusals | `test/restart.test.ts` |
| G9.4 | Before and after health plus audited refusals | `test/restart.test.ts` |
| G9.5 | Negative gate controls and untrusted-result instruction cannot restart | `test/restart.test.ts` |
| G10.1 | Synthetic fixture policy rejects identities, non-doc addresses, and credential-like data | `test/evals.test.ts` |
| G10.2 | Each replay has a missing-evidence positive control | `test/evals.test.ts` |
| G12.1 | Transcript parser projects usage metadata only and excludes planted content | `test/agent-usage.test.ts` |
| G12.2 | Job labels use an explicit mapping or session-ID hash | `test/agent-usage.test.ts` |
| G12.3 | Optional PostHog event projection contains numeric fields and safe labels only | `test/agent-usage.test.ts` |
| G12.4 | Optional OTel export is not configured; guidance requires content logging off and a separate write-only token | `test/agent-usage.test.ts` |
| G12.5 | No Anthropic Admin API credential path by default | `test/agent-usage.test.ts` |
| G11.1 | Git secret scans | `test/repository-guardrails.test.ts` |
| G11.2 | Private pre-push denylist | `test/private-denylist.test.ts` |
| G11.3 | Pinned supply chain and SBOM | `test/repository-guardrails.test.ts` |
| G11.4 | Restricted offline CI | `test/repository-guardrails.test.ts` |
| G11.5 | Synthetic public fixtures | `test/repository-guardrails.test.ts` |

G7.2 (SSH command confinement) and G7.3 (Docker-group exclusion) are deferred
from v1 and are not reassigned. The Hostinger provider was removed because its
personal token could not be scoped to read-only access. G7.4 and G7.5 trace
the approved Grafana and public Kuma path for v1.
