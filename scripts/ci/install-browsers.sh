#!/usr/bin/env bash
set -euo pipefail

# A stalled package server must leave time for a retry and the browser tests.
for attempt in 1 2; do
  if timeout --kill-after=15s 180s npx playwright install --with-deps "$@"; then
    exit 0
  fi
  echo "Browser installation attempt $attempt failed." >&2
done
exit 1
