# Console / LAR-50 handoff — 29 September 2026

## Post-rebuild continuation

The closing checkpoint below is historical. The owner approved and completed
the disposable server rebuild. Its fresh first agent and provider-backed chat
passed on the exact pinned console image, followed by a guarded off-box restore
of the prior agent and Preferences marker. The corrected one-key repair,
audited reconcile and post-restore chat passed. The post-restore off-box
snapshot, five-database scratch drill and verifier passed; the installed
Backup page says **Protected**. The detailed record is in
[the run ledger](../runbooks/golden-path-runs.md), and the exact targets and
recovery points are in [the teardown decision record](lar50-rebuild-teardown-decision-2026-09-29.md).

PR #32 is still draft, now at `263d64f` with its new checks running at this
update. Linear LAR-50 is still In Progress; a checkpoint comment was added.
The four-answer install needed a model-key entry repair and saved-answer
resume, so strict unassisted docs-only acceptance remains unobserved. The
prior Google reads and accepted freshness heartbeat are documented in the
28 September run. Final teardown has its own unapproved decision. Production
deployment remains separate.

## Closing checkpoint

The owner accepted the current desktop console result as **good for now** and
asked to move quickly to a release-readiness review. This is a decision to
defer further UI polish, not approval to merge, deploy to production, rebuild
the disposable server, or mark LAR-50 complete. The populated Preferences row
and Reset control were source-tested but were not visually checked on the
latest installed image; mobile remains deferred. Track these as follow-ups
unless the release review finds a material blocker.

At this checkpoint, [draft PR #32](https://github.com/Heiberg-Industries/lares/pull/32)
has head `4220fcc5e6360b0646e3cd7e3aae4aed40415283`, a clean isolated worktree
at `/private/tmp/lares-console-redesign-20260929`, and no pending or failed
checks. This latest commit changes only the documentation and release pin. Its
console image was built from source commit
`6b801692d05278f1287b78d2228689bb67a57f93` by
[workflow run 36529611279](https://github.com/Heiberg-Industries/lares/actions/runs/36529611279).
The disposable server at `89.167.43.7` runs
`ghcr.io/heiberg-industries/lares-engine-console@sha256:ce29621357025ca109cbba09481ae62f87bc81a6f1abcc7c1a72f9510bfa513c`.
The OCI revision matched the image source commit. All seven expected containers
were up at the closing check; only the console had been recreated for this
image. `/srv/taste` is mounted. The prior Compose pin is backed up at
`/opt/lares/compose.yaml.pre-6b80169`. The immutable pin is in
`releases/2026-09-29-console-test.1.json`. The authenticated Preferences page
showed the shared English New/Changed treatment and Instrument Sans Variable
as computed body and heading font. The Preferences test store is empty after
the owner's earlier save/reload/filter/delete QA.

The detailed [screen record](console-verification-2026-09-28.md) and
[golden-path run ledger](../runbooks/golden-path-runs.md) distinguish source,
server and browser proof. Main checkout `/Users/bendik/Developer/lares` was
read-only at `8417f0c`; do not use it for PR edits. The former 25 September
temporary worktree is registered but absent. Recheck all paths and state at
the start of the next session.

## Fast next-session order

1. Recheck PR #32, Linear LAR-50, current server digest and container state,
   and this handoff. Review the exact PR diff for release blockers: migrations,
   installer and export changes, secrets, design-system use, rollback, and
   dependency on PR #29 or #20. Give the owner a concrete merge/deploy decision
   with any narrow fixes completed on the branch first. Do not equate the
   console-only test image with a clean installation.
2. Keep [LAR-50](https://linear.app/heiberg-industries/issue/LAR-50/the-fresh-install-golden-path-qa-for-the-installation-bendik-does-not)
   In Progress while planning its remaining golden-path proof. The previous
   fresh OS install reused saved answers and credentials, so it does not prove
   the docs-only four-question owner flow. The first brief was represented by
   a freshness heartbeat, not an observed delivered brief; decide explicitly
   whether that substitute meets acceptance. Restore needed a manual LiteLLM
   key-hash rotation; automate or document a guarded repeatable step. Backup
   status still reported Not protected. Preferences export/restore is unproved.
3. Only after the current restored installation has been declared disposable
   and required evidence preserved, run the remaining clean install and
   backup/restore drill. Rebuild and final server teardown are destructive and
   need a specific owner decision at the action point. Use private credential
   entry and record provider spend. Close LAR-50 only when the ticket's actual
   acceptance evidence and teardown are in the run ledger; otherwise leave it
   open with precise blockers.

The next session may be able to finish LAR-50 if the owner is available for
the clean onboarding and destructive decisions and the restore/backup defects
are resolved. It is not ready to close at this checkpoint.
