# Dependency choices

The runtime uses the official MCP server SDK for stdio transport, Zod for strict
input and result validation, and YAML for a human-readable local config. The
development dependencies provide TypeScript, ESLint, Vitest with coverage, and
`tsx` for local test and evaluation scripts. The lockfile pins their resolved
versions. CI installs with `npm ci --ignore-scripts`, audits runtime packages,
and generates a CycloneDX SBOM with npm's built-in command.

The first release will use npm provenance if the package is published. Releases
are not automated until the public package name and publishing ownership are
confirmed.
