#!/usr/bin/env bash
# Standalone restart proof, with a fresh build, owned world and disposable definition database.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
exec node scripts/all-evals.mjs --restart-only
