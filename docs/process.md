# Lightweight delivery process

The project uses one-week sprints. Planning is an async note: choose a goal and
move a small set of Ready stories into the sprint. Daily progress lives in PR
descriptions and story comments, with a short update when scope or evidence
changes. At the end of the week, review the merged work and write one retro
note in `docs/sprints/sprint-N.md`.

The board tracks Backlog, Ready, In progress, In review, and Done. A story moves
to In review when its PR opens. It reaches Done only after its acceptance
checklist and the [Definition of Done](../CONTRIBUTING.md) are satisfied and
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
