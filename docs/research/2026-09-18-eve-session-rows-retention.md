# Can eve's own session rows be pruned? — measured, not assumed

**Date:** 2026-09-18 · **eve:** 0.32.0 (patched, root `patches/`) · **World:** `@workflow/world-postgres@5.0.0-beta.32`
**Question:** ADR-0020 rule 5 says eve's own session/workflow rows are "kept only as long as eve needs
them to run … pruned once a session is closed and past its operational need". This finding establishes
whether such a prune can be written, and what it may touch.
**Output:** a finding. **No code, no SQL, no migration, no test is produced by this work.**

Every claim below was read out of the installed packages and this repository in this worktree. Where a
fact could not be established by reading, it is marked as such rather than guessed — the whole point of
the question is that a wrong answer deletes rows a live conversation is standing on.

---

## In plain language

eve keeps its own private bookkeeping of a live conversation in six database tables, entirely separate
from the conversation record this project owns. Three of those tables hold the actual words: the run
table keeps the first 125 characters of the opening message in clear text, and the step and stream
tables keep the whole conversation — every message, every tool call, every tool result — as compressed
binary. Nothing in this repository reads any of them; they exist only so the framework can pick a
conversation back up. Today nothing ages them out: the framework does delete a conversation's parked
approvals and sleeping timers by itself the moment that conversation ends, but the words are kept for
ever. A conversation is also not "one chat-day" as this repo's own documents say — the framework's own
limit is thirty days of silence, and only private chats on one door are rotated daily, by our code, not
the framework's. So a person's words can sit in eve's tables for a month before that conversation even
counts as closed, and indefinitely after it. Deleting rows is not obviously safe and this reading could
not prove it either way: there are no foreign keys anywhere in that schema, so the database will
cheerfully let a prune delete a row a live conversation still needs, and the visible result is a wedged
chat or an approval button that fails when the owner presses it. The recommendation is therefore to
delete nothing on the current version and to write the prune after the planned framework upgrade, which
retires every live conversation anyway and so performs the first sweep for free.

---

## Verdict

| # | Question | Answer |
|---|---|---|
| Q1 | Does the package prune anything of its own today? | **Yes, but only two tables.** Hooks and waits, deleted the instant their run turns terminal. Runs, events, steps and stream chunks are never deleted by any code in the package. |
| Q2 | Is there a retention/TTL/vacuum sweeper? | **No.** One env knob exists (`WORKFLOW_POSTGRES_HOOK_RETENTION_LIMIT_DAYS`, default 30) and it only caps how long a *caller* may ask a hook to be retained. No scheduler, no sweep, no vacuum. |
| Q3 | What marks a session closed? | `workflow_runs.status ∈ ('completed','failed','cancelled')`, with `completed_at` set. **`expired_at` is a dead column** — declared, never written by eve, world, world-local or world-postgres. |
| Q4 | Is a session "one chat-day"? | **No — that claim is wrong for this engine.** eve's default is a 720-hour (30-day) session timeout and the door tokens carry no date. Only one door on one role rotates daily, and it does so in Lares code. |
| Q5 | What breaks if a closed session's rows are deleted? | A plain message **self-heals** (the door silently opens a new session). An **approval-card answer throws** — the owner's press fails. |
| Q6 | Does `graphile_worker` hold turn content too? | **Yes, transiently** — a queued job's payload can carry the run's input message and a hook's resume payload. Rows are deleted on success; a permanently-failed job keeps its payload for ever. |
| **Verdict** | **Is a prune safe?** | **UNKNOWN UNTIL MEASURED**, and not worth measuring against 0.32. See [The verdict](#the-verdict). |

---

## What the schema is, and where it comes from

`services/chief-of-staff/sql/001-eve-workflow.sql` is a **generated** file. Its hand-written header
(`:1-55`) records the derivation and the two commands behind it (`:9-10`); the generator is
`packages/agent-kit/bin/regen-eve-workflow-sql.ts`, whose own header (`:1-56`) states what the source
is: the installed `@workflow/world-postgres`'s own migrations under `src/drizzle/migrations`, replayed
into a disposable Postgres 16 and dumped, then rewritten statement-by-statement to be safe to re-run
(`toIdempotent()`). The installed package is `@workflow/world-postgres@5.0.0-beta.32`
(`services/chief-of-staff/node_modules/@workflow/world-postgres/package.json:3`), which ships 19
migrations, `0000`–`0018`.

Two consequences that bear on a prune:

- **The file is not ours to reason about as a stable contract.** It is regenerated on every world bump
  and the check (`regen:eve-sql:check`) compares statements, not bytes. Any predicate written against a
  column name here is a predicate against one pinned beta of a third-party package.
- **There is not a single foreign key in it.** The only constraints created are seven primary keys
  (`:210-271`) and nine indexes (`:273-293`). Nothing in the database will refuse a delete that orphans
  a live run's events, steps or stream. The safety of a prune is entirely a property of the code, and
  the database offers no second net.

The same file's header (`:40-48`) states that the `graphile_worker` schema is deliberately excluded
because it is self-provisioning — `createWorld().start()` calls graphile-worker's own
`run()`/`makeWorkerUtils()`, which installs and migrates it on first connect.

---

## Table-by-table inventory

Six tables in schema `workflow`, plus one bookkeeping table in `workflow_drizzle`. "Content" below means
turn content in the privacy sense: message text, tool call arguments, tool results.

| Table (created at) | What keys it to a session | Holds conversation content? | Deleted by the package? | Read by anything in this repo? |
|---|---|---|---|---|
| `workflow.workflow_events` (`sql/001-eve-workflow.sql:95`) | `run_id` (no FK); `correlation_id` | **Yes.** `payload`/`payload_cbor` is the event log the run replays from — it carries each event's data, including hook-received payloads (a delivered message, an approval answer). | **No.** No delete path anywhere in the package. | **No.** No product code reads it. |
| `workflow.workflow_hooks` (`:106`) | `run_id` (no FK); addressed by `token` | **Yes, partly.** `metadata`/`metadata_cbor` and `resume_context` (bytea). The channel address token is `<channelName>:<continuationToken>`. | **Yes.** Deleted on the run's terminal event and on legacy cancel — see [What the package already prunes](#what-the-package-already-prunes). | Diagnostically only: a test header reconstructs an incident from it (`services/chief-of-staff/tests/approver-scheduled-session.test.ts:5-13`). |
| `workflow.workflow_runs` (`:123`) | **This table _is_ the session.** `id` is the eve session id (see below). `attributes` carries `$eve.type`, `$eve.parent`, `$eve.root`. | **Yes, and one field is in the clear.** `input`/`input_cbor`, `output`/`output_cbor`, and `attributes->>'$eve.title'` — up to 125 characters of the opening user message, as plain jsonb text. | **No.** | **No.** One code comment records that `input_cbor` is snapshotted before resolvers run (`services/chief-of-staff/agent/instructions/clock.ts:17-20`); the CI image probe dumps it (`services/keeper/tests/runtime-image.probe.py:134`). |
| `workflow.workflow_steps` (`:147`) | `run_id` (no FK) | **Yes — the most of anything.** `input_cbor`/`output_cbor` are each `"use step"` call's arguments and result. The session-creation step's result is the **durable session snapshot**, which carries `history` — the entire message list — and `agent.system`, the assembled system prompt. | **No.** | **No.** The probe dumps it and the restart guard counts `status='running'` (`runtime-image.probe.py:29,134`). |
| `workflow.workflow_stream_chunks` (`:167`) | `run_id` (nullable, no FK); `stream_id` | **Yes.** `data` (bytea) is the run's NDJSON event stream — what a client reads back as the conversation. eve reads a session's durable snapshot off a per-run stream namespace when no inline snapshot is available. Append-only: every chunk ever written stays. | **No.** | **No** in product code; the probe's client reads a session's stream to read the conversation back (`runtime-image.probe.py:70`). |
| `workflow.workflow_waits` (`:176`) | `run_id` (no FK) | **No.** `wait_id`, `status`, `resume_at`, timestamps. | **Yes.** All waits of a run deleted on its terminal event. | **No.** |
| `workflow_drizzle.workflow_migrations` (`:187`) | — | No. | No. | No — and the generated file deliberately leaves it empty (`sql/001-eve-workflow.sql:50-55`). |

**A session is a run.** `workflowEntry` sets `e.serializedContext["eve.sessionId"] = workflowRunId`
(`services/chief-of-staff/node_modules/eve/dist/src/execution/workflow-entry.js:1`), and
`resolveContinuation` answers `{ sessionId: (await getHookByToken(token)).runId }`
(`…/dist/src/execution/workflow-runtime.js:1`). So `workflow_runs.id` is the session id the doors, the
console and the turn-capture hook all use.

**Three kinds of run share the table**, distinguished by `workflow_runs.name`, whose three stable values
are declared in one line of `workflow-runtime.js:1`:

```js
const WORKFLOW_ENTRY_NAME=`workflowEntry`,TURN_WORKFLOW_NAME=`turnWorkflow`,SESSION_TIMEOUT_WORKFLOW_NAME=`sessionTimeoutWorkflow`;
```

and cross-checked by `workflow_runs.attributes`, which eve writes at `start()` with
`allowReservedAttributes` (`workflow-runtime.js:1`) from `buildSessionAttributes` /
`buildTurnAttributes` / `buildSubagentRootAttributes`
(`…/dist/src/execution/eve-workflow-attributes.js:1`):

```js
function buildSessionAttributes(e){return{"$eve.channel_request_id":…,"$eve.type":`session`,"$eve.trigger":readChannelKind(…),"$eve.title":deriveSessionTitle(e.inputMessage)}}
function buildTurnAttributes(e){return{"$eve.channel_request_id":e.requestId,"$eve.type":`turn`,"$eve.parent":e.parentSessionId,"$eve.root":e.rootSessionId}}
```

`deriveSessionTitle` (same file) is `collectMessageText(...)` truncated to 125 characters. **The owner's
opening sentence is stored, in the clear, in a queryable jsonb column.** That is the single most
exportable piece of content in this schema and the one an erase routine would most obviously be expected
to reach.

This also gives a prune the only structural handle it has: on 0.32 a turn is a **child run** of its
session (`$eve.type = 'turn'`, `$eve.parent = <session run id>`), and the session's own idle timer is a
**third run** (`name = 'sessionTimeoutWorkflow'`) that does nothing but `sleep(deadline)` and then signal
(`…/dist/src/execution/session-timeout-workflow.js:1`).

---

## What "a closed session" is, read from the package's own source

`TERMINAL_WORKFLOW_RUN_STATUSES` is `['completed','failed','cancelled']`
(`node_modules/.pnpm/@workflow+world@5.0.0-beta.25/node_modules/@workflow/world/dist/runs.js:11-18`), and
the three terminal run **events** are `run_completed`, `run_failed`, `run_cancelled`
(`…/@workflow/world/dist/events.js:40-48`). The storage layer treats terminality as a hard wall: once a
run is terminal, `run_started` raises `RunExpiredError` and every other transition, child-entity creation
or attribute set raises `EntityConflictError`
(`services/chief-of-staff/node_modules/@workflow/world-postgres/dist/storage.js:535-555`).

**`completed_at`** is set alongside the status change. **`expired_at` is never written.** It appears
exactly once in the package — the column declaration
(`…/@workflow/world-postgres/dist/drizzle/schema.js:69`) — and once as an optional zod field
(`…/@workflow/world/dist/runs.js:110`). A grep for `expiredAt`/`expired_at` across the installed
`@workflow/world`, `@workflow/world-local`, `@workflow/world-postgres` and eve's own
`dist/src/execution/` finds no writer and no reader. **A prune predicate must not use it**, and the
migration that introduced it (`src/drizzle/migrations/0002_add_expired_at.sql`) is, on this beta, a
column with no behaviour.

So: **a closed session is `status IN ('completed','failed','cancelled')`, nothing else.**

---

## What the package already prunes

Two tables, and only on one trigger. In `createEventsStorage`'s `create()`
(`…/@workflow/world-postgres/dist/storage.js:774-785`):

```js
if (isTerminalRunEventType(data.eventType)) {
    // Retained Hooks remain visible after the run ends. Other Hooks and
    // all waits are removed immediately.
    await Promise.all([
        drizzle.delete(Schema.hooks).where(and(eq(Schema.hooks.runId, effectiveRunId), hookRetentionEnded)),
        drizzle.delete(Schema.waits).where(eq(Schema.waits.runId, effectiveRunId)),
    ]);
}
```

with

```js
const hookRetentionEnded = or(isNull(Schema.hooks.tokenRetentionUntil), lte(Schema.hooks.tokenRetentionUntil, sql`now()`));
```
(`storage.js:298`)

The same pair is deleted on the legacy cancel path (`storage.js:217-220`), and a single hook is deleted
on `hook_disposed` (`storage.js:1227-1236`).

**On this installation `hookRetentionEnded` is always true.** `token_retention_until` is only ever
populated from a `hook_created` event's `eventData.tokenRetentionUntil` (written at `storage.js:1213`, capped at `storage.js:345-350`), and eve
0.32 never sets it: a grep for `tokenRetentionUntil` across `eve/dist/src/execution`, `…/internal`,
`…/harness` and `…/channel` returns nothing — the identifier appears only inside eve's vendored copies
of the `@workflow/*` libraries under `dist/src/compiled/`. So every hook of a run is deleted the moment
that run turns terminal, and `workflow_hooks.token_retention_until` is, in practice, a column that is
always NULL here.

**The only retention knob is a cap, not a sweep.** `getHookRetentionLimitMs()`
(`storage.js:8-14`) reads `WORKFLOW_POSTGRES_HOOK_RETENTION_LIMIT_DAYS`, default 30, and is used solely
to reject a `hook_created` that asks for more than that (`storage.js:345-350`). Nothing sets that
variable in this repo — a grep for `WORKFLOW_POSTGRES_` across `services`, `packages` and `images` finds
only `WORKFLOW_POSTGRES_URL` (`services/keeper/lib/compose-agents.ts:69`,
`services/keeper/tests/runtime-image.probe.py:80`).

**There is no other delete in the package.** A grep for `delete|cleanup|retention|prune|vacuum|sweep|ttl`
across `dist/` and `src/` yields exactly the six `.delete(Schema.…)` call sites above, all against
`Schema.hooks` and `Schema.waits`, plus in-memory `Map.delete` calls in the queue and streamer. There is
no scheduled job, no `VACUUM`, no age-based statement. `createWorld()`'s `start()` does exactly two
things — start the queue and `reenqueueActiveRuns(...)`
(`…/@workflow/world-postgres/dist/index.js:50-53`) — and `close()` closes the queue, the streamer and
the pool.

**Verdict on Q1/Q2: the package cleans up its addressing (hooks) and its timers (waits) and nothing
else. Runs, events, steps and stream chunks grow without bound, for ever.**

---

## How long a session, an approval or a sleeping timer may legitimately stay pending

This is where the repo's own documentation is wrong, and the correction matters more than anything else
in this note.

**eve's default session timeout is 720 hours — thirty days.**

```js
const DEFAULT_SESSION_TIMEOUT_MS=720*60*60*1e3;
```
(`services/chief-of-staff/node_modules/eve/dist/src/execution/session-timeout.js:1`)

It is applied as `new Date(workflowStartedAt + (sessionTimeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS))`
(`…/dist/src/execution/workflow-entry.js:1`), where `sessionTimeoutMs` comes from a definition's
`limits.sessionTimeoutMs` (`…/dist/src/runtime/resolve-agent.js:1`). **No role service sets it.** None of
`services/{chief-of-staff,travel,creative}/agent/agent.ts` declares a `limits` block, and a repo-wide
grep for `sessionTimeoutMs` outside `node_modules` returns nothing.

**The door tokens carry no date.** Telegram's is `` `${chatId}:${threadId}:${conversationId}` ``
(`…/eve/dist/src/public/channels/telegram/api.js:1`, `telegramContinuationToken`); Slack's is
`` `${channelId}:${threadTs}` `` (`…/eve/dist/src/public/channels/slack/api.js:1`). The channel address
a session is reached by is `` `${channelName}:${continuationToken}` ``
(`…/eve/dist/src/channel/channel-address.js:1`). Nothing about a calendar day appears anywhere in that
derivation.

**Where "one chat-day" actually comes from.** It is Lares code, on one door, on one role:
`services/chief-of-staff/lib/telegram-rotation.ts`. Its header says so in as many words (`:1-10`):

> eve's own continuation-token formula … collapses to `<chatId>::` for a private chat whose `onMessage`
> never sets a `conversationId` — one session per chat, **bounded only by the framework's 30-day default
> session timeout, which releases with no summary** (verified live 2026-08-16 …)

The rotation runs on `message.completed`, summarises the day and calls
`channel.continuation.rekey(\`telegram:${chatId}:retired:${state.osloDay}\`)`
(`services/chief-of-staff/agent/channels/telegram.ts:413`) so the *next* inbound message starts a fresh
session. `rekey` only rewrites the token the session holds in its own context
(`…/eve/dist/src/channel/session.js:1`, `namespaceContinuationToken`); **it does not end the old
session.** A rotated session becomes an orphan: no token addresses it, but its run stays non-terminal
until its 30-day timer fires, and every world restart re-enqueues it
(`…/@workflow/world/dist/recovery.js:12-40`, `for (const status of ['pending','running'])`).

So the honest numbers, for this engine, today:

| Thing pending | How long it may legitimately stay | Where that is set |
|---|---|---|
| A live session (Slack thread) | **up to 30 days of silence** | eve default; nothing overrides it |
| A live session (Telegram private chat, chief-of-staff) | rotated at the installation's calendar-day boundary — but the **retired run lives on up to 30 days** | `lib/telegram-rotation.ts`, `agent/channels/telegram.ts:413` |
| A parked approval card | as long as its session — **up to 30 days** | its hook row; deleted only when the run turns terminal |
| A sleeping session timer | **up to 30 days** | `sessionTimeoutWorkflow` doing `sleep(deadline)` → a `workflow_waits` row with `resume_at` |
| A sleeping *schedule* | **not in these tables at all** | eve schedules are cron task registrations (`…/eve/dist/src/runtime/schedules/register.js:1`), not durable runs |

**Consequence for ADR-0020's rule 5 as written:** "pruned once a session is closed" is a much weaker
promise than it reads. On a quiet Slack thread, "closed" can be a month away, and an orphaned rotated
session is closed only by a timer nobody watches.

---

## What breaks if a closed session's rows are deleted

The whole answer is in one function, `createChannelAddress`'s `deliver`
(`…/eve/dist/src/channel/channel-address.js:1`), reproduced with its control flow intact:

```js
dispatch=async()=>{let t=await r.runtime.dispatchContinuation({command:u,continuationToken:a});return t.status===`accepted`?createSession(t.sessionId,r.runtime,i):void 0},
d=await dispatch();
if(d!==void 0)return d;
if(s.inputResponses&&s.inputResponses.length>0)throw Error(`Cannot deliver inputResponses — the target session was not found via continuation token.`);
… return createSession((await r.runtime.createSession(p)).sessionId,r.runtime,i)
```

and in `dispatchWorkflowCommand` (`…/eve/dist/src/execution/workflow-runtime.js:1`):

```js
try{i=normalizeWorkflowHook(await resumeHook(e,sessionHookPayload(n)))}catch(r){if(isInactiveCommandTarget(r))return inactiveCommandResult(n);throw …}
…
function isInactiveCommandTarget(e){if(HookNotFoundError.is(e))return!0;for(let t of walkCauseChain(e))if(WorkflowRunNotFoundError.is(t)||RunExpiredError.is(t)||EntityConflictError.is(t))return!0;return!1}
function inactiveCommandResult(e){return e.kind===`send`?{status:`session_not_active`}:e.kind===`cancel`?{status:`no_active_turn`}:{status:`no_active_session`}}
```

Read in order, this answers the slice's question precisely:

1. **`dispatchContinuation` cannot resume a session whose rows are gone**, and it does not pretend to. A
   missing hook (`HookNotFoundError`), a missing run (`WorkflowRunNotFoundError`), or a terminal run
   (`RunExpiredError`, `EntityConflictError`) all resolve to an inactive status rather than an exception.
2. **For an ordinary message the door self-heals, silently.** `deliver` falls through to
   `runtime.createSession(...)` under the *same* continuation token, so the next message simply starts a
   new session. The owner loses the thread's memory; nothing wedges, nothing errors.
3. **For an approval-card answer the door throws.** `respond()` is `deliver({inputResponses})`
   (`channel-address.js:1`), and that path has no fallback — it raises
   `Cannot deliver inputResponses — the target session was not found via continuation token.` This is
   the concrete harm the slice was commissioned to find: **a prune that removes the rows behind a parked
   approval turns the owner's press of "Approve" into an error, not a no-op and not a retry.**
4. `cancel`, `compact`, `clear` and `reset` return `no_active_turn` / `no_active_session`.
5. A **subagent** parent treats it as permanent failure: `status === 'session_not_active'` becomes
   `err({permanent:true})` with `Agent session "…" is no longer active.`
   (`…/eve/dist/src/execution/agent-handle-dispatch.js:1`).

Two further hazards a prune must respect, both established above:

- **A non-terminal run is a live obligation held by the queue.** `reenqueueActiveRuns` re-enqueues every
  `pending`/`running` run on every world start (`…/@workflow/world/dist/recovery.js:12-40`). Deleting
  such a run leaves a job that can never find it.
- **The session's own memory travels as step output.** `createSessionStep` is a `"use step"` returning
  `{ state: createDurableSessionState(...) }` (`…/eve/dist/src/execution/create-session-step.js:1`), and
  `projectToDurableSession` carries `history` and `agent.system`
  (`…/eve/dist/src/execution/session.js:1`). eve also has a read path that fetches a session's snapshot
  from a per-run stream namespace, `eve.session`, tail-first
  (`…/eve/dist/src/execution/durable-session-store.js:1`, `readDurableSession`). **Deleting a live
  session's steps or stream chunks destroys the conversation it is holding.**

---

## The `graphile_worker` schema

`sql/001-eve-workflow.sql:40-48` excludes it deliberately, because it is self-provisioning. It is not
elsewhere: it is **a second schema in the same database**. Each agent gets its own workflow database
(`services/box/sql/042_agent_resources.sql:6`, `workflow_database text NOT NULL UNIQUE`) and the keeper
passes it as `WORKFLOW_POSTGRES_URL` (`services/keeper/lib/compose-agents.ts:69`); the world package
resolves `WORKFLOW_POSTGRES_URL` then `DATABASE_URL`
(`…/@workflow/world-postgres/dist/index.js:19-23`, and the same precedence is reproduced in
`packages/agent-kit/src/release-stale-workflow-locks.ts:62-64`). graphile-worker installs its schema into
whatever database that is. The CI probe queries both schemas side by side in one connection
(`services/keeper/tests/runtime-image.probe.py:29`).

**It holds turn content, transiently.** A job's payload is `MessageData` — `{id, data, attempt,
messageId, idempotencyKey, headers}` where `data` is the base64 of the queue message body
(`…/@workflow/world-postgres/dist/queue.js:96-116`, `dist/message.js:1-18`). That body is a
`WorkflowInvokePayload`, which carries **`runInput`** ("Run creation data, only present on the first
queue delivery from `start()`") and **`hookInput.payload`** ("The serialized resume payload, reused
verbatim from the direct write")
(`node_modules/.pnpm/@workflow+world@5.0.0-beta.25/node_modules/@workflow/world/dist/queue.js:139-175`,
`:116-138`). In plain terms: the inbound message on a new session, and the payload of an approval or a
delivery on a resume, both pass through `graphile_worker._private_jobs.payload`.

graphile-worker deletes a job row when it completes
(`node_modules/.pnpm/graphile-worker@0.16.6_typescript@7.0.2/node_modules/graphile-worker/dist/sql/completeJob.js:11`),
so this is short-lived in the normal case. A **permanently failed** job (attempts exhausted, `max_attempts: 3`
at `…/world-postgres/dist/queue.js:114`) is not deleted — its payload, and therefore possibly a message,
stays until someone removes it by hand.

### How the restart-recovery fix interacts

`packages/agent-kit/src/release-stale-workflow-locks.ts` runs at agent start and touches **only**
`graphile_worker._private_jobs` / `_private_job_queues`, and only through graphile's own supported call
`graphile_worker.force_unlock_workers(...)` (`:133`), which sets `locked_at`/`locked_by` to NULL and
nothing else (`:15-19`). It never touches the `workflow` schema and it never deletes a row. Its
correctness argument (`:21-44`) rests on three facts — one live process per workflow database, a fresh
random worker id per process, and this code running before the HTTP port opens — none of which a prune
would disturb.

The interaction runs the other way, and it is a constraint on the prune, not on the fix:

- The unlock makes a stale job **runnable again at once** (`:17-19`: "`attempts` stays as the dead worker
  left it, `run_at` is unchanged, so the job is runnable at once"). A prune that had deleted that job's
  run between the crash and the restart converts a recoverable turn into a job that fails against a
  missing run.
- Both read the same database through the same precedence (`workflowDatabaseUrl`, `:62-64`), so a prune
  should reuse that resolver rather than invent a second one.
- **A prune must therefore never delete a run that still has a `graphile_worker` job referencing it**,
  whether queued, locked or permanently failed.

---

## The verdict

**UNKNOWN UNTIL MEASURED — and measuring it against 0.32 is not worth the cost.**

What reading *does* settle:

- Hooks and waits need no prune of ours; the package already deletes them at the terminal event
  (`storage.js:774-785`), and on this installation `token_retention_until` is always NULL so none are
  retained past it.
- `expired_at` is dead and must not appear in any predicate (`schema.js:69`, no writer anywhere).
- A prune must never touch a **non-terminal** run or anything belonging to one: it is re-enqueued on
  every restart (`recovery.js:12-40`) and its session history lives in its own steps and stream
  (`create-session-step.js:1`, `durable-session-store.js:1`).

What reading **cannot** settle, and why it is the whole question: on 0.32 every turn is a **separate
child run** (`$eve.type='turn'`, `$eve.parent=<session id>`). A closed turn run sits under a session run
that may stay open for thirty days. Whether that still-open session ever reads back its completed
children's rows — their events, steps or stream chunks — is not decidable from the compiled, minified
0.32 dist with the confidence this decision needs, and there are no foreign keys to catch the mistake.
Getting it wrong does not raise an error at prune time; it surfaces days later as a conversation that
answers as though it had amnesia, or an approval press that errors.

### The candidate predicate, and the rows it must never touch

Recorded so the measurement has something concrete to falsify. **This is not an approved predicate and
no slice should implement it before the measurement below passes.**

Candidate — delete only rows belonging to a run that is terminal, is a *turn* under a session that is
itself terminal, finished longer ago than a stated grace period, and is not referenced by any queue job:

```
workflow_runs r
  WHERE r.status IN ('completed','failed','cancelled')
    AND r.completed_at < now() - <grace>
    AND ( r.attributes->>'$eve.type' <> 'turn'
          OR EXISTS (SELECT 1 FROM workflow.workflow_runs p
                      WHERE p.id = r.attributes->>'$eve.parent'
                        AND p.status IN ('completed','failed','cancelled')) )
    AND NOT EXISTS (<any graphile_worker job whose decoded payload names r.id>)
```

then, in one transaction, the run's `workflow_events`, `workflow_steps`, `workflow_stream_chunks` and
finally the `workflow_runs` row.

**Never touch, under any predicate:**

1. Any run with `status IN ('pending','running')`, or anything keyed to it.
2. Any row belonging to a run whose `attributes->>'$eve.parent'` or `'$eve.root'` names a non-terminal
   run — including a *rotated/retired* session, which is non-terminal until its 30-day timer fires.
3. Any `workflow_hooks` row. The package owns that table's lifetime; a hook that still exists after its
   run went terminal exists on purpose.
4. Any `workflow_waits` row. Same reason, and a `resume_at` in the future is a timer somebody is
   standing on.
5. `workflow_drizzle.workflow_migrations` — empty by design, and the box's schema source of truth
   (`sql/001-eve-workflow.sql:50-55`).
6. Anything in `graphile_worker`. The restart-recovery path owns that schema and only ever unlocks.

### The measurement that would settle it

A hand-run probe against a **disposable** database — never an installation's. It follows the shape of
the existing CI image probe (`services/keeper/tests/runtime-image.probe.py`), which already stands up a
throwaway Postgres, applies `sql/001-eve-workflow.sql`, and drives real turns through a real runtime.

1. Stand up a disposable Postgres 16 and apply `services/chief-of-staff/sql/001-eve-workflow.sql`
   (probe lines `55-72` do exactly this).
2. Start a role runtime against it with `WORKFLOW_POSTGRES_URL` pointing at that database.
3. Drive **three** turns on one session through eve's own client (probe `:70`), the third of which parks
   an approval card. Wait for quiet using the probe's own definition — no running step and no locked job,
   twice in a row (`runtime-image.probe.py:25-34`).
4. Record the run graph: `SELECT id, name, status, completed_at, attributes FROM workflow.workflow_runs`.
   Confirm one `workflowEntry` run (`pending`/`running`), one `sessionTimeoutWorkflow` run, and one
   `turnWorkflow` run per completed turn.
5. **The experiment.** Delete, in one transaction, the events, steps and stream chunks of the **first
   two completed `turnWorkflow` runs only**, then those two run rows. Touch nothing belonging to the
   `workflowEntry` run, nothing in `workflow_hooks`, nothing in `workflow_waits`, nothing in
   `graphile_worker`.
6. **Assertion A — memory.** Send a fourth message referring to something said in turn one. It must be
   answered from context, not from amnesia.
7. **Assertion B — the approval.** Press the parked approval card (`respond()` through the same
   continuation token). It must be accepted, not raise
   `Cannot deliver inputResponses …`.
8. **Assertion C — restart.** Restart the runtime against the same database. The session must be
   re-enqueued and still answer on its old token, rather than starting fresh.
9. **Assertion D — the discriminator.** Repeat steps 1–8 with the delete widened to include the *open*
   `workflowEntry` run's stream chunks. Assertions A and C **must fail** in that run. If they do not, the
   probe is not measuring what it claims and nothing it says about step 5 can be trusted.
10. Tear the database down. Record the outcome in this file rather than in a new one.

**A, B and C green with D red is the only result that turns this verdict into SAFE.** Anything else is
UNSAFE and the answer is to keep rule 5 aspirational.

---

## What changes at eve 0.57+, and why the measurement should wait

The framework is moving from 0.32 to 0.60.x (`docs/specs/2026-09-18-eve-upgrade-design.md`), and the
execution model is rewritten at 0.57.0. From the version-by-version reading in
`docs/research/2026-09-18-prelaunch/05-vercel-eve.md:47`:

> **Execution model rewritten**: every turn runs inside the session's own workflow (no child run per
> message). `continuation.rekey()` → `continuation.alias()`. Sessions started before 0.45 "are reported
> inactive and their channel starts a fresh session"; pending tool calls, approvals and subagents of
> imported sessions are abandoned; **no transparent rollback**

and the same release row in the upgrade spec (`docs/specs/2026-09-18-eve-upgrade-design.md:213`).

Four things follow, each of which invalidates work done against 0.32:

1. **The child-turn run disappears.** `$eve.type='turn'` rows stop being produced. The candidate
   predicate above is written entirely around a structure 0.57 deletes.
2. **`rekey` becomes `alias`.** The Telegram rotation's retirement token
   (`services/chief-of-staff/agent/channels/telegram.ts:413`) must be rewritten, and what a retired
   session's run looks like afterwards is unknown until it is.
3. **The upgrade is itself a total prune of live session state.** Every session restarts fresh at the
   moment of the bump, and pending approval cards die. The upgrade spec already plans for this
   ("approvals drained … a maintenance window at a quiet time", `:479-481`) and states the honest limit:
   rolling back the image digests "does not undo the fact that every session already restarted fresh"
   (`:486-488`).
4. **The world package moves in lockstep.** `@workflow/world-postgres` must move from beta.32 to
   whatever eve 0.60.x pairs with (the spec records beta.44 as the latest tag seen, and says the exact
   version must be read from the installed eve, `:224`). `sql/001-eve-workflow.sql` is regenerated at
   that point. Column names, and possibly tables, may differ.

The upgrade spec's own open questions already touch this and rest on the same wrong premise this finding
corrects (`:540-543`): *"Sessions here are documented elsewhere as one chat-day each (ADR-0016), which
should make this moot, but it is not verified."* **It is now verified, and it is not moot** — a session
is bounded by a 30-day default, not a day, so the "roughly three-week import window" that 0.57.0's
"sessions started before 0.45 are reported inactive" rule turns on can genuinely catch sessions on this
installation. That should be carried back into that document's item 2.

---

## What erasure does NOT reach today

*This paragraph is written to be quoted verbatim by the export-and-erase spec and by the console's erase
copy. It is the plain-words version ADR-0020's Consequences section asks for.*

> Erasing a person reaches the conversation record and every store Lares owns immediately. It does not
> reach the framework's own session bookkeeping. While a conversation is still open, the framework is
> holding its own copy of what was said — the messages, the tool calls and their results — in tables
> Lares does not write and does not read. Those rows are not covered by the twelve-month retention
> setting, and nothing deletes them today. A conversation counts as closed when the framework closes it,
> which can be up to thirty days after the last message, and on one door — private chats with the chief
> of staff — a day-boundary rotation retires the conversation daily but the underlying rows still wait
> out that thirty-day timer. Until then, an erase is incomplete, and the honest thing to tell the owner
> is which conversations are still open and roughly when they will close.

Two additions the console copy should carry alongside it:

- The opening sentence of every conversation is stored in the clear in the framework's run table
  (`attributes->>'$eve.title'`, up to 125 characters). It is the one piece of content an operator with
  database access can read without decoding anything.
- A message can also sit briefly in the job queue's payload (`graphile_worker`), and stays there
  indefinitely if that job failed permanently.

---

## Recommendation for ADR-0020's rule 5

Three changes, none of which requires reopening the ADR's decision — only its wording and its open
questions.

1. **Do not build a prune on eve 0.32.** No wave-3 or wave-4 slice should issue a `DELETE` against the
   `workflow` schema. The structure such a prune would key on (`$eve.type='turn'`, `$eve.parent`) is
   removed at 0.57.0, and the upgrade retires every live session anyway — which performs the first sweep
   for free and is the natural moment to start counting. The measurement above should be run against
   the **post-upgrade** package, once, and this file updated with its result.

2. **Amend rule 5's wording so it does not over-promise.** The current text — "kept only as long as eve
   needs them to run … pruned once a session is closed and past its operational need" — reads as though
   something prunes them. Nothing does. Suggested replacement, in the ADR's own register:

   > eve's own session and workflow rows are the framework's, not ours. We do not treat them as a
   > historical record and they are not subject to the conversation record's retention setting. The
   > framework already removes a conversation's addressing and its timers when that conversation ends;
   > the rows that hold what was said are not removed by anything today, and a prune for them is
   > deliberately deferred until after the framework upgrade, because the upgrade rewrites what a
   > session durably holds and retires every open session in the process. Until that prune exists, an
   > erase is complete for everything Lares owns and incomplete for what the framework is still holding
   > — and we say so rather than implying otherwise.

3. **Correct "one chat-day" wherever it appears, and add the number.** ADR-0016's consequence line ("an
   eve session is one chat-day") is not true of this engine: the framework's own bound is a 720-hour
   idle timeout, no role service overrides it, and the day boundary is a Lares rotation on one door of
   one role. Two other documents lean on the wrong version — the agent-definitions design
   (`docs/specs/2026-09-15-lares-agent-definitions-design.md:101`) and the upgrade spec's open question
   (`docs/specs/2026-09-18-eve-upgrade-design.md:540-543`). The number a reader needs is **thirty days**,
   and it is the number the erase copy, the retention setting's help text and the upgrade's
   drain-the-approvals step should all be written against.

A fourth, smaller item, offered rather than recommended: if the thirty-day default is longer than this
product wants a conversation's words to live in a place nothing prunes, the cheapest lever available
today is not a prune at all — it is `limits.sessionTimeoutMs` in a role's `agent.ts`, which is a
supported, one-line setting the framework already honours
(`…/eve/dist/src/execution/workflow-entry.js:1`). Shortening it closes sessions sooner, which makes rule
5's "once a session is closed" mean something on a human timescale. That is a product decision with a
visible cost — a conversation forgets sooner — and it belongs to the owner, not to this finding.

---

## How to re-check this note

Every claim above is a read, not a run; re-checking it is re-reading the same paths after a bump.

```bash
# The schema and its generator
sed -n '1,60p' services/chief-of-staff/sql/001-eve-workflow.sql
grep -n 'CREATE TABLE IF NOT EXISTS' services/chief-of-staff/sql/001-eve-workflow.sql

# What the world package deletes, and what it never deletes
cd services/chief-of-staff/node_modules/@workflow/world-postgres
grep -n '\.delete(Schema\.' dist/storage.js
grep -n 'getHookRetentionLimitMs\|hookRetentionEnded = or' dist/storage.js
grep -rn 'expiredAt' dist/          # declaration only — no writer

# What closes a session, and for how long it may stay open
cd ../../eve
cat dist/src/execution/session-timeout.js                     # 720h default
grep -rn 'sessionTimeoutMs' ../../../../services/*/agent/agent.ts   # expect: nothing

# What the door does when a session's rows are gone
node -e 'const s=require("fs").readFileSync("dist/src/channel/channel-address.js","utf8");
         console.log(s.slice(s.indexOf("dispatch=async")-200, s.indexOf("createSession((await")+120))'
```

After the framework bump, re-run `pnpm -C services/chief-of-staff run regen:eve-sql:check` first — if it
exits 1, the table inventory above is stale and this note must be re-derived before anything acts on it.

---

## Re-measured on eve 0.60.1

**Date:** 2026-09-19 · **eve:** 0.60.1 · **World:** `@workflow/world-postgres@5.0.0-beta.42` ·
**Measured by:** `packages/board-evals/scripts/session-rows-measure.mjs` (W2-s12), against a disposable
Postgres 16 via testcontainers — never an installation's database. Everything under this heading is
either **measured** (a real `eve build` + `eve start`, a real client, a real reset, read back with SQL
immediately after) or explicitly marked **read** (static source, not exercised live). Nothing above this
heading is edited; where 0.60.1 confirms a 0.32 finding unchanged, that is said explicitly rather than
repeated.

### (a) Turns no longer create runs — confirmed live

Across three turns on one session, `workflow_runs` held exactly **two rows, for the whole run**:

| `name` | `attributes->>'$eve.type'` | present after turn 1 | after turn 2 | after turn 3 | after reset |
|---|---|---|---|---|---|
| `workflow//eve//workflowEntry` | `session` | yes | yes | yes | yes (now terminal) |
| `workflow//eve//sessionTimeoutWorkflow` | *(none — this run carries no `$eve.type` attribute at all)* | yes | yes | yes | yes |

No row named `turnWorkflow` (or carrying `$eve.type='turn'`) ever appeared, confirming the plan's reading
of the dist: the constant `TURN_WORKFLOW_NAME` still exists in
`node_modules/eve/dist/src/execution/stable-workflow-names.js`, but nothing in the installed 0.60.1
`dist/` ever starts a run against it — it is dead code kept for the name registry, not a live workflow.
**One session run now absorbs every turn of that session for its entire life.** The 0.32 candidate
predicate, which pruned individual completed *turn* runs out from under a still-open *session* run, has
no target on 0.60.1: there is no shorter-lived unit inside a session to delete. The only unit a prune can
act on now is the session run itself, once **it** is terminal — which is coarser, but also removes the
0.32 finding's central unresolved question (whether a still-open parent reads back a completed child's
rows), because there is no longer a parent/child split *for turns*. That split still exists for genuine
**subagents** (`$eve.type='subagent'`, `buildSubagentRootAttributes`,
`node_modules/eve/dist/src/execution/eve-workflow-attributes.js`) — not exercised by this measurement (a
single-agent session, no subagent calls) — so the same "never delete under a live parent" rule from the
0.32 finding still applies there, just to a narrower case.

The run id format also changed: 0.60.1 stamps a fully-qualified `workflow//eve//<name>` (each stable
reference now carries the installed package name — `STABLE_ID_BASE`, `workflow-runtime.js`) where 0.32
recorded a bare name. Any predicate or dashboard that matched on the bare 0.32 names needs updating.

### (b) Rows and bytes added per turn, measured

| stage | events | steps | streamChunks | hooks | waits | eventSlots | runs | bytes (six core tables) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| baseline (build+start, no session) | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 180,224 (fixed schema overhead) |
| **+ session create & turn 1** | +18 | +3 | +9 | +3 | +1 | +2 | +2 | +253,952 (≈248 KB) |
| **+ turn 2** (plain reply) | +7 | +1 | +8 | +2 | 0 | 0 | 0 | +32,768 (≈32 KB) |
| **+ turn 3** (tool call, approval parked) | +7 | +1 | +8 | +2 | 0 | 0 | 0 | +106,496 (≈104 KB) |
| **+ reset** (`ClientSession#reset()`) | +19 | +3 | +1 | **−7** | **−1** | 0 | 0 | +8,192 (≈8 KB) |

Row-count growth per *ordinary* turn (turn 2, the cleanest steady-state sample — no session-creation
overhead, no tool call) is **+7 events, +1 step, +8 stream chunks, +2 hooks, 0 waits, 0 event slots**. A
turn that calls a tool and parks an approval (turn 3) adds the **same row counts** but roughly **3× the
bytes** of a plain turn — the extra bytes are the tool schema, the tool call arguments and the approval
metadata, not extra rows. `workflow_event_slots` (new on beta.42, one row per run, holding only a
`run_id`) is created once per run and does not grow with turns — it carries no user content.

**Caveat on the byte figures.** `pg_total_relation_size` is measured in 8 KB Postgres pages on a table
that starts essentially empty; the jumps above include page and index pre-allocation, not just the bytes
of what was written, and every message in this fixture was a few words. **Do not treat 32–104 KB/turn as
a content-proportional rate** — a real installation's turns (longer messages, real tool schemas, longer
model replies) will differ, and only row *counts* above are page-independent and safe to rely on as-is.

**A materially worse growth shape than 0.32, specific to hooks.** On 0.32 each turn was its own run, so a
turn's hooks were deleted as soon as *that turn's* run went terminal — hooks rarely accumulated. On
0.60.1, since all turns share one long-lived session run, **hooks accumulate for the entire life of the
session** (3 → 5 → 7 across three turns here) and are only cleared when the *session* itself finally goes
terminal. They are still bounded (proven below: all deleted at reset), but a long-lived session now
carries more open hook rows at any given moment than it would have on 0.32.

### Where the owner's words sit — column names, unchanged

Every content-bearing column named in the 0.32 inventory (`workflow_runs.input`/`input_cbor`,
`output`/`output_cbor`, `attributes->>'$eve.title'`; `workflow_steps.input_cbor`/`output_cbor`;
`workflow_events.payload`/`payload_cbor`; `workflow_hooks.metadata`/`metadata_cbor`/`resume_context`;
`workflow_stream_chunks.data`) is **still present, with the same name**, in the regenerated
`services/chief-of-staff/sql/001-eve-workflow.sql` for beta.42 — confirmed by reading that file directly
(`:99-189`), not just by the schema-diff check. The only schema addition is `workflow.workflow_event_slots
(run_id character varying NOT NULL)` — one column, no user content.

`$eve.title` still holds the opening message in the clear: after turn 1 the session run's
`attributes->>'$eve.title'` had **length 5** for the fixture's five-character opening message. The
truncation cap itself was not exercised (no message over 125 characters was sent in this measurement) —
that cap is a **read**, not a re-measurement: `EVE_SESSION_TITLE_MAX_CHARS=125` and `deriveSessionTitle`'s
`124` + ellipsis truncation are both still present, unchanged, in
`node_modules/eve/dist/src/execution/eve-workflow-attributes.js`.

### Hooks and waits at a genuine reset — proven live, not just read

The 0.32 finding that "the package prunes hooks and waits, and only on the run's terminal event" was a
read of `storage.js`. This measurement proves it live, on a real approval-parked session: at turn 3 the
session held **7 hooks and 1 wait**; calling `ClientSession#reset()` — the identical `{kind:'reset'}`
command a server-side `attachSession(id).reset()` dispatches
(`node_modules/eve/dist/src/execution/workflow-runtime.js`'s `dispatchWorkflowCommand`) — left **0 hooks
and 0 waits**, while `events`/`steps` **increased** (the terminal transition itself writes rows; reset
does not shrink a session's footprint, it freezes it after one final write). The single `workflow_waits`
row present throughout turns 1–3 is the session's own sleeping 30-day timeout timer (see below), not a
per-turn artifact — it is created once, at session start, and released once, at the session's terminal
event.

### `$eve.type` and `workflow_runs.name` values, measured

Observed across the whole run: `$eve.type` ∈ `{"session", (none)}`; `workflow_runs.name` ∈
`{"workflow//eve//workflowEntry", "workflow//eve//sessionTimeoutWorkflow"}`. `"turn"` never appeared, as
expected. `"subagent"` was not observed (no subagent was invoked by this measurement) — it is a **read**
from `buildSubagentRootAttributes` in `eve-workflow-attributes.js`, not a measured value.

### What `limits.sessionTimeoutMs` and `experimental.workflow.retention` actually delete on 0.60.1 — read, not measured (30 days is not practical to wait out)

**`sessionTimeoutMs` default is unchanged: 30 days.**
`DEFAULT_SESSION_TIMEOUT_MS = 2592e6` (2,592,000,000 ms) in
`node_modules/eve/dist/src/execution/session/timeout.js` — the same 720-hour value 0.32 used, just
relocated (0.32's `execution/session-timeout.js` no longer exists; the constant now lives under
`execution/session/timeout.js`). New on 0.60.1: passing `sessionTimeoutMs: false` disables the timeout
entirely (`sessionTimeoutDeadline`'s `e===!1?void 0:...` branch) — not used by any role service today (a
repo-wide grep for `sessionTimeoutMs` outside `node_modules` still returns nothing).

**What firing it does, traced through the source (not run — 30 days is impractical to wait for in a
measurement).** `startSessionTimeoutStep` starts the `sessionTimeoutWorkflow` companion run seen above
(`node_modules/eve/dist/src/execution/session/timeout-steps.js`); when its deadline elapses,
`signalSessionTimeoutStep` resumes the session's inbox with `{kind:'session-timeout'}`. The session's own
admission switch (`node_modules/eve/dist/src/execution/session/admission.js`) turns that into
`queue.enqueueControl('expired')`, and the main session loop
(`node_modules/eve/dist/src/execution/session/program.js`) treats `'expired'` in the **exact same
case-arm as `'reset'` and `'closed'`**: `return {kind:'terminal', outcome:{kind:'expired'}}`. Because a
30-day timeout, an explicit reset, and a channel closing all funnel through this one terminal path, the
hooks/waits deletion this measurement just proved live for `reset` applies identically to a timeout
firing — same code, same effect. This is a **read-backed inference**, not an independent live
measurement of the 30-day path itself.

**`experimental.workflow.retention` deletes nothing by default, and only "0" is implemented at all.**
`readRunRetention` (`node_modules/@workflow+world@5.0.0-beta.35/node_modules/@workflow/world/dist/attributes-validation.js`)
resolves a run's `$retention` attribute: the string `"0"` means `mode:'none'` (delete on finish); any
other well-formed integer is `unsupported` (logged, data kept); absence or `"default"` means "the World
decides," which for `@workflow/world-postgres` beta.42 never purges anything
(`node_modules/@workflow/world-postgres/dist/retention.js`'s `purgeRunUserDataIfZeroRetention` returns
immediately unless `mode==='none'`). **No role service in this repo sets `experimental.workflow.retention`
today** — `services/{chief-of-staff,travel,creative}/agent/agent.ts` set only `experimental.workflow.world`
— so this mechanism is inert on every current installation.

When retention **is** set to `"0"`, `purgeRunUserData` (`retention.js`) runs in one transaction on the
run's terminal transition (called from `storage.js` at both terminal-transition sites) and **nulls, but
does not delete**: `workflow_runs.{input,output,error}` and their `_cbor`/`Json` twins (stamping
`expired_at`), `workflow_steps.{input,output,error}` and twins, `workflow_events.eventData` and its twin,
`workflow_hooks.{metadata,resumeContext}` and twins (a hook outliving its run via token retention keeps
its row but loses its content), and `workflow_stream_chunks.chunkData` is blanked to an empty buffer
(not deleted — a reader closes a stream on its `eof` row, so removing chunks would make a finished stream
look unfinished). **Rows are never removed by this mechanism, only their content** — it is a scrubber, not
a row-count reducer, and it is opt-in per run at session-create time, not a retroactive sweep.

### The candidate prune predicate for 0.60.1 — NOT approved, NOT to be implemented in this wave

Recorded, as before, so a later measurement has something concrete to falsify.

Now that a turn is not a separate run, the only prunable unit is a **terminal session run** (and its
paired `sessionTimeoutWorkflow` companion, once that pairing's own safety is measured — see below):

```
workflow_runs r
  WHERE r.status IN ('completed','failed','cancelled')
    AND r.completed_at < now() - <grace>
    AND coalesce(r.attributes->>'$eve.type','session') <> 'subagent'
    AND NOT EXISTS (<any graphile_worker job whose decoded payload references r.id>)
```
then, in one transaction, that run's `workflow_events`, `workflow_steps`, `workflow_stream_chunks` and
`workflow_event_slots` row, and finally `workflow_runs` itself. `workflow_hooks` and `workflow_waits` need
no action from this predicate — the package already deletes every hook and wait belonging to a run the
instant that run turns terminal, and this measurement proved that live (7 hooks, 1 wait → 0 and 0, on
reset).

**Why this is safer in shape than the 0.32 candidate, and why it still cannot be built this wave:**

1. **No more turn/session split to get wrong.** The 0.32 predicate's central risk — deleting a completed
   child run out from under a still-open parent — no longer has a target, because ordinary turns no
   longer create runs. This is real progress, not just a rewording.
2. **The subagent split still exists and is unmeasured.** `$eve.type='subagent'` runs carry `$eve.parent`
   / `$eve.root` exactly the way 0.32's turns carried `$eve.parent`, and whether a still-open root session
   reads back a completed subagent's rows is exactly the same open question the 0.32 finding could not
   settle for turns — just narrower now. The predicate above excludes every subagent run outright rather
   than guess; loosening that exclusion needs its own measurement (drive a session that calls a subagent,
   let the subagent finish while the root stays open, delete the subagent's rows, confirm the root can
   still read whatever it kept of the subagent's result).
3. **The `sessionTimeoutWorkflow` companion's pairing with its session is unmeasured.** This run is
   supposed to self-cancel when its session ends before the deadline (`cancelSessionTimeoutStep`,
   `timeout-steps.js`) — so a terminal companion should never outlive a non-terminal session, or vice
   versa. This measurement reset the session but never inspected whether the companion row's own status
   updated in lockstep, nor exercised the deadline actually firing. A prune that deletes a terminal
   `sessionTimeoutWorkflow` row without confirming its paired session row is *also* terminal (and vice
   versa) risks orphaning one side of a pair whose relationship is asserted here, not measured.
4. **Never touch a `pending`/`running` run**, unchanged from the 0.32 rule.
5. **`graphile_worker` is still out of scope**, unchanged from the 0.32 rule — the restart-recovery path
   (`packages/agent-kit/src/release-stale-workflow-locks.ts`) owns it and only ever unlocks.

### What the owner has to decide

**Growth, stated in the owner's terms.** An ordinary reply-only turn adds about 7 event rows, 1 step row
and 8 stream-chunk rows to its session's run, and keeps doing so for as long as that session stays open —
which, unchanged from 0.32, can be up to **30 days of silence** by default, and indefinitely if the
session is quiet enough to never reach even that. A turn that uses a tool costs roughly the same number of
rows but noticeably more storage (tool schema and arguments). Nothing deletes any of this today —
`experimental.workflow.retention` is the only mechanism that removes payload content at all, no role
service turns it on, and even when it is on it only clears columns, it never removes a row.

**An illustrative rate, not a lab-grade one.** At a rough 30 turns/day for one continuously active
assistant conversation, using this measurement's own ordinary-turn figure (≈32 KB, dominated by
Postgres page overhead on a near-empty table — see the caveat above), that is on the order of **tens of
megabytes per month for one always-open session** — not an emergency, but not zero, and it never comes
back down while nothing prunes it. A real installation's exact rate depends on message length and how
often tools are called, neither of which this measurement's few-word fixture messages represent.

**The safe default is still: do nothing.** No slice in a later wave should delete from `workflow.*`
without first closing the two gaps this re-measurement leaves open (subagent-lifecycle safety;
session/`sessionTimeoutWorkflow` pairing safety). Until then:

- **Option A — do nothing (recommended for now).** Rows keep growing at the rate above; ADR-0020 rule 5's
  corrected wording (above, from the 0.32 section) already tells the owner and the console's erase copy
  the truth about this; nothing here changes that recommendation.
- **Option B — shorten `limits.sessionTimeoutMs`** on one or more roles so sessions close sooner (cost:
  the assistant "forgets" a quiet conversation sooner than 30 days). This does not delete anything by
  itself — it only makes sessions *eligible* sooner, once a prune exists.
- **Option C — commission the two follow-up measurements above**, then write the candidate predicate as a
  real, tested prune. This wave deliberately does not do that: "deleting from eve's own tables is an
  owner decision," per the slice that produced this section, and two safety questions remain open.
