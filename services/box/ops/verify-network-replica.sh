#!/usr/bin/env bash
# verify-network-replica.sh — box-side privacy gate (FUTURE / NOT YET ACTIVE).
# Intended to run the bundled verifier in a PINNED Node container against
# /srv/network/network.db (no install on the box). It requires a CI-built linux
# better-sqlite3 native module at /opt/agent-box/node_modules plus the bundled
# verifier at /opt/agent-box/replica-verify.mjs. Until that CI artifact exists, the
# ACTIVE privacy gate runs Mac-side in push-network-replica.sh (fail-closed before
# egress). This script FAILS CLOSED if its prerequisites are absent — it must NEVER
# pass-by-default. See docs/runbooks/agent-box-network-replica.md.
set -euo pipefail

REPLICA=/srv/network/network.db
VERIFIER=/opt/agent-box/replica-verify.mjs
NODE_MODULES=/opt/agent-box/node_modules
NODE_IMAGE="node:22-bookworm-slim@sha256:<PIN_AT_DEPLOY_TIME>"

[ -f "$REPLICA" ] || { echo "verify: no replica at $REPLICA" >&2; exit 1; }

if [ ! -f "$VERIFIER" ] || [ ! -d "$NODE_MODULES" ] || [[ "$NODE_IMAGE" == *"<PIN_AT_DEPLOY_TIME>"* ]]; then
  echo "verify-network-replica: box-side verifier not provisioned (needs CI-built linux better-sqlite3 + a pinned image digest)." >&2
  echo "The active privacy gate is Mac-side (push-network-replica.sh). Failing closed." >&2
  exit 2
fi

docker run --rm \
  -v "$REPLICA:/data/network.db:ro" \
  -v "$VERIFIER:/app/replica-verify.mjs:ro" \
  -v "$NODE_MODULES:/app/node_modules:ro" \
  -w /app "$NODE_IMAGE" \
  node --input-type=module -e "
    import { verifyNoRawContent } from '/app/replica-verify.mjs';
    const r = verifyNoRawContent('/data/network.db');
    console.log(JSON.stringify(r));
    process.exit(r.ok ? 0 : 1);
  "
