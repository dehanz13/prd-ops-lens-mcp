# Security

Please use GitHub's enabled private vulnerability reporting feature for this repository rather than opening a public issue with sensitive details. Do not include production credentials, account data, or identifying logs in a report. Maintainers aim to acknowledge a private report within seven calendar days; this is a target, not a service-level agreement.

No stable version has been released. Once a release is published, security fixes target the latest maintained release. The `develop` branch is an integration branch and may change before release.

Local configurations, credentials, and audit files belong outside the repository. Use minimum provider permissions, and review every enabled provider and allowlisted demo container before starting the server. Write tools are disabled unless explicitly enabled at startup and configured for the local demo.

The [threat model](docs/threat-model.md) lists the main trust boundaries and controls. Please share a minimal synthetic reproduction in a private report when possible.
