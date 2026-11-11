# Is a model call outside the scripted model really refused? (eve 1.0.0-rc.9)

Measured 2026-11-11 against eve 1.0.0-rc.9, by `../scripts/model-guard-proof.mjs`. Re-run it with

```sh
node packages/board-evals/scripts/model-guard-proof.mjs
```

Docker running (for the definition database). One eve process, a scripted model, no credential,
an allowlisted environment with no provider configured.

## The question

Every agent this package builds uses a scripted model. That alone does not promise that no
provider is reached: eve keeps only a model's id between steps and, picking a conversation up
without the provider object the agent selected (a restart, a between-turns compaction), resolves
that id again through the AI SDK's default provider, which reaches a hosted gateway.
`tests/model-guard.test.ts` pins that the guard against that is installed. This run shows a model
call outside the scripted model being refused in a live runtime.

## What was run

One turn served by the scripted model (the control). Then the conversation's history was compacted
between turns, which makes a model call of its own. Then one more turn.

## Result

| Step | Observed |
| --- | --- |
| Control turn | `completed`, reply `DONE:hello there`, one scripted-model call |
| Compaction | Refused. `model.settled` and `context.settled` both carry outcome `failed` with `COMPACTION_FAILED: A fresh trusted model invocation is required`; the delivery ended `failed` (`compaction-failed`). The scripted model was called **0** times for it |
| Turn after | `completed`, reply `DONE:still here`, one scripted-model call |

`MODEL GUARD PROOF: PASS`. The refusal here came from the kit's own check at the model boundary
(`@lares/agent-kit/definition-model` refuses a compaction outright), which sits in front of the
refusing default provider: the call never got as far as asking any provider. The conversation was
unharmed.

## What this run does not show

The refusing default provider itself answering a request. In this fixture the kit's check refuses
first, so the default provider is never asked. That it refuses when asked is pinned by
`tests/model-guard.test.ts` here and by the kit's own tests.
