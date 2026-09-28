# Contributing

Use Node 22 or newer. Create feature, hotfix, and chore branches from `develop`; open PRs back into `develop`. Keep `main` for production-ready releases. Keep tests and examples synthetic. Before opening a pull request, run `npm run check`, `npm run build`, `npm audit --omit=dev`, `npm run secret-scan`, and the relevant local demo smoke test.

Set `git config core.hooksPath .githooks` in this clone. The pre-commit hook scans staged changes. The pre-push hook requires an owner-only, nonempty private denylist at `~/.config/prd-ops-lens-mcp/denylist.txt` and checks the proposed push diff without displaying private terms. The repository contains an empty `denylist.example.txt` only.

Each new tool needs a Zod input schema, a validated `data` plus `examined` result, a bounded query, redaction coverage, and a replay test. Do not add account names, hostnames, emails, tokens, or real provider responses to tests or documentation.

PR descriptions should state what changed, why, test evidence, touched guardrail IDs, references, and remaining work. Do not include attribution boilerplate or private operational details.

While GitHub Actions is unavailable, run `scripts/local-gates.sh <full-commit-sha>`
after pushing each new PR head. The script checks that exact commit in a fresh
temporary worktree and posts `local/*` statuses with measured counts and the
Node version. A non-runnable gate reports `error`, and local status is never
described as hosted CI. Do not request a merge while the PR head differs from
the SHA that was checked. Once Actions starts again, rerun CI on every open PR
head and use the hosted results for merge decisions. No release tag, package
publication, provenance, or Scorecard claim is made before the release commit
passes hosted CI.

## Definition of Ready

A story is Ready when its user outcome is clear, its acceptance checklist names
the guardrail IDs and proving tests, its size and priority are set, and known
dependencies are linked. The test data must be synthetic or explicitly approved
for bounded read-only checks. A story waiting on a credential or external
permission stays in Backlog until independent implementation work is clear.

## Definition of Done

A story is Done after lint, typecheck, relevant unit and replay tests, guardrail
traceability, secret scan, and documentation pass; its PR links the story,
records exact local or demo evidence, receives review, and merges into
`develop`. Live checks are reported separately, including any that could not
run because a credential or permission gate refused them.
