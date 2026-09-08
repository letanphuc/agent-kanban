#!/bin/sh
set -eu

if [ -f .dev.vars ]; then
  set -a
  . ./.dev.vars
  set +a
fi

if [ "${AK_OFFLINE_MODE:-}" != "true" ]; then
  exec pnpm dev
fi

node scripts/local-executor.mjs &
executor_pid=$!
trap 'kill "$executor_pid" 2>/dev/null || true' EXIT INT TERM
pnpm dev
