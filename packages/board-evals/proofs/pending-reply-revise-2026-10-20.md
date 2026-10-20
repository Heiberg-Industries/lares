# A revised proposal withdraws the older approval card, 2026-10-20

Question: when the agent redrafts in a LATER turn and raises a new approval card, does our
`approval-supersede` hook cancel the older card, even though the cancel is sent while the revising
turn is still running? Follow-up to `pending-reply-2026-10-19.md`, scenario (e) of the same script.

```sh
pnpm -C packages/board-evals run proof:pending-reply
```

Same method and limits as the earlier proof (real `eve build`/`eve start` 0.60.1, scripted model,
disposable Postgres, no credential, no network beyond loopback). Differences for (e):

- The REAL hooks are loaded in the disposable app: `@lares/agent-kit/approval-record-hook` and
  `@lares/agent-kit/approval-supersede-hook`, registered as the roles register them. The only
  difference is that the cancel is aimed at this run's loopback port (a role listens on 3000).
  The cancel itself is the real `cancelApprovalRequest`: HTTP Basic with the route password.
- The database has the baseline plus `services/box/sql/006_approval_session.sql`.
- The ledger is emptied before (e): the scripted model reuses the same call id in every session
  and the ledger keeps one row per call id. A real model never repeats one.
- Not observed: Slack/Telegram repaint.

## Observed (session `wrun_01M5C5DTTB2HE846H1B4S3BKMY`)

1. Turn 1 (`pr:send E1`) parked card `aitxt-Or9oIVOHKyJ4UwyRXU1VIxDE`.
2. Turn 2 (a text reply, `pr:send E2`): the model called the same tool again. Stream:
   `turn.started, message.received, step.started, actions.requested, step.completed, input.requested,
   turn.completed, session.waiting`. New card `aitxt-CjxLnOzfqlQZxPchwaNLPrH3`. The supersede hook
   ran inside that turn and sent the cancel while it was still running.
3. After the wait, the stream continued: `approval.settled` (`outcome: "cancelled"`), then
   `input.resolved` with `outcome: "denied"` and `optionId: "cancel"` for the OLD request id, then
   `action.result`. So eve accepted a cancel delivered during an active turn and applied it.
4. Tool log before approving the new card: empty. The old call never executed.
5. Ledger (`approval_asks`): old row `outcome = cancelled, answered_via = revised, turn_sequence 0`;
   new row `outcome = NULL, turn_sequence 1`, same session. eve's later "denied" did not overwrite
   `revised` (first answer wins).
6. The new card was live and approvable: approving it answered 202 and the log read `sent:E2`.
7. A late `approve` of the old card answered 202 and nothing ran. Final tool log: `sent:E2` only.

Confidence: high for the sequence above (two earlier runs of the script, with debugging output,
gave the same result once the call-id reuse was removed). The hook's own database step alone would
already refuse the old call if a tool checked the ledger; this fixture's tool does not, so the
no-execution result here is eve's cancel working.

Not shown: how a door paints the withdrawn card ("Cancelled" is eve's wording; a "Revised" line
would be a separate change).
