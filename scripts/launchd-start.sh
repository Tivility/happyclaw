#!/usr/bin/env bash
# HappyClaw launchd entrypoint.
#
# Launchd runs this instead of `node dist/index.js` directly so we can
# piggyback an SDK freshness check onto every (re)start. The Makefile's
# `ensure-latest-sdk` already bounds the network check to 5s via
# `npm view --fetch-timeout=5000`, and falls back to the installed SDK if
# the lookup fails — so this step is non-fatal, and boot proceeds either way.
# exec hands the process to node so launchd's direct supervision
# (KeepAlive, logs, ThrottleInterval) still works.

set -eo pipefail
cd "$(dirname "$0")/.."

export PATH="$HOME/.local/bin:$PATH"

make ensure-latest-sdk 2>&1 || {
  echo "[launchd-start] ensure-latest-sdk failed — continuing with installed SDK" >&2
}

exec node dist/index.js
