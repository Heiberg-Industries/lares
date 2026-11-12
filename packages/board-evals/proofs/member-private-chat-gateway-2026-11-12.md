# Model calls through the gateway, with the right scope (eve 1.0.0-rc.9)

Measured 2026-11-12 against eve 1.0.0-rc.9 with the repository's framework patch, by
`../scripts/member-private-chat-proof.mjs` (gateway lane), on branch `eve-1.0` at `6fc0095c` plus
this change to the proof. The previous record, `member-private-chat-2026-11-11.md`, marked this lane
"not ported". Re-run it with

```sh
TMPDIR=<a real path with no symlink in it> PRIVATE_CHAT_PROOF_ROLE=chief-of-staff \
  PRIVATE_CHAT_PROOF_GATEWAY_LANE=anthropic \
  pnpm -C packages/board-evals exec tsx scripts/member-private-chat-proof.mjs
```

(or `PRIVATE_CHAT_PROOF_GATEWAY_LANE=openai-compatible`). Docker running (one disposable pgvector
database). The real chief-of-staff role is copied, built with `eve build` and started with
`eve start`; every request goes through the console's real `forwardChat`. The model provider is a
local HTTP fixture that speaks the Anthropic or the OpenAI-compatible wire format and records every
request; the role's real gateway provider (`createGatewayProvider`) sends to it. No credential,
no live service, no money.

## Results

| Lane | Result |
| --- | --- |
| Gateway, Anthropic wire | **PASS** (21 model calls, 21 scope records, 2 mail-provider calls) |
| Gateway, OpenAI-compatible wire | **PASS** (21 model calls, 2 mail-provider calls) |

On top of the default lane (which still passes inside each run), the gateway lane asserts:

- every model call went through the gateway: right path, `POST`, `Accept-Encoding: identity`, the
  gateway key, the definition's model alias, no prompt-cache marker in the body; and the number of
  scope records equals the number of HTTP requests;
- every call's recorded scope names the alias, a human initiator, a human or resolver current
  purpose, and coordinates the stream itself emitted (see below);
- a fresh turn after a cold restart has a later turn sequence and a real turn id;
- a manual compaction makes no HTTP request and fails for the role's own refusal (the authored hook);
- a transient error, a transient stream error, an empty reply and an unsupported provider tool each
  make exactly one HTTP request, visibly fail, and (for the last three) go through eve's own
  recovery path, whose retry the single-use model claim refuses;
- an automatic compaction is refused by the awaited hook, makes no HTTP request and stops the turn.

## What changed in the proof, and which checks changed

- **The scope's coordinates are checked against the v27 stream.** eve 0.60.1 emitted a
  `step.started` fact with turn id, sequence and step index, and the check was "the scope's
  coordinates are one of those". eve 1.0 emits no such fact; the kit now builds the same record from
  eve's session view (`modelStepCoordinates`): the turn id, the `n` of `turn_<n>` as sequence, and
  `position(view)`, the stream position of the next stored line, as step index. Measured on this
  stream, that line is exactly the one carrying the call's `model.requested` fact. So the proof now
  records, as observed, a `model.requested` fact *at* stored position `p`, scoped to a turn whose
  `turn.started` the same session's stream emitted, and the unchanged assertion requires every scope
  to equal one of those. This is as exact as before: same session, same turn, same sequence, same
  position.
- **Compaction is `context.started` on eve 1.0** (was `compaction.requested`). The proof's copy of
  the role hook is instrumented at the new line (a `clear` still passes untouched), and the receipt
  check requires `context.started` of a kind other than `clear`. The fixture's own unit test
  (`gateway-invocation-fixture.test.mjs`) is moved to the new hook shape and also checks that
  `clear` is let through without a receipt.
- **A refused manual compaction no longer ends a turn**, because it runs between turns: its control
  delivery settles instead. The read now ends on that `delivery.settled`, and the proof additionally
  asserts its outcome is `failed`.
- **The empty reply stops on its token limit.** eve 1.0 accepts an empty reply that ends normally
  on a top-level session (`assertUsableResponse` with `allowEmptyStop`) and delivers it as an empty
  completed turn; only an empty reply that did not end normally reaches its "reissue once" recovery.
  The fixture's empty reply now ends with `max_tokens` (`length` on the OpenAI wire), so the three
  assertions on it (one HTTP request, visible failure, eve's recovery log line) are unchanged.

## Not proven here

- The approve and deny resumes (`PRIVATE_CHAT_PROOF_SEND=1`) and the budget lane: see the lane 3
  section of this pull request, recorded below when run.
- A live gateway or provider: the fixture is what we believe the wire looks like.
- Durable crash replay of a model call (the script's own line says so: "no durable crash-replay
  claim").
