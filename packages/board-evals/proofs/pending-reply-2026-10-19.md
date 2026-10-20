# What eve 0.60.1 does with a reply while an approval card is waiting, 2026-10-19

Question: when a person types something while an approval card is still waiting, what happens to the
text, the card and the tool? This is evidence for the "revise a pending card by replying" and
"message parked behind an approval card" tickets. Nothing in the engine was changed.

```sh
pnpm -C packages/board-evals run proof:pending-reply
```

About 10 seconds on an idle machine (a disposable pgvector Postgres container, `eve build`, `eve start`
on a free loopback port). Docker must be running. No model credential, no gateway, no network beyond
loopback, no money.

## What was real, and what was not

- Real: an eve 0.60.1 process (`eve build`, then `eve start`); eve's own session routes
  (`POST /eve/v1/session`, `POST /eve/v1/session/<id>`, the NDJSON stream); the real chat door
  (`services/chief-of-staff/agent/channels/eve.ts`, copied into a disposable fixture) with a route
  password; a real Postgres; a tool gated with `approval: always()`.
- Scripted: the model (the package's `mockModel`). "pr:send X" makes it call the gated tool once with
  tag X. Any other text gets a plain answer. Every model call is logged with the full prompt it was handed.
- Not observed: Slack. The fixture has no Slack door, so how a Slack card repaints is NOT claimed here
  (see item c).
- The requests are made directly against the session routes, with the route password only. The console
  proxy and the per-member approver check were left out on purpose: they sit above these routes and the
  questions here are about eve's own behaviour. A person's typed text reaches eve through the same
  `POST /eve/v1/session/<id>` with `{ "message": ... }` that the console's chat sends.
- The probe extension that other proofs build is left out of the disposable copy. Building it runs
  `eve extension build`, which fails under the repo's pinned TypeScript 7.0.2 (error TS5112, "tsconfig.json
  is present but will not be loaded if files are specified on commandline"). This is a pre-existing
  problem that also stops the older proofs on a fresh checkout; it was not touched here.

The card that was parked (verbatim, session `wrun_01M5AMTRGGH80NQ6AW4YQ52DY0`):

```json
{
  "action": { "callId": "mock-tool-call-1-0-1", "input": { "tag": "A" }, "kind": "tool-call", "toolName": "pr_send" },
  "allowFreeform": false,
  "display": "confirmation",
  "kind": "tool-approval",
  "options": [ { "id": "approve", "label": "Approve" }, { "id": "cancel", "label": "Cancel" } ],
  "prompt": "Approve tool call: pr_send",
  "requestId": "aitxt-qQCswNh2JvSrGZQC9NnqFBkS"
}
```

## Answers

### (a) A text reply during a pending card: does it run a turn, and what does the model see?

**Observed: yes, it runs a normal turn, and the card stays approvable.** The reply was accepted (HTTP 202).
The stream then showed a full ordinary turn: `turn.started, message.received, step.started,
message.appended, message.completed, step.completed, turn.completed, session.waiting`. The model was called
once. The tool ran zero times because of the reply. Afterwards the original card was approved with
`inputResponses`, answered 202, and the tool log read `sent:A`: the old card was still live after the
redraft turn.

What the model saw: its prompt held the first user message, then a synthetic user-role message, then the
reply:

```
user: pr:send A
user: [Pending approvals]
      The following tool calls are awaiting approval and have not executed:
      {"requestId":"aitxt-qQCswNh2JvSrGZQC9NnqFBkS","toolName":"pr_send"}
user: pr:please change the subject line
```

So the model is told a call is waiting and has not executed, with the request id and tool name only. It is
not shown the arguments of the waiting call (here `{"tag":"A"}`) and not told how to withdraw it. The tool
list on that call still contained the gated tool, so it can propose a second call.

Evidence: session `wrun_01M5AMTRGGH80NQ6AW4YQ52DY0` (identical shape in both runs); tool log `sent:A` once, after the explicit approval only.
Confidence: high for the stream shape, the zero executions and the prompt text (all read from the run);
the prompt is the mock model's view of eve's assembled messages, which is what a real model is handed.

### (b) Does typed "approve" or "1" approve the card on the HTTP / web chat route?

**Observed: yes. Typed `approve`, `1` and `Approve` each approved the card and the tool ran once.** Each was
sent as a plain `{ "message": ... }` follow-up, the same body web chat sends. In every case the stream began
with `input.resolved` (no `message.received`, so the text was consumed as an answer and not shown to the
model as a new user message), then `turn.started`, `action.result`, and the model was called once to
finish the resumed turn.

| typed text | HTTP | stream began | tool log | session |
| --- | --- | --- | --- | --- |
| `approve` | 202 | `input.resolved, turn.started, ..., action.result` | `sent:typed-approve` | `wrun_01M5AMTRPDMAX6XPJEWZT1DTJ9` |
| `1` | 202 | same | `sent:typed-1` | `wrun_01M5AMTRR339GXMAXJ6FWXWFMD` |
| `Approve` | 202 | same | `sent:typed-Approve` | `wrun_01M5AMTRSPD26AEF36FEW2CP0K` |

The option list was `approve` (index 1, label "Approve") and `cancel` (index 2). Matching is therefore on
the option id, the label (case did not matter for "Approve" vs "approve") and the one-based index. I did not
test other spellings (for example "yes", "ok", extra whitespace or a sentence containing "approve"), so how
strict the match is beyond these three inputs is not known from this run.
Confidence: high that these three exact texts approve on this route (three separate sessions, same result).
Unknown: where exactly the matching rules stop. Not tested: Slack or Telegram typed replies (eve's docs say
the same rule applies on every channel, but that was not observed).

### (c) Can our own code cancel a pending request so the tool never executes?

**Observed: yes, on the HTTP session route.** `POST /eve/v1/session/<id>` with
`{ "inputResponses": [ { "requestId": "<card requestId>", "optionId": "cancel" } ] }` was accepted (202).
The stream was `approval.settled, input.resolved, action.result, turn.started, step.started, message.appended,
...`. The `input.resolved` event reads `outcome: "denied"` with the `cancel` response echoed back. The tool
ran zero times. The model then ran one turn after the denial.

A late `approve` for the same card afterwards was also accepted with 202 (no error), but nothing ran:
execution count stayed 0. So a cancelled card cannot be revived by answering it again.

Evidence: session `wrun_01M5AMTRVKXXZXG8SWWWNW1EW5` in the last run (the cancel and the late approve), tool log
without any `sent:C` line.

**Slack repaint: NOT observed.** The fixture has no Slack door. From eve's own documentation, the Slack
adapter renders approvals as buttons and "writes the user's choice back as the answer"
(`node_modules/eve/docs/tools/human-in-the-loop.md`, "Answering from a client or channel"). Whether a card
cancelled from our own code (not from a tap) is repainted in Slack, and with what wording, is unknown. It
needs a live Slack check or reading eve's Slack adapter; this proof says nothing about it.
Confidence: high for the HTTP cancel and zero executions. None for Slack.

### (d) A second card for the same tool while the first is pending: does approving the first still execute it?

**Observed: yes. Both cards are live at once, and approving the first runs the first.** After the first card
(`sent` tag "first") was parked, a follow-up asking for a second call to the same tool was accepted (202). The
turn emitted `actions.requested, ..., input.requested` with a second card (tag "second", different
`requestId` `aitxt-9aGYaXZF7dGSjRoye5Q11NKq`). Nothing withdrew the first card. Approving the first card's
`requestId` afterwards answered 202 and the tool log read `sent:first`. Cancelling the second card then
answered 202 and the log stayed at the single `sent:first`.

So eve does not supersede or cancel an older card when a newer one for the same tool arrives. If the older
card is approved, it executes with its own original arguments, whatever the newer card says.

Evidence: session `wrun_01M5AMTRXZFQMS0Q5FCSDZKVTD` (last run); final tool log `sent:first` only.
Confidence: high.

## Summary for the tickets

| question | answer |
| --- | --- |
| (a) reply runs a turn; card stays pending | yes; the model is told "awaiting approval, not executed" with the id and tool name, no arguments |
| (b) typed `approve` / `1` approve | yes (`approve`, `1`, `Approve` all tested on the HTTP route) |
| (c) our own cancel prevents execution | yes, via `inputResponses` + `cancel`; Slack repaint not observed |
| (d) older card still executes after a newer one | yes; both cards are live and independent |

What this means for the redraft risk: a reply that changes the draft leaves the old card live, so two
different sends could both be approved. Withdrawing the old card in our own code is possible (c).
Typed approval is real on this route (b); a door-level guard would be needed to stop it.

## Method notes

- Each case used a fresh session so earlier cards could not leak into later ones, except where the case
  needs two cards in one session (d).
- Two full runs gave the same shapes for every case; every session id above is from the last run.
- Reproduce, with the raw evidence written to a file:
  `PENDING_REPLY_PROOF_OUT=/tmp/pending-reply.json pnpm -C packages/board-evals run proof:pending-reply`.

## Update 2026-10-20: typed text no longer answers an approval card

Owner decision: only a button tap or the console's Approve (an `inputResponses` entry with an
`optionId`) approves a tool-approval card. Typing "approve", "1" or "Approve" must not.

The change is one hunk in `patches/eve.patch`: `resolveTextToResponse` (`dist/src/channel/resolve-text.js`,
the only place eve matches text against an option id, label or index; both harness callers and the
client helper go through it) now returns nothing for a request of kind `tool-approval`. Other kinds
(free-text questions, session limits) keep eve's matching unchanged. A rejected match leaves the text
as an ordinary follow-up message.

Scenario (b) of `pnpm -C packages/board-evals run proof:pending-reply` now asserts this. Observed on
the patched build (three typed variants, each on its own parked card):

- stream after the typed text: `turn.started, message.received, step.started, message.appended,
  message.completed, step.completed, turn.completed, session.waiting`. Before the patch it began with
  `input.resolved` and carried an `action.result`, and had no `message.received`.
- the model received the typed text as the user message (one model call each);
- tool log after the typed text: empty;
- a following `inputResponses` approve on the same card: 202, and the tool ran exactly once
  (`sent:typed-approve`, `sent:typed-1`, `sent:typed-Approve`).

Scenarios (a), (c) and (d) are unchanged. This covers every door, because the matching happens inside
eve, ahead of Slack, Telegram and web chat alike. Slack and Telegram button taps arrive as
`inputResponses`, so they are unaffected; that part is not exercised here (no Slack or Telegram in the
fixture).
