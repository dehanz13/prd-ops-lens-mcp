# Threat model

The server runs as a local, unprivileged `stdio` process. Its assets are
provider credentials, private operational context, audit integrity, bounded
provider budgets, and the operator's control over the one local demo write.
It does not open an inbound network port. Provider responses, local resources,
and MCP client arguments cross trust boundaries and are treated as untrusted.

| STRIDE concern | Attack path | Control and evidence |
| --- | --- | --- |
| Spoofing | A client supplies a forged timeline result or source citation | The timeline validates tool/provider pairs and labels citations as client-supplied; operators verify origin before acting. `test/timeline.test.ts` covers mismatched provenance. |
| Tampering | A runbook link points outside the configured directory | Resource names are explicit, paths stay within an owner-only directory, and symlinks are refused. `test/resources-prompts.test.ts` covers an outside link. |
| Repudiation | A tool or resource read has no trace | Tool calls use the central redacted audit exit; resource reads record a private audit entry. Audit file mode and append behavior have tests. |
| Information disclosure | A provider response contains identities, credentials, monitor URLs, or private terms | Provider projections, central redaction, owner-only credential and audit files, fixture lint, gitleaks, and the private pre-push denylist reduce exposure. Public demo material uses synthetic counts only. |
| Denial of service or wallet | A broad log or metric query consumes provider budget | Strict windows, row and series caps, Loki index estimate, CloudWatch scan ceiling, response size and timeout caps, and per-provider concurrency limits refuse expensive requests. |
| Elevation of privilege | A provider token can write, or log text instructs a model to restart a container | Startup rejects write-capable credentials; Hostinger personal tokens are refused. Results and prompts carry an untrusted-data notice. The restart path verifies the local Docker Desktop daemon and one Compose target, then requires a short-lived, single-use confirmation, reason, kill-switch and deploy-lock checks. |
| Supply-chain compromise | A dependency or workflow action changes unexpectedly | Lockfile install, SHA-pinned actions, dependency audit, SBOM, CodeQL workflow, gitleaks, and dependency review are configured. Hosted results remain pending while Actions cannot start. |

The strongest residual limitation is provenance: `incident_timeline` accepts
previous structured results from the client rather than querying a provider
again. It can cite the supplied `examined` blocks but cannot authenticate
their origin. A second limitation is external credential scope: a provider
without a verifiably read-only token is excluded instead of being called.

Release claims require a reviewed merge into `main`, green GitHub Actions on
the release commit, and separately recorded live read checks. Local gate
statuses are identified as self-run evidence and do not replace hosted CI.
