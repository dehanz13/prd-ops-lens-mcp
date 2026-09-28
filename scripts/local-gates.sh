#!/usr/bin/env bash
set -euo pipefail

# Install this reviewed controller outside the repository before running it.
# The checkout under test is untrusted and never receives host credentials.
repo=dehanz13/prd-ops-lens-mcp
runner=$(realpath "${BASH_SOURCE[0]}")
trusted_dir=$(dirname "$runner")
current_dir=$(pwd -P)
if [[ -e $current_dir/.git && $runner == "$current_dir"/* ]]; then
  printf 'Refusing a runner from the repository checkout. Install the reviewed runner and helpers outside the repo.\n' >&2
  exit 2
fi
root=$(git rev-parse --show-toplevel) || exit 2
if [[ $runner == "$root"/* ]]; then
  printf 'Refusing a runner from the repository checkout. Install the reviewed runner and helpers outside the repo.\n' >&2
  exit 2
fi
for file in "$runner" "$trusted_dir/lint-fixtures.mjs" "$trusted_dir/private-denylist.mjs" \
  "$trusted_dir/check-guardrails.mjs"; do
  if [[ ! -f $file || -L $file ]] || [[ $(stat -f '%u %Lp' "$file") != "$(id -u) "[0-7]00 ]]; then
    printf 'Trusted runner files must be owner-only regular files.\n' >&2
    exit 2
  fi
done
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

if ! command -v docker >/dev/null || ! docker info >/dev/null 2>&1; then
  post setup error 'self-run, node unavailable; local Docker isolation unavailable' || exit 2
  printf 'Local Docker isolation is required before gate execution.\n' >&2
  exit 2
fi

container_image=node@sha256:363e1587494626837fa7f9a23bdb453d13b0ff3c67c705c2805cfc69c2d2fad7
node_version=$(docker run --rm --network none "$container_image" node --version 2>/dev/null || printf 'unavailable')
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

container() {
  local network=$1
  shift
  docker run --rm --network "$network" --cap-drop ALL --security-opt no-new-privileges \
    --read-only --tmpfs /tmp:rw,nosuid,size=256m --user "$(id -u):$(id -g)" \
    -e HOME=/tmp -e npm_config_cache=/tmp/npm-cache \
    -v "$checkout:/work" -v "$scratch:/results" -w /work "$container_image" "$@"
}

failed=0
setup_ok=1
summary_for() {
  local name=$1
  # JavaScript interpolates its own template strings; the shell must not.
  # shellcheck disable=SC2016
  node -e '
    const fs = require("node:fs");
    const [name, path] = process.argv.slice(1);
    const log = fs.readFileSync(name === "sbom" ? path.replace(/sbom\.log$/, "sbom.json") : path, "utf8")
      .replace(/\u001b\[[0-9;]*m/g, "");
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
    } else if (name === "fixtures") {
      const value = JSON.parse(log.trim().split("\n").at(-1));
      if (!Number.isInteger(value.files) || !Number.isInteger(value.violations) ||
        value.privateCheck !== "run") process.exit(1);
      process.stdout.write(`${value.files} files; ${value.violations} violations; private scan run`);
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
  if container none "$@" >"$scratch/$name.log" 2>&1; then
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
    local state=failure
    if (( exit_code >= 125 && exit_code <= 127 )); then state=error; fi
    post "$name" "$state" "self-run, node $node_version; exit $exit_code" || return 2
    printf '%s: failure at %s\n' "$name" "$sha" >&2
    failed=1
  fi
}

network_gate() {
  local name=$1
  shift
  if (( ! setup_ok )); then
    post "$name" error "self-run, node $node_version; npm ci did not complete" || return 2
    failed=1
    return 0
  fi
  if container bridge "$@" >"$scratch/$name.log" 2>&1; then
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
    local state=failure
    if (( exit_code >= 125 && exit_code <= 127 )); then state=error; fi
    post "$name" "$state" "self-run, node $node_version; exit $exit_code" || return 2
    failed=1
  fi
}

host_gate() {
  local name=$1
  shift
  if "$@" >"$scratch/$name.log" 2>&1; then
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
    local state=failure
    if (( exit_code == 127 )); then state=error; fi
    post "$name" "$state" "self-run, node $node_version; exit $exit_code" || return 2
    failed=1
  fi
}

if container bridge npm ci --ignore-scripts >"$scratch/npm-ci.log" 2>&1; then
  installed=$(rg -o 'added [0-9]+ packages' "$scratch/npm-ci.log" | tail -1 || true)
  if [[ -z $installed ]]; then
    post npm-ci error "self-run, node $node_version; install count unavailable" || exit 2
    setup_ok=0
    failed=1
  else
    post npm-ci success "self-run, node $node_version; $installed" || exit 2
  fi
else
  exit_code=$?
  state=failure
  if (( exit_code >= 125 && exit_code <= 127 )); then state=error; fi
  post npm-ci "$state" "self-run, node $node_version; npm ci exit $exit_code" || exit 2
  setup_ok=0
  failed=1
fi

gate lint ./node_modules/.bin/eslint .
gate typecheck ./node_modules/.bin/tsc --noEmit
gate tests ./node_modules/.bin/vitest run --coverage
gate evals node --import tsx evals/run.ts
host_gate fixtures node "$trusted_dir/lint-fixtures.mjs" --require-private
host_gate guardrails node "$trusted_dir/check-guardrails.mjs"
gate build ./node_modules/.bin/tsc -p tsconfig.build.json
network_gate audit npm audit --omit=dev
# The child shell receives the output path as its first positional argument.
# shellcheck disable=SC2016
gate sbom bash -c 'npm sbom --package-lock-only --sbom-format cyclonedx > /results/sbom.json'
host_gate gitleaks gitleaks git . --no-banner --redact

base=$(git merge-base origin/develop "$sha" 2>/dev/null || true)
if [[ -z $base ]]; then
  post denylist error "self-run, node $node_version; origin/develop unavailable" || exit 2
  failed=1
else
  if printf 'refs/heads/local %s refs/heads/develop %s\n' "$sha" "$base" |
    node "$trusted_dir/private-denylist.mjs" >"$scratch/denylist.log" 2>&1; then
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
