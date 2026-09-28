# Lightweight delivery process

The project uses one-week sprints. Planning is an async note: choose a goal and
move a small set of Ready stories into the sprint. Daily progress lives in PR
descriptions and story comments, with a short update when scope or evidence
changes. At the end of the week, review the merged work and write one retro
note in `docs/sprints/sprint-N.md`.

The board tracks Backlog, Ready, In progress, In review, and Done. A story moves
to In review when its PR opens. It reaches Done only after its acceptance
checklist and the [pinned Definition of Done issue](https://github.com/dehanz13/prd-ops-lens-mcp/issues/1) are satisfied and
the PR is reviewed and merged into `develop`. `main` is reserved for
production-ready releases.

Story points use 1, 2, 3, 5, or 8 to show relative effort and uncertainty.
Velocity is the sum of points on stories actually completed in that sprint;
unfinished stories contribute zero and return to planning. Sprint notes report
the goal, completed work, actual points, slips and reasons, and one change for
the next sprint. Planned estimates are never reported as completed velocity.

Sprint 1 targets the foundation and local synthetic demo stack. Sprint 2
targets the remaining Grafana work and public uptime status. Later milestones
enter the sprint only when their credentials and guardrail work are Ready.

The public backlog is described in `project/roadmap.json`. Run
`node scripts/seed-project.mjs --plan` to validate its issue count, priorities,
sizes, and planned sprint points without changing GitHub. With a GitHub CLI
session authorized for the repository and Projects, `--apply` creates or finds
the project, labels, epics, stories, fields, views, and pinned Definition of
Done issue. Review the Project after seeding and record actual completed points
only in a sprint-end note.

`--apply` also writes to existing resources. It makes the Project public,
replaces Status, Priority, or Size options only before any cards exist; if an
established Project has different options, it stops rather than clearing card
values. It runs `gh label create --force` to update label colors and
descriptions. It appends missing epic story links while preserving checked
tasks and manual notes. Existing card fields, including Status and Sprint, are
left as the maintainer set them.
The Milestone G migration renames the existing owner-created epic and three
stories in place and replaces their bodies with the approved Grafana and public
Kuma plan. It rejects a mix of old and new issue titles before writing. Inspect
these changes before rerunning the seeder on an established project.

The seeder selects an existing roadmap only when exactly one matching project
is linked to this repository. Duplicate managed issue titles, a closed
Definition of Done issue, missing Sprint 1 or Sprint 2 iterations, and view
layout or grouping drift stop issue seeding. GitHub's Project API can create
the Board, Sprint, and Roadmap views but cannot set their grouping. For a new
Project, group Board by Status, Sprint by Sprint, and Roadmap by Milestone in
the UI, then rerun `--apply`. Existing card fields are preserved on reruns;
reconcile a partially configured card manually.

## Local and hosted verification

For each new PR head, run the owner-only installed controller described in
`CONTRIBUTING.md` with the full commit SHA. The controller creates a fresh
temporary worktree at that exact commit, installs from the lockfile, and runs
lint, typecheck, coverage tests, evals, guardrail traceability, build,
production dependency audit, SBOM generation, gitleaks, and the private
denylist. It posts `local/*` commit statuses with measured counts and the Node
version. An unavailable gate gets `error`, never `success`; the GitHub PR
dependency-review action remains unavailable locally.

These statuses record self-run evidence. They do not replace the repository's
GitHub Actions checks. Rerun hosted CI at every open PR head and require green
hosted checks on the release commit before merging or tagging it.
