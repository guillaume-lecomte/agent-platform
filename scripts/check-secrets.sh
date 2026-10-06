#!/usr/bin/env bash
# Fails if tracked or staged content, or git history, contains something that looks like an API key.
set -euo pipefail
cd "$(dirname "$0")/.."

pattern='(sk-ant-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{32,}|sk-proj-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{30,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)'

status=0
if git grep -InE "$pattern" -- . ':!pnpm-lock.yaml' ':!scripts/check-secrets.sh' ; then
  echo "Possible secret in the working tree." >&2
  status=1
fi
if git rev-parse --verify HEAD >/dev/null 2>&1; then
  if git log -p --all -G"$pattern" --pretty=format:'%h' -- . ':!pnpm-lock.yaml' ':!scripts/check-secrets.sh' | grep -qE "$pattern"; then
    echo "Possible secret in git history." >&2
    status=1
  fi
fi
if git ls-files --error-unmatch .env >/dev/null 2>&1; then
  echo ".env is tracked." >&2
  status=1
fi
[ "$status" -eq 0 ] && echo "No secrets found."
exit "$status"
