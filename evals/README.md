# Synthetic incident replay

Version `incident-replay-v1` contains ten hand-made fault worlds in
`fixtures/scenarios.json`. Each case names one injected fault, the observation
that should be present, and the provider result shape used. All timestamps,
labels, and values are synthetic. No production response is recorded.

`npm run evals` starts an in-memory MCP server and calls `incident_timeline`
for every world. A case earns one evidence point only when the expected
observation appears in a timeline event with a citation to the source tool's
exact query and UTC window. The runner then removes the key observation and
replays the same call. That positive control passes only when the evidence
score fails. The suite exits nonzero unless every evidence and control check
passes. It does not call a model, identify root causes automatically, or make
live provider requests.

`npm run fixtures:lint` scans fixture files for email addresses,
non-documentation IP addresses, credential-like strings, and terms from a
private local denylist when one exists. The exact-commit local gate requires
that private file. CI can run the public checks without access to it; the
private-term check is then unavailable in CI rather than silently claimed.
The linter reports counts and generic violation classes, never matched values.
