# Does an approved call still hash to what the card showed?

Measured 2026-09-20 against eve 0.60.1, by `../scripts/approval-binding-proof.mjs`. Re-run it with

```sh
node packages/board-evals/scripts/approval-binding-proof.mjs
```

from the repository root with Docker running. One disposable `postgres:16-alpine`, one disposable
copy of this package, one eve process, ~23 s end to end (4.5 s build, 15 s eval, the rest the
container). No model credential: the fixture's model is `mockModel`.

## The question

`services/chief-of-staff/lib/approvals.ts`'s `assertApproval` refuses a gated tool call whose
`payloadFingerprint(toolName, input)` at execution differs from the one
`agent/hooks/approval-record.ts` recorded from eve's `input.requested` event. Until now both sides
were built by hand in every test. If they differ for real, the owner cannot send a mail.

## What was run

Six gated probe tools (`always()`), one hook on `input.requested`, and a scripted model that emits
one deliberately-shaped raw input each. eve's eval harness drives `session.send` → exactly one
`tool-approval` request → `session.respondAll("approve")` → execution. Both sides append the
fingerprint, the canonical string and the call id to one file; the table below is that file.

## Result — the payload binds. Every shape.

| case | shape | ask canonical | execute canonical | payload | card callId | callIdFrom(ctx) | ctx.callId |
| --- | --- | --- | --- | --- | --- | --- | --- |
| a | plain input, nothing for the schema to add or remove | `{"text":"alpha"}` | `{"text":"alpha"}` | equal | `mock-tool-call-1-0-1` | **undefined** | `mock-tool-call-1-0-1` |
| b | a `.default("normal")` the model did not supply | `{"mode":"normal","text":"beta"}` | `{"mode":"normal","text":"beta"}` | equal | `mock-tool-call-3-1-1` | **undefined** | `mock-tool-call-3-1-1` |
| c | an optional key the model omitted | `{"text":"gamma"}` | `{"text":"gamma"}` | equal | `mock-tool-call-5-2-1` | **undefined** | `mock-tool-call-5-2-1` |
| d | an optional+nullable key the model sent as `null` | `{"cc":null,"text":"delta"}` | `{"cc":null,"text":"delta"}` | equal | `mock-tool-call-7-3-1` | **undefined** | `mock-tool-call-7-3-1` |
| e | a nested object and an array, keys emitted out of alphabetical order | `{"nested":{"inner":{"k":"v"},"list":[3,1,2]},"text":"epsilon"}` | `{"nested":{"inner":{"k":"v"},"list":[3,1,2]},"text":"epsilon"}` | equal | `mock-tool-call-9-4-1` | **undefined** | `mock-tool-call-9-4-1` |
| f | an unknown extra key the schema strips | `{"text":"zeta"}` | `{"text":"zeta"}` | equal | `mock-tool-call-11-5-1` | **undefined** | `mock-tool-call-11-5-1` |

**The card is raised on the SCHEMA-PARSED input, not the model's raw arguments.** Case b's card
already carries `mode: "normal"`, which the model never sent; case f's card has already lost the
key the schema strips. So the parse that the open risk feared happens BEFORE the recorded hash, on
both sides, and the durable round-trip between them changes nothing — `{"cc":null,…}` survives as
`null`, and `canonical`'s key sort makes case e's ordering irrelevant. No normalisation is needed
anywhere: not in `payloadFingerprint`, not in the hook, not in `assertApprovedCall`.

## But the check never runs — `callIdFrom(ctx)` is always `undefined`

`callIdFrom` (`packages/agent-kit/src/approval-ledger.ts`) reads `ctx.toolCallId`. eve 0.60.1's
**authored** `ToolContext` has no such field; it is `ctx.callId`
(`node_modules/eve/dist/src/tools/definition.d.ts`, `ToolContext`: "Id of the current tool call —
the same `callId` carried by the call's stream events and its `ApprovalContext`"). `toolCallId` is
the AI SDK's name for it, which eve renames on the way in
(`dist/src/harness/tools.js`: `callId:i.toolCallId`).

Measured `Object.keys(ctx)` inside a real `execute`:

```
["abortSignal","callId","getSandbox","getSkill","getToken","requireAuth","session","toolName"]
```

and `ctx.callId` equals the card's `callId` exactly, in all six cases. `assertApprovedCall`'s first
rule is "no call id ⇒ PASS", so today every gated tool takes that branch: the ledger is never read,
expiry is never enforced, a settled card is never refused, `markUsed` never counts. The control is
already observe-only, by accident.

The smallest fix is one line in `callIdFrom`: read `ctx.callId` (keeping `toolCallId` as a fallback
costs nothing and keeps the hook-and-test callers working). It does NOT belong in the hook or in
`assertApprovedCall` — both already receive the right value once `callIdFrom` returns it.

## Noticed on the way

`eve invoke <prompt>` followed by `eve invoke --resume approve` — the shape `scripts/restart-proof.mjs`
uses — answered HTTP 409 `session_not_active` ("The session is no longer active.",
`dist/src/eve-channel/index.js`) on roughly one resume in five under load. Reproduced with a fresh
app per case AND a fresh database per case, so it is neither state accumulating in one app nor in
one database. Not investigated further; this proof uses the eval harness, which runs the same
runtime and the same durable pending-input path in one process and did not flake.

## Addendum — after the fix, same day

`callIdFrom` now reads `ctx.callId` first (`packages/agent-kit/src/approval-ledger.ts`). The same
script, re-run against the fixed kit: **PAYLOAD: PASS** (6/6 equal) and **CALL ID: PASS**
(`callIdFrom(ctx)` equals the card's call id for all six shapes). The check therefore runs for the
first time with this change: the 24-hour expiry, the refusal of a cancelled or ignored card, the
payload binding and the repeat-use counter all start to act on real calls.
