#!/bin/sh
# Runs test/integration/runtime-env-live.test.ts (BE audit #1) on the real Copilot runtime inside a network namespace that
# has nothing but loopback, so no process can reach a network. Needs `unshare -rn` (unprivileged user and network
# namespaces); prints why and exits 0 where it isn't available. Not part of CI. Dummy marker tokens only.
set -e
cd "$(dirname "$0")/.."
if ! unshare -rn true 2>/dev/null; then echo "runtime-env-live: unshare -rn is not available here; skipped"; exit 0; fi
exec unshare -rn sh -c 'ip link set lo up 2>/dev/null || true; EMBER_INTEGRATION=1 EMBER_RUNTIME_ENV_LIVE=1 exec npx vitest run test/integration/runtime-env-live.test.ts'
