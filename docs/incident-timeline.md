# Incident timeline and local knowledge

`incident_timeline` correlates structured results already returned by this MCP
process. Its input is `{ sources, expectedTools }`. Each source has a supported
`tool` name and the `evidenceId` returned by that tool's successful audited
result. The server resolves IDs from a bounded in-memory store and refuses
unknown IDs, swapped tool names, and caller-supplied result bodies. IDs last
only for the current server process and the latest 128 provider results. At
most eight sources and 256 KiB of input are accepted; the configured row cap
limits output. The timeline does not query providers itself.

Supported timestamped rows are Loki logs, CloudWatch Logs Insights and alarms,
PostHog error issues, Prometheus range points, CloudWatch metric points, and
Uptime Kuma incidents and monitor heartbeats. CloudWatch's space-separated
Logs Insights timestamps are interpreted as UTC. Rows without a usable UTC
timestamp are omitted. Events are sorted by timestamp and identical events
are deduplicated while keeping every source citation. Each citation contains
the source tool and its full `examined` block, including query, UTC window,
counts, truncation, and warnings. An expected tool not supplied in `sources`
is shown as `unknown`; empty and truncated sources are warned about. The
citations are drawn from the server's audited provider results. A missing
result is shown as unknown rather than replaced with caller-supplied evidence.

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
