# Host and container health without a Hostinger token

Hostinger personal API tokens inherit the owning user's permissions. This
server has no Hostinger API provider or SSH path in v1. The G1 check rejects a
personal token even if external metadata labels it `vps:read`: that label does
not prove the credential cannot write. A future provider would require a
verifiably scoped read-only credential and its own startup check.

The supported host path is Prometheus data read through Grafana's
`/api/ds/query`, after Grafana's zero-write permission check. The local demo
scrapes its own node exporter as job `node-exporter`. On Docker Desktop the
exporter observes the Linux VM used by the demo, not the physical laptop.

Example bounded instant queries for the demo:

| Signal | PromQL expression |
| --- | --- |
| Load | `node_load1{job="node-exporter"}` |
| Available memory | `node_memory_MemAvailable_bytes{job="node-exporter"}` |
| CPU idle rate | `avg(rate(node_cpu_seconds_total{job="node-exporter",mode="idle"}[5m]))` |
| Root filesystem free bytes | `node_filesystem_avail_bytes{job="node-exporter",mountpoint="/"}` |
| Receive bytes per second | `sum(rate(node_network_receive_bytes_total{job="node-exporter",device!="lo"}[5m]))` |

Call `prometheus_instant` with one expression at a time. For a trend, use
`prometheus_range` with a UTC window no longer than the configured cap and a
step of at least 60 seconds. Empty results mean the metric is unknown, not
healthy. Use the `examined` counts and window when reporting the finding.

Container metrics are pending in the demo and live environment. When an Alloy
`prometheus.exporter.cadvisor` source is available, inspect bounded
`container_cpu_usage_seconds_total` and `container_memory_usage_bytes` series
through the same Grafana tool. Do not infer container health from a missing
series. The operator must verify the exporter can observe the intended Docker
host and that existing `up` series stay unchanged after rollout.

Reachability is a separate signal from the public Uptime Kuma status JSON. If
the page is unpublished or unavailable, the MCP reports `not_published` or
`unknown`, never `up`.

Sources: [Grafana Alloy Unix exporter](https://grafana.com/docs/alloy/latest/reference/components/prometheus/prometheus.exporter.unix/),
[Grafana Alloy cAdvisor exporter](https://grafana.com/docs/alloy/latest/reference/components/prometheus/prometheus.exporter.cadvisor/),
[Prometheus node exporter](https://github.com/prometheus/node_exporter).
