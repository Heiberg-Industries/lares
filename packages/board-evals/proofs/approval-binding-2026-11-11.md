# Does an approved call still hash to what the card showed? (eve 1.0.0-rc.9)

Measured 2026-11-11 against eve 1.0.0-rc.9, by `../scripts/approval-binding-proof.mjs`. The same
proof on eve 0.60.1 is `approval-binding-2026-09-20.md`. Re-run it with

```sh
node packages/board-evals/scripts/approval-binding-proof.mjs
```

from the repository root with Docker running. One disposable `pgvector/pgvector:pg16`, one
disposable copy of this package, one eve process. No model credential: the fixture's model is
`mockModel`, and the copy carries the model guard (`agent/instrumentation/model-guard.ts`).

## The question

A gated tool call is refused at execution when `payloadFingerprint(toolName, input)` differs from
the one the approval hook recorded when the card opened. If the two sides differ for real, the
owner cannot approve anything.

## What changed in the method

eve 1.0 no longer puts the tool name and input on the event that opens the card. The ask side now
reads the card with `openedApproval` from `@lares/agent-kit/approval-record-hook`, the kit's own
reader that the roles' approval-record hook uses on `interaction.opened` (it takes the call from
the session view). The execute side is unchanged. The eval drives `session.send` → exactly one
open interaction of kind `approval` → `session.respondAll("approve")` → execution.

## Result — the payload binds, and the call id matches. Every shape.

| case | shape | ask canonical | execute canonical | payload | card callId | callIdFrom(ctx) | ctx.callId |
| --- | --- | --- | --- | --- | --- | --- | --- |
| a | plain input, nothing for the schema to add or remove | `{"text":"alpha"}` | `{"text":"alpha"}` | equal | `mock-tool-call-1-0-1-1` | `mock-tool-call-1-0-1-1` | `mock-tool-call-1-0-1-1` |
| b | a `.default("normal")` the model did not supply | `{"mode":"normal","text":"beta"}` | `{"mode":"normal","text":"beta"}` | equal | `mock-tool-call-2-1-1-2` | `mock-tool-call-2-1-1-2` | `mock-tool-call-2-1-1-2` |
| c | an optional key the model omitted | `{"text":"gamma"}` | `{"text":"gamma"}` | equal | `mock-tool-call-3-2-1-3` | `mock-tool-call-3-2-1-3` | `mock-tool-call-3-2-1-3` |
| d | an optional+nullable key the model sent as `null` | `{"cc":null,"text":"delta"}` | `{"cc":null,"text":"delta"}` | equal | `mock-tool-call-4-3-1-4` | `mock-tool-call-4-3-1-4` | `mock-tool-call-4-3-1-4` |
| e | a nested object and an array, keys emitted out of alphabetical order | `{"nested":{"inner":{"k":"v"},"list":[3,1,2]},"text":"epsilon"}` | `{"nested":{"inner":{"k":"v"},"list":[3,1,2]},"text":"epsilon"}` | equal | `mock-tool-call-5-4-1-5` | `mock-tool-call-5-4-1-5` | `mock-tool-call-5-4-1-5` |
| f | an unknown extra key the schema strips | `{"text":"zeta"}` | `{"text":"zeta"}` | equal | `mock-tool-call-6-5-1-6` | `mock-tool-call-6-5-1-6` | `mock-tool-call-6-5-1-6` |

`PAYLOAD: PASS` — all 6 shapes hash identically on both sides.
`CALL ID: PASS` — `callIdFrom(ctx)` equals the card's call id for all 6 shapes.

The execute-time `ToolContext` carries `callId` (keys seen: `abortSignal`, `callId`, `channel`,
`getSandbox`, `getToken`, `messages`, `requireAuth`, `session`, `to`, `toolName`); there is no
`toolCallId`. The mock model's call ids have a fourth segment on this version
(`mock-tool-call-1-0-1-1`).
