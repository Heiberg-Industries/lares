#!/usr/bin/env bash
# Install Lares dependencies before a Cyrus agent session starts (5-minute cap).

set -euo pipefail

corepack enable || true

pnpm install --frozen-lockfile || pnpm install
