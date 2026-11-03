#!/usr/bin/env bash
# Fail if any tracked file references an internal tracker ID (T-xxx, B-xxx, I-xxx).
# Public repositories must not leak internal backlog identifiers.
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

matches="$(git grep -nE '\b(T|B|I)-[0-9]{2,4}\b' -- ':!scripts/check-ticket-ids.sh' || true)"
if [ -n "$matches" ]; then
  echo "ERROR: internal tracker IDs found in tracked files:" >&2
  echo "$matches" >&2
  exit 1
fi
