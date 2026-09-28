# Grafana permissions

Use a dedicated Viewer service account token for this provider. Store it in an
owner-only local file and point `tokenFile` at that absolute path, or set the
configured `tokenEnv`. Do not reuse an Editor or Admin token.

At startup, the provider calls `GET /api/access-control/user/permissions`. It
refuses to register tools if that response cannot be read or includes a write
action. The override `OPS_LENS_ALLOW_POWERFUL_GRAFANA=1` exists for deliberate
local testing; it adds a warning to every Grafana tool result. A read-scoped
credential is the normal operating mode.

The provider allowlist contains only:

| Method | Endpoint | Purpose |
| --- | --- | --- |
| GET | `/api/access-control/user/permissions` | Startup permission check |
| GET | `/api/search/` | Dashboard search |
| GET | `/api/prometheus/grafana/api/v1/rules` | Alert rule state |
| GET | `/api/datasources/proxy/uid/{lokiUid}/loki/api/v1/index/stats` | Read-only Loki scan estimate |
| POST | `/api/ds/query` | Prometheus and Loki queries |

The Loki index estimate is approximate and may exclude recent ingester data.
The `examined` block reports that limitation; it never labels the estimate as
actual bytes scanned. For an exact structured `logCode`, pass the `logCode`
input. The tool appends `| json | logCode="VALUE"`, so a code mentioned only
in another field does not count as a match.
