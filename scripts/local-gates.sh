#!/usr/bin/env bash
set -euo pipefail

# Reproduce the repository's CI commands at a committed SHA while Actions is unavailable.
repo=dehanz13/prd-ops-lens-mcp
root=$(git -C "$(dirname "$0")" rev-parse --show-toplevel) || exit 2
sha=${1:-}
if [[ ! $sha =~ ^[a-f0-9]{40}$ ]] || ! git -C "$root" cat-file -e "$sha^{commit}" 2>/dev/null; then
  printf 'Pass a reachable full 40-character commit SHA.\n' >&2
  exit 2
fi
if ! command -v gh >/dev/null || ! gh auth status >/dev/null 2>&1; then
  printf 'GitHub CLI authentication is required to report gate results.\n' >&2
  exit 2
fi
if ! gh api "repos/$repo/commits/$sha" --jq '.sha' >/dev/null 2>&1; then
  printf 'Push the commit before running local gates; GitHub cannot attach statuses to a local-only SHA.\n' >&2
  exit 2
fi

scratch=$(mktemp -d "${TMPDIR:-/tmp}/ops-lens-gates.XXXXXX") || exit 2
checkout="$scratch/checkout"
# Invoked by the EXIT trap below.
# shellcheck disable=SC2329
cleanup() {
  if [[ -d $checkout ]]; then git -C "$root" worktree remove --force "$checkout" >/dev/null 2>&1 || true; fi
  rm -rf "$scratch"
}
trap cleanup EXIT

post() {
  local gate=$1 state=$2 description=$3
  gh api "repos/$repo/statuses/$sha" -X POST \
    -f "context=local/$gate" -f "state=$state" -f "description=$description" \
    --jq '.id' >/dev/null
}

node_version=$(node --version 2>/dev/null || printf 'unavailable')
node_major=${node_version#v}
node_major=${node_major%%.*}
if [[ ! $node_major =~ ^[0-9]+$ ]] || (( node_major < 22 )); then
  post setup error "self-run, node $node_version; Node 22 or newer required" || exit 2
  printf 'Node 22 or newer is required.\n' >&2
  exit 2
fi
if ! git -C "$root" worktree add --detach "$checkout" "$sha" >"$scratch/worktree.log" 2>&1; then
  post setup error "self-run, node $node_version; fresh worktree failed" || exit 2
  exit 2
fi
cd "$checkout" || exit 2

failed=0
setup_ok=1
summary_for() {
  local name=$1
  # JavaScript interpolates its own template strings; the shell must not.
  # shellcheck disable=SC2016
  node -e '
    const fs = require("node:fs");
    const [name, path] = process.argv.slice(1);
    const log = fs.readFileSync(name === "sbom" ? path.replace(/sbom\.log$/, "sbom.json") : path, "utf8");
    const match = (pattern) => {
      const found = log.match(pattern);
      if (!found) process.exit(1);
      return found[1];
    };
    if (name === "tests") {
      const count = match(/Tests\s+(\d+) passed/);
      const lines = match(/All files\s*\|[^|]*\|[^|]*\|[^|]*\|\s*([\d.]+)/);
      process.stdout.write(`${count} tests; ${lines}% lines`);
    } else if (name === "guardrails") {
      process.stdout.write(`${match(/traceability passed: (\d+) active IDs/)} active IDs`);
    } else if (name === "evals") {
      const line = log.trim().split("\n").at(-1);
      const value = JSON.parse(line);
      if (![value.scenarios, value.evidencePassed, value.positiveControlsPassed]
        .every(Number.isInteger)) process.exit(1);
      process.stdout.write(`${value.evidencePassed}/${value.scenarios} evidence; ${value.positiveControlsPassed} controls`);
    } else if (name === "sbom") {
      const value = JSON.parse(log);
      if (!Array.isArray(value.components)) process.exit(1);
      process.stdout.write(`${value.components.length} SBOM components`);
    } else if (name === "gitleaks") {
      process.stdout.write("0 detected secrets");
    } else if (name === "audit") {
      process.stdout.write("0 production advisories");
    } else {
      process.stdout.write("0 errors");
    }
  ' "$name" "$scratch/$name.log"
}
gate() {
  local name=$1
  shift
  if (( ! setup_ok )); then
    post "$name" error "self-run, node $node_version; npm ci did not complete" || return 2
    failed=1
    return 0
  fi
  if ! command -v "$1" >/dev/null 2>&1; then
    post "$name" error "self-run, node $node_version; command unavailable" || return 2
    failed=1
  elif "$@" >"$scratch/$name.log" 2>&1; then
    local summary
    if ! summary=$(summary_for "$name"); then
      post "$name" error "self-run, node $node_version; result count unavailable" || return 2
      failed=1
      return 0
    fi
    post "$name" success "self-run, node $node_version; $summary" || return 2
    printf '%s: success (%s)\n' "$name" "$summary"
  else
    local exit_code=$?
    post "$name" failure "self-run, node $node_version; exit $exit_code" || return 2
    printf '%s: failure at %s\n' "$name" "$sha" >&2
    failed=1
  fi
}

if npm ci --ignore-scripts >"$scratch/npm-ci.log" 2>&1; then
  post npm-ci success "self-run, node $node_version; clean install completed" || exit 2
else
  exit_code=$?
  post npm-ci failure "self-run, node $node_version; npm ci exit $exit_code" || exit 2
  setup_ok=0
  failed=1
fi

gate lint npm run lint
gate typecheck npm run typecheck
gate tests npm test
gate evals npm run evals
gate guardrails npm run guardrails
gate build npm run build
gate audit npm audit --omit=dev
# The child shell receives the output path as its first positional argument.
# shellcheck disable=SC2016
gate sbom bash -c 'npm sbom --package-lock-only --sbom-format cyclonedx > "$1"' _ "$scratch/sbom.json"
gate gitleaks gitleaks git . --no-banner --redact

base=$(git merge-base origin/develop "$sha" 2>/dev/null || true)
if [[ -z $base ]]; then
  post denylist error "self-run, node $node_version; origin/develop unavailable" || exit 2
  failed=1
else
  if printf 'refs/heads/local %s refs/heads/develop %s\n' "$sha" "$base" |
    node scripts/private-denylist.mjs >"$scratch/denylist.log" 2>&1; then
    post denylist success "self-run, node $node_version; 0 private-term matches" || exit 2
    printf 'denylist: success (0 private-term matches)\n'
  else
    post denylist failure "self-run, node $node_version; private scan refused" || exit 2
    failed=1
  fi
fi

# The PR dependency-review action has no equivalent offline result. Do not
# label it green based on npm audit, which checks a different contract.
post dependency-review error "self-run, node $node_version; GitHub PR review unavailable" || exit 2
printf 'dependency-review: unavailable until GitHub Actions runs\n'
failed=1

exit "$failed"
