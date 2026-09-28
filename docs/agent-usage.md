# Local agent usage, safe labels, and optional exports

`agent_usage_report` and `agent_usage_trend` read only files explicitly named
in the private `providers.agentUsage.files` config. Each file must be an
owner-only regular JSONL file of at most 50 MB. A tool call cannot supply a
path. The parser projects timestamps, session ID, model, numeric token counts,
and Codex function-call record counts. It does not access message content,
tool arguments, tool outputs, prompts, file paths, or branch names as data.
Claude tool-call counts are unknown when the safe usage records do not expose
them. Malformed and incomplete sessions are skipped with generic warnings.

For each session, `jobLabels` may map the session ID to a `PR-123` or ticket
label in the private config. Unmapped IDs become a short SHA-256 based
`job_…` label. `jobKinds` may classify sessions as feature, bug, review, docs,
ops, or other; unknown jobs are `other`. Neither the raw ID nor the configured
file path is returned. The report includes input, output, cache read and
cache write tokens, duration, tool calls when known, tokens per tool call,
cache-hit rate, and p50/p95 token and duration values per job kind. Trend
groups UTC weeks and shows week-over-week token drift; a zero prior baseline
produces `null` rather than an invented percentage.

Weekly trend totals use every eligible job in the requested window even when
the report's displayed job list is capped. Cost is `unknown` until the private config has a dated `priceTable` entry for
the exact model. When present, the result says `estimated` and includes the
price table date. These figures do not represent billing records. Claude usage
records can repeat during streaming; the parser groups snapshots by message ID
and takes the largest observed counts for that message. Records without an ID
fall back to exact timestamp, model, and count deduplication. Codex session totals take precedence over
incremental token-count events. Check source format changes before relying on
cross-version comparisons.

The code can construct a PostHog event containing only safe job labels and
numeric usage fields with `privacy_mode: true`. It does not send that event.
Any future publisher needs a separate narrowly scoped write credential and
must keep `$ai_input`, `$ai_output`, prompts, responses, paths, and tool
payloads out of properties. The existing MCP PostHog key is read-only.

Claude Code OpenTelemetry metrics can be read separately through the existing
bounded Grafana metric tool after an operator configures an export. Keep its
content gates off in the operator's private environment:

```sh
OTEL_LOG_USER_PROMPTS=0
OTEL_LOG_ASSISTANT_RESPONSES=0
OTEL_LOG_TOOL_DETAILS=0
OTEL_LOG_TOOL_CONTENT=0
OTEL_METRICS_INCLUDE_ACCOUNT_UUID=false
OTEL_METRICS_INCLUDE_SESSION_ID=false
OTEL_LOGS_EXPORTER=none
```

Claude Code can include `user.email` and organization identifiers in standard
OpenTelemetry attributes even with these content gates disabled. Filter those
attributes in the collector before exporting to a shared backend. This
repository does not configure an exporter or collector.

Leave `OTEL_LOG_RAW_API_BODIES` unset. If metrics export is enabled, use a
separate, verified write-only metrics token for the collector, never the MCP
Grafana read token. No export endpoint, token, or live metric series is
configured by this repository. The [Claude Code monitoring documentation](https://code.claude.com/docs/en/monitoring-usage)
describes the current content gates and metric attributes. Recheck it before
enabling an export. The MCP does not accept an Anthropic Admin API key by
default; those organization-wide credentials are outside v1's read path.
