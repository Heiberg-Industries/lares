> Editorial note: package identifiers in these historical excerpts were normalized during the Lares naming migration. This is not evidence of a new run; original output remains in the historical commit.

# Does the card actually appear? `asksAfterUntrustedText()` against the real framework

Measured 2026-09-20 against eve 0.60.1, by `../scripts/tainted-approval-proof.mjs`. Re-run it with

```sh
node packages/board-evals/scripts/tainted-approval-proof.mjs
```

from the repository root with Docker running. One disposable `postgres:16-alpine`, one disposable
copy of this package, one eve process, **~23 s end to end** (4 s build, 15 s eval, the rest the
container). No model credential: the fixture's model is `mockModel`. Exit code 0 is the verdict;
every question also prints its own line.

## The question

`packages/agent-kit/src/tainted-approval.ts` makes a fetch ask the owner first when the turn has
already read somebody else's words. It decides by looking the turn up in `origin-taint.ts`'s
per-turn map, under the key `turnKeyFrom(ctx)` builds from eve's `ApprovalContext`. The taint is
written under two *other* keys:

| who writes it | where the turn id comes from |
| --- | --- |
| a reading tool's own `execute` (`services/chief-of-staff/catalogue/read_url.ts`) | `turnKeyFrom(ctx)` — `ctx.session.turn.id` on eve's `ToolContext` |
| the hook (`services/chief-of-staff/agent/hooks/origin-taint.ts`) | `turnKeyFrom(ctx, event.data.turnId)` — the `action.result` event's own turn id |
| the policy, reading | `turnKeyFrom(ctx)` on eve's `ApprovalContext` |

All three were established by reading eve's `dist/`, never observed. **The failure mode is silent
in the dangerous direction**: if the policy's key differs from the writers', `currentTaint` answers
`undefined`, the policy returns `"not-applicable"`, no card is ever raised, and the tool behaves
exactly as it did before the control existed — nothing logs, nothing throws, every unit test still
passes, because they all build their contexts by hand. This is the class of mistake that
`callIdFrom` shipped with (it read `ctx.toolCallId` where eve passes `ctx.callId`).

## What was run

Four sends in **one** session, against a real runtime:

| turn | what ran | why |
| --- | --- | --- |
| t1 | `gated_probe` | the negative: nothing tainting ran |
| t2 | `taint_reader` → `gated_probe` | the positive: taint written **both ways**, then the gated call |
| t3 | `gated_probe` | isolation: the next turn of the same session, after t2 tainted |
| t4 | `taint_reader` → `gated_plain` | the same as t2 against the bare, unwrapped production expression |

`taint_reader` stands for `read_url` on the read that brings the outside words in: it taints from
inside its own `execute` via `turnKeyFrom(ctx)`, *and* the copied hook taints the same turn from the
`action.result` event. `gated_probe`'s policy wraps the real `asksAfterUntrustedText()` only to
record the key it looks up — the wrapper calls the real `turnKeyFrom(ctx)` (the policy's own first
line) and then the real policy, returning its answer untouched. `gated_plain` carries
`approval: asksAfterUntrustedText()` written exactly as `catalogue/read_url.ts` writes it, so the
wrapper cannot be what produced the card. Every probe imports the **real** `asksAfterUntrustedText`,
`taintTurn`, `turnKeyFrom` and `clearTurn` from `@lares/agent-kit`; nothing is re-implemented.

eve's eval harness drives `session.send` → `inputRequests` → `session.respondAll("approve")`, the
way `evals/board.eval.ts` already drives a real approval. Every observation is one JSON line in one
file, carrying `process.pid` and the send's unique message, and the tables below are that file.

## Result — the control works. All three keys agree.

| # | question | verdict | evidence |
| --- | --- | --- | --- |
| 1 | the policy finds a taint written by both writers in the same turn | PASS | execute `…/turn_1` · hook `…/turn_1` · policy `…/turn_1` · 1 card · verdict `"user-approval"` |
| 1b | the bare `approval: asksAfterUntrustedText()` expression parks too | PASS | 1 card · taint under `…/turn_4` from both writers · ran after approval |
| 2 | an untainted turn raises NO card and still runs | PASS | 0 cards · verdict `"not-applicable"` · ran |
| 3 | turn N's taint does not raise a card in turn N+1 of the same session | PASS | 0 cards · t2 tainted `…/turn_1`, t3 looked up `…/turn_3` · 1 turn-boundary clear fired for t2's turn |
| 4 | the approved call executes, and the turn id it sees there | PASS | park turn `turn_1` (seq 1) → execute turn `turn_2` (seq 2) — a **brand-new turn id** |
| 4b | the policy is consulted again on resume, in the new turn, and does not park a second time | PASS | `turn_2` → `"not-applicable"` |
| 5 | hook, policy and execute share one process | PASS | pids `[93334]` |

The three keys side by side, per turn (session id `wrun_01M2Y884FH2CWFZYKAVM3GF1JK` elided to `…`):

| turn | what ran | execute-side taint key | hook-side taint key | policy lookup key | verdict | card |
| --- | --- | --- | --- | --- | --- | --- |
| t1 | `gated_probe` | — | — | `…/turn_0` | `"not-applicable"` | 0 |
| t2 | `taint_reader` → `gated_probe` | `…/turn_1` | `…/turn_1` | `…/turn_1` | `"user-approval"` | 1 |
| t3 | `gated_probe` | — | — | `…/turn_3` | `"not-applicable"` | 0 |
| t4 | `taint_reader` → `gated_plain` | `…/turn_4` | `…/turn_4` | _unwrapped_ | _unwrapped_ | 1 |

The session id is eve's workflow run id (`wrun_…`); turn ids are `turn_0`, `turn_1`, … in order, and
they are only unique **within** a session — which is why `slotOf` prefixes the session id's length
rather than joining the two with a separator.

The two contexts, measured inside a real run:

```
ToolContext      ["abortSignal","callId","getSandbox","getSkill","getToken","requireAuth","session","toolName"]
ApprovalContext  ["abortSignal","approvedTools","callId","getSandbox","getSkill","session","toolInput","toolName"]
```

Both carry `session`, so `turnKeyFrom` reaches `session.id` and `session.turn.id` on either — the
one assumption the whole control rests on, now observed rather than read off a `.d.ts`.

## The park really does end the turn — confirmed, and it matters

`origin-taint.ts`'s `TAINT_MAX_AGE_MS` docblock and `tainted-approval.ts`'s header both claim the
continuation after a park "arrives as a BRAND-NEW turn id". **Confirmed**: the policy was consulted
in `turn_1` (sequence 1), and the approved `execute` ran in `turn_2` (sequence 2). One
turn-boundary event fired for `turn_1` between the two, so the kit's map no longer holds the entry
either.

Two consequences, both already reflected in the code and neither a defect:

- **The taint is not readable inside an approved tool's `execute`.** By the time the owner has
  tapped, the turn that read the mail is over. `asksAfterUntrustedText` being an approval *policy*
  and not a check inside `execute` is therefore not a stylistic choice — it is the only place the
  question can still be asked.
- **eve consults the policy a second time on resume**, in the new turn, where there is no taint. It
  answered `"not-applicable"`, so the approved call runs instead of parking again. Had the key been
  unreadable there, the fail-closed branch would have returned `"user-approval"` a second time; this
  run shows it does not.

That second consult is also why this proof attributes every line by the send's unique message and
never by position in the log: t2's resume consult is emitted *after* t2's own record, so a
positional reading files it under t3.

## Isolation, and what actually produces it

t3 raised no card for two independent reasons, and the run separates them: the policy looked up
`…/turn_3` while the taint was written under `…/turn_1` (different key), **and** one turn-boundary
clear had already dropped `turn_1`'s entry. Either alone is sufficient. Nothing here tests isolation
*across sessions* — the map key is length-prefixed and `tests/origin-taint.test.ts` pins that
property directly, and a second concurrent session is not something this harness drives.

## Process locality — measured, with the caveat stated

Every line in this run carries pid `93334`: the hook, both writers and the policy ran in **one**
process, so the module-level `Map` in `origin-taint.ts` was the same map for all of them. That is
what the control needs, and on this runtime it holds.

**This proves the eval harness, not every deployment.** eve's durable runtime can resume a session
in a fresh process (a restart, a cold start, the `eve invoke --resume` path), and a taint written
before such a boundary is simply gone — the map is deliberately per-process and never persisted
(the spec's own rule). The consequence is bounded and in the safe direction only by accident: a
lost taint means **no card**, which is the silent direction. What this run establishes is that
within one turn — which is the only span the taint is ever read over, since the park ends the turn
anyway — the writers and the reader are the same process. A turn does not straddle a process
boundary in the middle, so there is no window in which a read tool's taint could be written in one
process and the policy consulted in another for that same turn.

## Noticed on the way, not touched

- `catalogue/read_url.ts` taints from inside `execute`. On a call that was *approved*, that
  `execute` runs in the continuation turn — so an approved tainted fetch stamps the **continuation**
  turn, not the turn that asked. A second fetch in that continuation turn therefore asks again,
  which is the wanted behaviour, but it is an accident of where the code sits rather than something
  stated anywhere.
- `gated_plain` records nothing by design (it is the unwrapped production expression), so its
  evidence is the card count and the execution only. That is sufficient for what it is there to
  rule out.
- This proof does not exercise `read_url`'s `assertApproval` re-check, box 086, or the
  Notion/Google branches; the payload and call-id binding those depend on is proven separately by
  `approval-binding-proof.mjs` and `approval-binding-2026-09-20.md`.
