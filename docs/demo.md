# Reproduce the synthetic demo

Start Docker Desktop or another local Docker context, then run:

```sh
npm ci --ignore-scripts
docker compose up -d --build
npm run smoke:demo
npm run demo:record
```

The smoke calls the MCP server over `stdio`. It reads one synthetic dashboard,
synthetic metric and log rows, and a `node_*` row from the demo node-exporter
through Grafana. The result is a JSON summary of counts, not copied provider
records. `demo:record` writes [demo.cast](demo.cast) in asciinema v2 format
from a real passing smoke run. It records only the validated summary, so its
numbers may differ on another run. On Docker Desktop, the exporter sees the
Linux VM, not the physical laptop.

To exercise Uptime Kuma as well, complete its first-run local admin setup,
publish a synthetic page with slug `demo`, and run `npm run smoke:demo:uptime`.
The MCP calls only Kuma's public JSON. Stop the local stack with
`docker compose down` when finished. Do not copy an audit log, private config,
or a live provider response into the public recording.

For the one local write demonstration, follow the [demo restart gates](permissions/demo-restart.md)
and run `npm run smoke:demo:restart` while the demo stack is healthy. This
restarts only the fixed demo API container, verifies health before and after,
then proves that the confirmation cannot be replayed. It must not be run during
an ongoing demo workload.
