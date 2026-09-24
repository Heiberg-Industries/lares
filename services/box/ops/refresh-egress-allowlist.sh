#!/usr/bin/env bash
# services/box/ops/refresh-egress-allowlist.sh
# Resolve the egress allow-hosts and flush their current IPs into the nftables
# named sets `egress_allow` (v4) and `egress_allow6` (v6). Run on a timer so the
# allowlist tracks DNS rotation (Slack especially). Idempotent.
set -euo pipefail

TABLE="inet egress"
# This legacy refresh helper must receive the installation's reviewed allowlist.
# Never infer private gateway/CRM hosts or flush existing rules with empty input.
HOSTS_FILE="${LARES_EGRESS_HOSTS_FILE:-/etc/lares/egress-hosts}"
[[ -r "$HOSTS_FILE" ]] || { echo "egress-allowlist: readable hosts file required: $HOSTS_FILE" >&2; exit 1; }
HOSTS=()
while IFS= read -r line || [[ -n "$line" ]]; do
  line="${line%%#*}"
  read -r host extra <<< "$line"
  [[ -n "$host" ]] || continue
  if [[ -n "$extra" || ! "$host" =~ ^[A-Za-z0-9][A-Za-z0-9.-]*$ ]]; then
    echo "egress-allowlist: expected one DNS hostname per line" >&2
    exit 1
  fi
  HOSTS+=("$host")
done < "$HOSTS_FILE"
[[ "${#HOSTS[@]}" -gt 0 ]] || { echo "egress-allowlist: empty hosts file; existing rules unchanged" >&2; exit 1; }


v4=()
v6=()
for h in "${HOSTS[@]}"; do
  # getent returns one line per address family; split accordingly.
  while read -r addr _; do
    case "$addr" in
      *:*) v6+=("$addr") ;;
      *.*) v4+=("$addr") ;;
    esac
  done < <(getent ahosts "$h" || true)
done

# De-dup. Guard the empty case: `printf '%s\n' "${arr[@]}"` on an empty array
# still emits one blank line, which would become a spurious empty element.
[ "${#v4[@]}" -gt 0 ] && mapfile -t v4 < <(printf '%s\n' "${v4[@]}" | sort -u)
[ "${#v6[@]}" -gt 0 ] && mapfile -t v6 < <(printf '%s\n' "${v6[@]}" | sort -u)

# Atomically replace the set contents via a single nft -f transaction so
# there is no window where egress_allow is empty between flush and repopulate.
TMPFILE=$(mktemp /tmp/egress-refresh-XXXXXX.nft)
{
  printf 'flush set %s egress_allow\n' "${TABLE}"
  [ "${#v4[@]}" -gt 0 ] && printf 'add element %s egress_allow { %s }\n' "${TABLE}" "$(IFS=,; echo "${v4[*]}")"
  printf 'flush set %s egress_allow6\n' "${TABLE}"
  [ "${#v6[@]}" -gt 0 ] && printf 'add element %s egress_allow6 { %s }\n' "${TABLE}" "$(IFS=,; echo "${v6[*]}")"
} > "${TMPFILE}"
nft -f "${TMPFILE}"
rm -f "${TMPFILE}"

echo "egress-allowlist: ${#v4[@]} v4 + ${#v6[@]} v6 addresses across ${#HOSTS[@]} hosts"
