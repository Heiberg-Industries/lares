#!/usr/bin/env bash
# /usr/local/bin/compose-drift-guard.sh
#
# Detects agent-box compose drift both ways: renders the box's resolved compose
# (compose.yaml + compose.override.yaml) and the installation's overlay repo's
# compose.yaml (+ compose.override.yaml, if present) — fetched from GitHub via
# a read-only deploy key — diffs them, and compares that drift against an
# ACCEPTED BASELINE. Only NEW drift alerts — known divergence (nora/tyche
# box-only, voice-learn repo-only as of 2026-08-04) is baselined until
# deliberately converged.
#
#   drift unchanged from baseline  -> Kuma status=up   (ping = drift line count)
#   drift changed / render failed  -> Kuma status=down (Kuma fires its notification)
#   guard itself broken/box down   -> no push          (Kuma missed-heartbeat fires)
#
# After a DELIBERATE change on either side (a deploy, or a back-port into the
# repo), re-accept the new steady state:
#   compose-drift-guard.sh --accept
#
# Renders use --no-interpolate, so values from /opt/agent-box/.env (including
# TOKEN_ENC_KEY) never appear in any rendered file, diff, or alert message.
#
# Config: /etc/compose-drift-guard.env (KUMA_PUSH_URL; REPO_DIR, REPO_COMPOSE,
# REPO_OVERRIDE, DEPLOY_KEY — optional path overrides; the box's env file sets
# all four explicitly).
set -uo pipefail
# Rendered configs and drift files can contain secret literals that a compose
# file hardcodes (they shouldn't, but the guard must not assume that) — keep
# every artifact root-only.
umask 077

ENV_FILE="${ENV_FILE:-/etc/compose-drift-guard.env}"
# shellcheck source=/dev/null
[ -r "$ENV_FILE" ] && . "$ENV_FILE"

STATE_DIR="${STATE_DIR:-/opt/agent-box/drift-guard}"
REPO_DIR="${REPO_DIR:-$STATE_DIR/overlay}"
REPO_COMPOSE="${REPO_COMPOSE:-$REPO_DIR/box/compose.yaml}"
REPO_OVERRIDE="${REPO_OVERRIDE:-$REPO_DIR/box/compose.override.yaml}"
BOX_DIR="${BOX_DIR:-/opt/agent-box}"
DEPLOY_KEY="${DEPLOY_KEY:-/root/.ssh/overlay_deploy_ro}"
KUMA_PUSH_URL="${KUMA_PUSH_URL:-}"
BASELINE="$STATE_DIR/accepted-drift.diff"
CURRENT="$STATE_DIR/current-drift.diff"
mkdir -p "$STATE_DIR"

push() { # status msg [ping]
  local status="$1" msg="$2" ping="${3:-}"
  echo "compose-drift-guard: $status — $msg"
  if [ -z "$KUMA_PUSH_URL" ]; then
    echo "compose-drift-guard: KUMA_PUSH_URL not set — status not pushed"
    return 0
  fi
  curl -fsS -m 15 -G "$KUMA_PUSH_URL" \
    --data-urlencode "status=$status" \
    --data-urlencode "msg=$msg" \
    ${ping:+--data-urlencode "ping=$ping"} \
    -o /dev/null || echo "compose-drift-guard: kuma push failed"
}

render() { # outfile composefile...
  local out="$1"; shift
  local args=()
  local f
  for f in "$@"; do args+=(-f "$f"); done
  docker compose -p agent-box --project-directory "$BOX_DIR" "${args[@]}" \
    config --no-interpolate > "$out" 2>"$out.err"
}

services_of() { # composefile...
  local args=()
  local f
  for f in "$@"; do args+=(-f "$f"); done
  docker compose -p agent-box --project-directory "$BOX_DIR" "${args[@]}" \
    config --services 2>/dev/null | sort
}

# --- refresh the repo copy (fetch failure tolerated 48h, then alarm) ---
fetch_note=""
if GIT_SSH_COMMAND="ssh -i $DEPLOY_KEY -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new" \
     git -C "$REPO_DIR" fetch -q --depth 1 origin main \
   && git -C "$REPO_DIR" reset -q --hard FETCH_HEAD; then
  touch "$STATE_DIR/.last-fetch"
else
  fetch_note=" [repo fetch FAILED — compared last good copy]"
  last=0
  [ -e "$STATE_DIR/.last-fetch" ] && last=$(stat -c %Y "$STATE_DIR/.last-fetch")
  if [ $(( $(date +%s) - last )) -gt 172800 ]; then
    push down "compose drift-guard: repo copy stale >48h and fetch still failing — guard is blind"
    exit 1
  fi
fi
repo_sha=$(git -C "$REPO_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)

# --- render both sides ---
box_compose_files=("$BOX_DIR/compose.yaml" "$BOX_DIR/compose.override.yaml")
# Each side uses ITS OWN generated/keeper files. Missing files remain visible as drift;
# never copy the box's output to the repository side or auto-accept runtime changes.
for owned in compose.lares-agents.yaml compose.lares-keeper.yaml; do
  [ -f "$BOX_DIR/$owned" ] && box_compose_files+=("$BOX_DIR/$owned")
done
if ! render "$STATE_DIR/compose-drift-box.yaml" "${box_compose_files[@]}"; then
  push down "compose drift-guard: BOX compose failed to render: $(head -c 300 "$STATE_DIR/compose-drift-box.yaml".err | tr '\n' ' ')"
  exit 1
fi
repo_compose_files=("$REPO_COMPOSE")
[ -f "$REPO_OVERRIDE" ] && repo_compose_files+=("$REPO_OVERRIDE")
for owned in compose.lares-agents.yaml compose.lares-keeper.yaml; do
  [ -f "$(dirname "$REPO_COMPOSE")/$owned" ] && repo_compose_files+=("$(dirname "$REPO_COMPOSE")/$owned")
done
if ! render "$STATE_DIR/compose-drift-repo.yaml" "${repo_compose_files[@]}"; then
  push down "compose drift-guard: REPO compose (@$repo_sha) failed to render: $(head -c 300 "$STATE_DIR/compose-drift-repo.yaml".err | tr '\n' ' ')"
  exit 1
fi

# -U0 + header strip: the drift file is exactly the set of divergent lines, so a
# change applied identically to both sides shifts nothing and raises no alarm.
diff -U0 "$STATE_DIR/compose-drift-repo.yaml" "$STATE_DIR/compose-drift-box.yaml" > "$STATE_DIR/compose-drift.raw"
rc=$?
if [ "$rc" -gt 1 ]; then
  push down "compose drift-guard: diff failed (rc=$rc)"
  exit 1
fi
grep -vE '^(@@|---|\+\+\+)' "$STATE_DIR/compose-drift.raw" > "$CURRENT" || true
chmod 600 "$CURRENT" "$STATE_DIR/compose-drift.raw" "$STATE_DIR/compose-drift-box.yaml" "$STATE_DIR/compose-drift-repo.yaml" 2>/dev/null
lines=$(wc -l < "$CURRENT" | tr -d ' ')

if [ "${1:-}" = "--accept" ]; then
  cp "$CURRENT" "$BASELINE"
  {
    echo "accepted-at: $(date -Is)"
    echo "repo-sha: $repo_sha"
    echo "drift-lines: $lines"
  } > "$BASELINE.meta"
  echo "compose-drift-guard: baseline accepted ($lines drift lines @ repo $repo_sha)"
  exit 0
fi

if [ ! -f "$BASELINE" ]; then
  push down "compose drift-guard: no accepted baseline — run compose-drift-guard.sh --accept after reviewing $CURRENT"
  exit 1
fi

if cmp -s "$CURRENT" "$BASELINE"; then
  push up "compose drift unchanged ($lines accepted drift lines, repo @$repo_sha)$fetch_note" "$lines"
else
  box_svcs=$(services_of "${box_compose_files[@]}")
  repo_svcs=$(services_of "${repo_compose_files[@]}")
  box_only=$(comm -23 <(echo "$box_svcs") <(echo "$repo_svcs") | paste -sd, -)
  repo_only=$(comm -13 <(echo "$box_svcs") <(echo "$repo_svcs") | paste -sd, -)
  base_lines=$(wc -l < "$BASELINE" | tr -d ' ')
  push down "NEW compose drift on agent-box: $lines drift lines vs $base_lines accepted; box-only services:[${box_only:-none}] repo-only:[${repo_only:-none}] repo@$repo_sha$fetch_note — inspect $CURRENT vs $BASELINE, then converge or --accept" "$lines"
fi
