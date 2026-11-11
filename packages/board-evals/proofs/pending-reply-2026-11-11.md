# What happens when a person types while an approval card is waiting? (eve 1.0.0-rc.9)

Measured 2026-11-11 against eve 1.0.0-rc.9 with the repository's framework patch, by
`../scripts/pending-reply-proof.mjs`. The same proof on eve 0.60.1 is `pending-reply-2026-10-19.md`
(and `pending-reply-revise-2026-10-20.md` for scenario e). Re-run it with

```sh
pnpm -C packages/board-evals run proof:pending-reply
```

Docker running. A real eve process (`eve build` + `eve start`), a disposable Postgres, eve's own
session routes driven with eve's own `Client`, the kit's real approval-record and approval-supersede
hooks; a scripted model, no credential, 39 s. The door is eve's HTTP door behind a throwaway route
password; it is no longer a copy of a role's door file (that file cannot be lifted out alone any
more), which does not bear on any of the five questions.

## The answer that changed

On eve 0.60.1 a card stayed open when the person typed, and a later button press could still
approve it. **On eve 1.0 text withdraws the card.** The card settles with outcome `withdrawn` in
the same stored line that takes the message in, the call it was for settles `rejected`, and the
model gets the person's words. A later answer to the withdrawn card is accepted by the route and
does nothing.

## Results

| | Question | Observed |
| --- | --- | --- |
| a | A plain text reply during a pending card | The reply is accepted and runs one turn (one model call, request ends `completed`). The reply executed nothing. The stream of the reply opens with `interaction.settled` and `call.settled` for the waiting card. Approving the original card afterwards is accepted and runs nothing. |
| b | Typed `approve`, `1`, `Approve` on the HTTP route | **Asserted, all three:** the text arrives as a message (`delivery.consumed`), the model sees it, the tool log stays empty, the card settles `withdrawn` (never `accepted`), and a button approve of the same card afterwards runs nothing. The tool ran zero times in each case. |
| c | Our own refusal with a `deny` answer | Accepted; zero executions; a late approve of the same card is accepted and still runs nothing. |
| d | A second card for the same tool while the first waits | The second message withdraws the first card and raises one new card. Approving the first then runs nothing; denying the second runs nothing. |
| e | A revised proposal with the real hooks loaded | The older card is settled `withdrawn`; the ledger row for it reads `outcome: ignored`, `answered_via: nobody-decided`; the new card is live with an open ledger row. Nothing executed before the new card was approved; approving it ran the tool exactly once (`sent:E2`); a late approve of the old card ran nothing. |

Scenario (b) is the check on the framework patch's typed-answer rule: unpatched eve 1.0 lets a
message whose text matches an option answer a card, approvals included
(`eve/docs/tools/human-in-the-loop.md`). With the patch, text never approves.

## What this means for the supersede hook

On 0.60.1 the kit's hook had to deny the older card itself when a revision arrived. On eve 1.0 the
framework has already withdrawn it by the time the new card opens, so in this run the hook found
nothing left open to deny, and the ledger records the old card as decided by nobody. The hook's
deny is still there for a card eve's view shows as open.

## Not observed here

The Slack card repaint (no Slack in the fixture).
