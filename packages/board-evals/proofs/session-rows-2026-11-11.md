# How eve 1.0's workflow tables grow per turn (eve 1.0.0-rc.9)

Measured 2026-11-11 against eve 1.0.0-rc.9 with `@workflow/world-postgres` 5.1.1, by
`../scripts/session-rows-measure.mjs`. Re-run it with

```sh
node packages/board-evals/scripts/session-rows-measure.mjs
```

Docker running. A small agent written fresh into a temporary folder (a scripted model behind the
model guard, one approval-gated tool, eve's own HTTP door) is built and started with `eve start`
against a disposable Postgres. The workflow schema comes from
`services/chief-of-staff/sql/001-eve-workflow.sql`, as regenerated for world-postgres 5.1.1.

## Result

| Stage | Runs | Events | Steps | Stream chunks | Hooks | Waits | Bytes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Baseline (built and started, no session) | 0 | 0 | 0 | 0 | 0 | 0 | 196,608 |
| After turn 1 (plain) | 2 | 16 | 3 | 8 | 5 | 1 | 434,176 |
| After turn 2 (plain) | 2 | 22 | 4 | 16 | 7 | 1 | 557,056 |
| After turn 3 (tool call, approval pending) | 2 | 26 | 5 | 24 | 7 | 1 | 573,440 |
| After the session was ended | 2 | 41 | 9 | 29 | 0 | 0 | 671,744 |

- **(a) One session run carries every turn.** The run count stays at 2 after the first turn:
  `workflow//eve//workflowEntry` (the session) and `workflow//eve//sessionTimeoutWorkflow`. No run is
  added per turn.
- **(b) Per turn**, a plain turn adds about 6 events, 1 step and 8 stream chunks (about 120 KB on the
  second turn). A turn that parks an approval card adds 4 events, 1 step and 8 stream chunks.
- **(c)** The stored session title was 5 characters long here.
- **(d) Ending the session releases its hooks and its wait** (7 hooks and 1 wait before, 0 after),
  and writes about 15 more events.
- **(e)** `$eve.type` values seen: none, and `session`.

## How the end is confirmed on rc.9

`end()` is accepted, but its receipt cannot be read to its settlement. The session ends and its
stream closes first, and `result()` throws "The stream ended before the accepted delivery
settled." (Observed here.) So the script confirms the end differently: a later message to the same
session must be refused, and it was. The keeper's conversation reset in the kit waits on exactly
that receipt, which is why it reports failure on rc.9 (see the evaluations pull request).
