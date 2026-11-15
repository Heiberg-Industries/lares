# shellcheck shell=bash
# workflow-store-steps.sh — the agent-store steps that update.sh and restore.sh share.
#
# Sourced, never run. An agent store is one agent's workflow database. When a store was left by
# an older release, both scripts bring it to this release the same way: check it, run the agent
# framework's own schema step on it, check it again and require `current`, then apply and verify
# the agent login's permissions. The steps live here once, so the two scripts cannot drift.
#
# Needs, before it is used:
#   workflow_store_step     from engine-run.sh: runs ops/workflow-store-migrate.mjs inside the
#                           release's creative role image (check, upgrade or create)
#   workflow_apply_one KIND DATABASE ERRFILE
#                           from the caller: applies and verifies the agent login's permissions
#                           on one database (KIND is template or store), through that caller's
#                           own guarded engine client, with its reason on ERRFILE when it fails
# Every failure leaves a plain sentence in WORKFLOW_REASON and returns 1.

# The last line a program wrote on its way out, without that program's own name in front.
workflow_reason_from() {
  sed -e '/^[[:space:]]*$/d' -e 's/^workflow stores: //' -e 's/^workflow store: //' "$1" 2>/dev/null | tail -1 | cut -c1-600
}

# workflow_store_state ROLE_IMAGE DATABASE HOST PORT PROVISIONER_PASSWORD_FILE ERRFILE
# The store's own check, reduced to its one word (old, current or empty). Changes nothing.
# Returns 1 when the check refused or could not finish; its reason is on ERRFILE.
workflow_store_state() {
  local answer
  answer=$(workflow_store_step "$1" check "$2" "$3" "$4" "$5" 2> "$6") || return 1
  printf '%s' "$answer" | tr -d '\r' | sed '/^$/d' | tail -1
}

# workflow_store_bring_current SAY ROLE_IMAGE HOST PORT PROVISIONER_PASSWORD_FILE WORKDIR KIND DATABASE STATE LABEL
# STATE is what workflow_store_state said a moment ago: `old` is upgraded first; `current` only
# gets its permissions applied and checked (an earlier run may have stopped between the two).
# SAY is the prefix of the lines it prints (update, restore). WORKDIR holds its error files.
workflow_store_bring_current() {
  local say="$1" role_image="$2" host="$3" port="$4" provisioner="$5" work="$6"
  local kind="$7" database="$8" state="$9" label="${10}" after
  if [ "$state" = old ]; then
    echo "$say: upgrading $label."
    if ! workflow_store_step "$role_image" upgrade "$database" "$host" "$port" "$provisioner" \
        > "$work/workflow-migrate.out" 2> "$work/workflow-migrate.err"; then
      WORKFLOW_REASON="$label: $(workflow_reason_from "$work/workflow-migrate.err")"
      return 1
    fi
    # The package's step ends its own process, so its result is read back, never assumed.
    if ! after=$(workflow_store_state "$role_image" "$database" "$host" "$port" "$provisioner" "$work/workflow-check.err"); then
      WORKFLOW_REASON="$label: after its upgrade, $(workflow_reason_from "$work/workflow-check.err")"
      return 1
    fi
    if [ "$after" != current ]; then
      WORKFLOW_REASON="$label: it is not at this release's schema after its upgrade"
      return 1
    fi
  else
    echo "$say: $label is already upgraded; checking its permissions."
  fi
  if ! workflow_apply_one "$kind" "$database" "$work/workflow-apply.err"; then
    WORKFLOW_REASON="$label: its permissions could not be applied and verified ($(workflow_reason_from "$work/workflow-apply.err"))"
    return 1
  fi
  return 0
}
