# Does the model guard refuse a bare model id in a live server? (eve 1.0.0-rc.9)

Measured 2026-11-11 against eve 1.0.0-rc.9, by `../scripts/model-guard-proof.mjs`. Re-run it with

```sh
node packages/board-evals/scripts/model-guard-proof.mjs
```

Docker running (for the definition database). Two disposable copies of the fixture, each built and
started with `eve start`, one at a time; a scripted model; no credential.

## The question

Handed a model-id string, the AI SDK resolves it through `globalThis.AI_SDK_DEFAULT_PROVIDER`
(`ai` 7.0.169, `resolveLanguageModel`), and without one through a hosted gateway. eve keeps only a
model's id between steps and can resolve it that way when it picks a conversation up cold. The
guard (`agent/instrumentation/model-guard.ts` → `installRefusingDefaultProvider()`) replaces that
default with one that refuses every request, and locks it. `tests/model-guard.test.ts` shows this
in a test process. This run shows it in the server eve actually starts.

## What was run and asserted

| Copy | What the probe tool did | Observed |
| --- | --- | --- |
| A: the fixture as committed | Read the default provider, then called `generateText` with the bare id `anthropic/claude-guard-proof` | Default provider installed **and locked**. The call **threw the guard's own refusal**: "A model call was made outside the engine's gateway and is refused. Every model call must go through the gateway." The turn completed with the scripted reply `DONE:guard probe`, and the scripted model, a provider object, was called twice |
| B: the same, with `agent/instrumentation/model-guard.ts` deleted | Read the default provider only, and made **no** call | **No** default provider installed |

`MODEL GUARD PROOF: PASS`. All of the above is asserted. B is what ties A's refusal to the guard
file. B never makes the call, because without the guard it would be addressed to a hosted gateway.

## What this run does not show

That eve itself ever takes the bare-id path. The one such path known here, a between-turns
compaction, is refused by the kit's own check (`@lares/agent-kit/definition-model`) before any
provider is asked. This run shows what happens if any path reaches the default provider.
