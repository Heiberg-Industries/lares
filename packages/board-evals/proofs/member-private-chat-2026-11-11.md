# Members' private conversations through the console (eve 1.0.0-rc.9)

Measured 2026-11-11 against eve 1.0.0-rc.9, by `../scripts/member-private-chat-proof.mjs`. Re-run a
lane with

```sh
PRIVATE_CHAT_PROOF_ROLE=chief-of-staff pnpm -C packages/board-evals exec tsx scripts/member-private-chat-proof.mjs
```

adding the lane's variable below. Docker running (one disposable pgvector database). Each run copies
the actual role source, builds it with `eve build`, starts it with `eve start`, and sends every
request through the console's real `forwardChat`. Only the model (scripted) and the mail provider
(synthetic) are fake. `TMPDIR` must be a real path with no symlink in it.

## What changed in the proof for eve 1.0

- The stream is read in stream version 27: each stored line is `{at, facts}` or `{progress}`,
  `{$eve}` records are transport only, and `startIndex` counts stored lines. Every catch-up read
  also checks that its own line count matches the server's `x-eve-stream-tail-index`. A read ends
  when the turn settles (any outcome; `failed` fails the proof), pauses for a person, or the
  session ends. The console proxy now refuses the old `streamControlVersion` parameter.
- Cards are answered with `answers: [{ interactionId, optionId }]`; a card reaching the member is
  `interaction.opened`.
- The model-visible tool list is still asserted exactly. On eve 1.0 it is shorter: `eve__skill`
  replaces `load_skill`, and `ask_question` and `todo` are no longer offered. This matches the
  console entry in `services/chief-of-staff/tests/eve-tools-offered.test.ts` (only `eve__skill`).
- `turn.started` carries only `turnId` and `follows` (eve `TurnStartedData`). The vault lane still
  ties the broker's `turn.open` and `vault.read` to the stream's turn id; for the turn sequence,
  which the stream no longer carries, it asserts that `turn.open` and `vault.read` agree and that
  it is a non-negative integer.

## Results

| Lane | Variables | Result |
| --- | --- | --- |
| Default, chief-of-staff | `PRIVATE_CHAT_PROOF_ROLE=chief-of-staff` | **PASS** (13 model calls, 2 provider calls) |
| Default, creative | `PRIVATE_CHAT_PROOF_ROLE=creative` | **PASS** (13 model calls) |
| Tracks cards (Keeper's real broker, real Git Vault) | `+ PRIVATE_CHAT_PROOF_TRACKS=1` | **PASS** (30 model calls) |
| Vault read (recording broker fixture) | `+ PRIVATE_CHAT_PROOF_VAULT=1` | **PASS** (16 model calls) |
| Personal mail send card | `+ PRIVATE_CHAT_PROOF_SEND=1` | **FAIL**, see below |
| Gateway lane, budget | `PRIVATE_CHAT_PROOF_GATEWAY_LANE`, `PRIVATE_CHAT_PROOF_BUDGET=1` | **Not ported.** The kit's model-invocation scope (`captureModelInvocation`, which the gateway fixture records) still keys a model call on 0.60's `step.started` coordinates (turn id, sequence, step index); a v27 stream carries none of them, so the lane's scope check cannot pass as written. The budget lane also needs the mail lane |

The default lane covers: the compiled channel refuses malformed and forbidden envelopes before
dispatch; one `operationId` stays separate per member; neither member's text reaches the other's
conversation; another member, an ungranted member and a cross-member control are refused before
the agent; a plain-text question continues; each member reads only their own mail; a cold restart
keeps the compiled output and the conversation; revoked access, a removed member, a changed account
generation and a changed incarnation each refuse the old conversation without a model or provider
call; no conversation rows are projected; nothing private reaches the server log. Creative refuses
skills it does not have.

The Tracks lane covers deny and approve, wrong member, session, request and forged answers refused
before the model or the Vault, approval across a cold restart, one exact write after approval,
a second member working alone, changed content not spending an approval, expiry, and a withdrawn
edit right refusing a pending card.

## The failure: denying a mail-send card leaves the prepared send open

In the mail lane, the member denies a send card. The denial reaches the agent (the scripted model's
follow-up read is refused with "Selected private resource is unavailable or authority changed", and
nothing is sent), but the prepared action in `personal_actions` stays `awaiting_dispatch` instead of
becoming `cancelled`.

Where to look (approvals code, not changed here): `personalSendInputResolved` in
`services/chief-of-staff/lib/personal-send-approval.ts` only cancels when
`privateResolverAdmission(ctx.session.auth.current)` names the card. The approve path,
`personalSendApprovalResponse`, reads the answer's principal from `ctx.response.principal`. The
likely cause, not confirmed, is that on eve 1.0 the answering member's admission is on the response,
not on the session's current auth when `interaction.settled` runs, so the deny path finds no
resolver and the action is never cancelled. The Tracks lane's deny, which settles through the exact
resolver path, passes.
