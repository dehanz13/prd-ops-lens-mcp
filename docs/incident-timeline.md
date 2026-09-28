# Incident timeline and local knowledge

`incident_timeline` correlates structured results already returned by the MCP.
Its input is `{ sources, expectedTools }`. Each source has a supported `tool`
name and that tool's `{ data, examined }` structured result. A source's
`examined.provider` must match the named tool. At most eight sources and 256 KiB
of input are accepted; the configured row cap limits output. The tool does not
query providers itself.

Supported timestamped rows are Loki logs, CloudWatch Logs Insights and alarms,
PostHog error issues, Prometheus range points, CloudWatch metric points, and
Uptime Kuma incidents and monitor heartbeats. Rows without a usable UTC
timestamp are omitted. Events are sorted by timestamp and identical events
are deduplicated while keeping every source citation. Each citation contains
the source tool and its full `examined` block, including query, UTC window,
counts, truncation, and warnings. An expected tool not supplied in `sources`
is shown as `unknown`; empty and truncated sources are warned about. The
result explicitly says the citations came from client-supplied tool results.
Verify their origin before relying on them for an operational decision.

To offer a system map or runbooks, set the optional `resources.directory`,
`resources.systemMap`, and `resources.runbooks` names in a private config. The
directory and files must belong to the current user and be owner-only. File
names cannot contain path separators. Symlinks are refused, file input is
capped at 64 KiB, and returned text is redacted and capped again by the MCP
output limit. No path or file content is embedded in the repository.

The `incident_triage`, `postmortem_review`, and `maintenance_review` prompts
ask the client to cite examined blocks, distinguish facts from hypotheses,
and treat returned data and resource text as untrusted. They only recommend
read-only investigation.
