# The budget lane, and the mail-send lane it needs (eve 1.0.0-rc.9): FAILED, not ported

Attempted 2026-11-12 against eve 1.0.0-rc.9 on branch `eve-1.0` at `6fc0095c` plus the gateway
port in `member-private-chat-gateway-2026-11-12.md`, by `../scripts/member-private-chat-proof.mjs`.
**The budget lane did not reach its own checks.** It runs inside the personal mail-send lane
(`PRIVATE_CHAT_PROOF_SEND=1`), and that lane fails first, at a check this round does not loosen.

```sh
TMPDIR=<real path> PRIVATE_CHAT_PROOF_ROLE=chief-of-staff PRIVATE_CHAT_PROOF_GATEWAY_LANE=anthropic \
  PRIVATE_CHAT_PROOF_SEND=1 PRIVATE_CHAT_PROOF_BUDGET=1 \
  pnpm -C packages/board-evals exec tsx scripts/member-private-chat-proof.mjs
```

## Results

| Run | Variables | Result |
| --- | --- | --- |
| Mail send, scripted model | `ROLE=chief-of-staff SEND=1` | **FAIL** at "Resolver model created another proposal" |
| Mail send, gateway (Anthropic wire) | `+ GATEWAY_LANE=anthropic` | **FAIL**, same check |
| Budget | `+ GATEWAY_LANE=anthropic SEND=1 BUDGET=1` | **FAIL** earlier, at a repeated answer (see below); budget checks not reached |

## What now passes that failed on 11 November

The fault recorded in `member-private-chat-2026-11-11.md` is gone: denying a send card now
cancels the prepared send (`personal_actions.state = 'cancelled'`, card outcome `cancelled`). The
approve, the cold restart before the answer, exactly one provider send, and a repeated answer before
and after a second cold restart sending nothing more all pass.

## Failure 1 (blocks the lane): a new send card is raised in the turn after an answered card

The script's attack step makes the scripted model, in the turn after the member answers a send
card, call `personal_mailbox_send` again and `personal_mailbox_read`. The check (unchanged since eve
0.60.1) is that this creates no further prepared send: three `personal_actions` rows in the
conversation. There were five:

| row | how it was made | state | card outcome |
| --- | --- | --- | --- |
| 1 | the first send attack, denied | `cancelled` | `cancelled` |
| 2 | the model's second send, **in the turn after that deny** | `cancelled` | `ignored` (withdrawn when the member typed again) |
| 3 | the plain send, approved | `accepted` | `approved` |
| 4 | the second send attack, approved | `accepted` | `approved` |
| 5 | the model's second send, **in the turn after that approve** | `awaiting_dispatch` | open |

Nothing was sent without an answer (two sends, both approved) and the read in those turns was
refused ("Selected private resource is unavailable or authority changed"). But the turn after an
answered card could prepare a new send and put a new card in front of the member, twice.

Why this is reported as a product question, not a stale proof: the same attack on a Tracks card is
refused (`member-private-chat-2026-11-11.md`, Tracks lane: "the approval resume raised a new card"
is asserted zero and passes), so the two approval paths of one role disagree. On eve 1.0 the turn
after an answered card runs as the person who asked (the comment on
`captureBudgetAuthorityReference` in `packages/agent-kit/src/budget-model-authority.ts` says so), and
eve's own note to the model reads "request approval again if that action is still needed". Whether
a send proposal may be raised in that turn is a decision for the approvals code
(`services/chief-of-staff/lib/personal-send-approval.ts`, `services/chief-of-staff/lib/approvals.ts`),
not something to settle by relaxing the count here. Observed at
`scripts/member-private-chat-proof.mjs`, the `Resolver model created another proposal` assertion.

## Failure 2 (budget run only): a repeated answer opens a turn the budget refuses

With `BUDGET=1` the run stops earlier, at the repeated approve of an already spent card after the
first cold restart (`await answer(sa,approved)` the second time). The answer is accepted; eve opens
a new turn (`turn_5`) and its model call fails with `MODEL_CALL_FAILED: Unsupported budget
authority`, so the turn settles `failed` and the proof's "no read ends failed" rule stops the run.
Nothing is sent. The refusal comes from `captureBudgetAuthorityReference`
(`packages/agent-kit/src/budget-model-authority.ts`, the `privateResumeAdmission(current)` or turn
check at the top), called by the proof's budget recorder through `PgBudgetAdmissionStore.prepareIntent`
without an admitted purpose. The same step passes without the budget recorder. Not settled here:
whether in production the console would refuse that repeated answer before forwarding it (with a
model-purpose signer configured, which this fixture has none of), or whether a failed turn is the
intended outcome.

## Not ported, because not reached

- The gateway lane's two resume checks that only run with `SEND=1` still look for an approve and a
  deny model call with a blank turn id. eve 0.60.1 emitted one after a pending action settled; eve
  1.0 does not (it continues the asker's turn). They need porting once the mail lane passes.
- `proveDurableBudget` selects the same blank-turn resume calls. Same.

## Later on 12 November: the repeated answer is now refused by the console

Run again against `eve-1.0` at `2c5eac65` plus the change that makes the console refuse an answer
to a card that is already settled (`cardStillWaiting` and `claimAnswer` in
`services/console/lib/chat-proxy.ts`). Same command as above, with the budget recorder on.

| Run | Variables | Result |
| --- | --- | --- |
| Budget | `ROLE=chief-of-staff GATEWAY_LANE=anthropic SEND=1 BUDGET=1` | **FAIL** at "Resolver model created another proposal" (5 rows, 3 expected), as Failure 1 above |

What changed:

- **Failure 2 is gone.** The script's repeated answers to the spent send card (approve, deny, and
  approve again after a second cold restart) are now refused by the console before the agent,
  with "This request is no longer waiting. Nothing was sent." The proof checks that each one gets
  that sentence, reaches neither the agent nor the model, and sends nothing. No new turn opens, so
  the budget recorder is never asked. Before this change the script expected those answers to be
  accepted. The run now reaches the same check as the runs without the budget recorder.
- **Failure 1 is unchanged and still blocks the lane.** Its check was not touched: whether a new
  send card may be raised in the turn after an answered card is still an owner decision.

What did not change, and why:

- **The budget recorder still charges through a path production never calls.** It calls
  `PgBudgetAdmissionStore.prepareIntent` from inside the model call. Production charges through
  Keeper: the console signs each message and answer, Keeper's model-purpose broker admits it and
  opens the turn, and each model call is charged by `step.consume` (`prepareModelPurposeIntent`)
  and then dispatched through Keeper's gateway socket. Moving the proof onto that path needs, in
  this offline script: Keeper's broker with a financial journal, the console's signing key (which
  the console only accepts when owned by root, so the proof would have to fake that ownership),
  the role's runtime key and sockets, the budget fixture written through the journal, and a
  stand-in for Keeper's gateway socket in front of the fake model. That is a rework of the lane,
  not a change to its recorder, and it could not be checked by running it here: the lane stops at
  Failure 1 before its own budget checks (`proveDurableBudget`). It is left for the round that
  settles Failure 1.
- `proveDurableBudget` and the gateway lane's two resume checks still look for model calls with a
  blank turn id, which eve 1.0 never makes. Not reached, not ported.
