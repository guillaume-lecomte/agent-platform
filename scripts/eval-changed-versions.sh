#!/usr/bin/env bash
# Informational evals for agent versions touched by a pull request but not deployed
# (not named in active.json). The deployed version is gated by `pnpm turbo run eval`;
# this lets reviewers see what a candidate version would score, without blocking the PR.
# Usage (CI): BASE_REF=main ./scripts/eval-changed-versions.sh
set -uo pipefail
cd "$(dirname "$0")/.."

base="origin/${BASE_REF:-main}"
for file in $(git diff --name-only "$base"...HEAD -- 'agents/*/v*.yaml'); do
  agent="$(basename "$(dirname "$file")")"
  version="$(basename "$file" .yaml)"
  active="$(node -p "require('./agents/$agent/active.json').active")"
  [ "$version" = "$active" ] && continue
  echo "::group::evals $agent@$version (not deployed, informational)"
  out="evals/$agent/reports"
  pnpm evals run --agent "$agent" --version "$version" --out "$out" \
    --summary-file "$out/summary-$version.md" || echo "$agent@$version does not pass the gate (informational)"
  echo "::endgroup::"
done
exit 0
