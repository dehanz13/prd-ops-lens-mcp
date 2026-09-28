# Local demo restart permission

`plan_restart` and `restart_container` are the only write tools. They are absent
unless both the private config enables writes and the process starts with
`OPS_LENS_ENABLE_WRITES=1`. The configured allowlist must contain exactly
`demo-api`. The adapter accepts only the current user's Docker Desktop Unix
socket at `~/.docker/run/docker.sock`, checks the expected daemon ID, and
inspects the fixed Compose target `ops-lens-demo-demo-api-1`. It cannot select a
remote Docker host, arbitrary container, or another endpoint.

The private config also names a kill-switch file and deploy-lock file. The
server refuses to start its write provider while either exists, and checks
both again at plan and confirmation time. Creating either file during a session
blocks a pending confirmation. The user can create the kill-switch file before
starting the server or at any later time. Both paths must stay outside the
public repository.

A plan reports the local demo target, its current health, last start time,
and a confirmation that expires in two minutes. The confirmation is bound to
the daemon ID, container ID, random nonce, and expiry. Confirmation requires
that token, the exact target name, and a written reason of at least ten
characters. It is consumed on the first attempt, including a refusal. A
changed host or target, a deploy lock, a self-target, or a restart within ten
minutes is refused. The ten-minute check uses Docker's last start time, so it
survives an MCP process restart. It also conservatively blocks a first restart
soon after the demo stack starts.

A successful call checks health before and after, verifies Docker changed the
container start time, and reports both health states. The private audit log
records each plan, confirmation, and refusal, but never the token or reason
text. Returned provider content and prompts are untrusted data; they cannot
supply a confirmation automatically. The local smoke exercise uses a private
temporary config and discards it after recording only safe pass counts.

```sh
npm run smoke:demo:restart
```

This command performs a real restart of the local synthetic demo API. Run it
only with the demo Compose stack on Docker Desktop, after the API has been up
for at least ten minutes. It does not contact a VPS or a live provider.
