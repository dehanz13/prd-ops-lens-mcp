# Uptime Kuma public status access

This provider needs no login or API token. Configure a published status-page
slug and an HTTPS base URL, or a loopback URL for local tests. The client may
call only `GET /api/status-page/{slug}` and
`GET /api/status-page/heartbeat/{slug}`. It does not connect to the admin socket
or use private monitor APIs.

The status-page response can contain internal monitor URLs and page settings.
The tool returns only a sanitized group and monitor label, the newest heartbeat
status, a 24-hour uptime fraction when present, and a short incident summary.
An HTTP 404, Kuma's HTML fallback for a missing slug, or `published: false` is
reported as `not_published`. Malformed or
unreachable data is reported as `unknown`. Neither state means healthy.
Heartbeat arrays are read from the last element because the public
API presents them oldest first.

The checked contract is for Uptime Kuma 2.5.5. If an upstream version changes
its JSON shape, the tool fails closed to an unknown status until the fixture and
parser are reviewed.
