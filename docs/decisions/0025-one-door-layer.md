# ADR 0025 — One door-neutral layer; a door is an adapter

**Date:** 2026-11-12
**Status:** Accepted; to be built after the framework branch reaches main
**Amends:** ADR-0016 §2 and ADR-0021 §7 (when a framework patch is allowed)

## In plain language

1. People reach an agent through **doors**: web chat, Slack and Telegram today; email, WhatsApp
   and iMessage later.
2. An agent sometimes shows a **card**: an approval ("may I send this?") or a question, with
   buttons. Pressing a button is a **tap**.
3. The rules about cards were written separately in each door's files. They have drifted: the
   doors refuse in different words, and only web chat stops a second tap on a finished card.
4. From now on every such rule is written once, in one shared place, the **layer**. A door is a
   thin **adapter** that does five small things and holds no rules, no sentences and no tables.
5. A new door then costs one adapter file, one live test and a shared test that every door must
   pass.
6. Nothing changes for an owner until the layer is built. This record is what the build follows.

Terms used below, each with one meaning. The **owner** is the person an installation belongs to.
A **member** is any other person the installation accepts. The **card record** is the one table
that lists every card. A **card address** is where a card sits on a platform (for example a chat
and a message id). The **kit** is the shared package `packages/agent-kit`.

## Context

The owner decided on 12 November 2026 that every card rule lives once and that a door is only an
adapter. This section records what the code does today on the framework branch (`eve-1.0`), so
the build starts from facts. Statements about eve itself say which eve version they were read on
(eve `1.0.0-rc.9` at the time of writing; the framework branch moves to `1.0.0-rc.10`, and those
statements are not assumed to carry over). Paths are from the repository root.
`cos` stands for `services/chief-of-staff`, `creative` for `services/creative`, `console` for
`services/console`, `kit` for `packages/agent-kit/src`.

| Concern | Telegram | Slack (two role services) | Web chat | Already shared in the kit? |
| --- | --- | --- | --- | --- |
| Card rendering | eve's own card, changed by `patches/eve.patch` at `public/channels/telegram/hitl.js`. `cos/agent/channels/telegram.ts` adds a note under a shortened card and the outcome line. It reads eve's private channel state to find the card. | `cos/lib/slack-approval-card.ts` and `creative/lib/slack-approval-card.ts`: the same file twice, kept identical by hand. | `console/components/ChatTranscript.tsx` | The card's title and details text only (`kit/approval-summary.ts`). The drawing is per door. |
| Tap or answer gate | `cos/lib/telegram-tap-gate.ts`, called from `cos/agent/channels/telegram-webhook.ts`. Lets any person on the allow-list through; refuses a button it does not recognise for everyone. | `authorizeSlackAnswer` in `cos/agent/channels/slack.ts` and again in `creative/agent/channels/slack.ts`. The owner only, for approvals and questions alike. | `console/lib/chat-proxy.ts` (signed in, bound to the conversation, Approve or Deny only), then each role's `agent/channels/eve.ts`. | No. The owner check is repeated per door. |
| Who may answer an approval | eve's `response` policy, attached to every gated tool: `nativeAnswerDecision` in `cos/lib/approvals.ts`. The owner only. | The same policy, written a second time in `creative/lib/approvals.ts`. The two copies differ: only the first keeps the accepted answerer for the settle step. | The exact check in `kit/approval-execution.ts` (`approveExactResponse`): only the member who started the conversation. | Web chat's check is. The chat doors' policy and the owner lookup (`isOwnerPrincipal` in each role's `lib/principals.ts`) are written twice. |
| Who may answer a question | The tap gate lets any allowed person through. After that eve decides. | The owner only (`authorizeSlackAnswer`). | No question card: a question is shown as text and answered as text. | No rule in the kit. |
| Refusal note | `TAP_REFUSAL` and `TAP_UNRECOGNISED` in `cos/lib/telegram-tap-gate.ts`. | `SLACK_TAP_REFUSAL` and `tellRefusedSlackTapper` in `kit/door-channels.ts`, used by both roles. | Fixed sentences inside `console/lib/chat-proxy.ts`. | For Slack only. The Telegram and Slack sentences differ; the code says so itself. |
| "Too long" sentences | `onTurnSettled` in `cos/agent/channels/telegram.ts` | `answerFailure` in each role's `agent/channels/slack.ts` (written twice) | `console/lib/limit-reply.ts` | Yes: `kit/conversation-too-long.ts`, chosen in `kit/gateway-budget.ts`. The spending-cap sentence is still a literal in three door files. |
| Shared-room rule | Not needed: the door admits private chats only (`isAllowedTelegramMessage`). | Applied in `cos/agent/tools/catalogue.ts` and `cos/lib/approvals.ts`. No call site in the creative role. | Not needed: every conversation is private. | Yes, but written for Slack by name: `kit/private-console-surface.ts` (`startedInSharedSlackRoom`, `SHARED_ROOM_REFUSED`). |
| Settled card (late or second tap) | The door removes the buttons (`onInteractionSettled`). A tap that still arrives is not checked by Lares. | eve repaints the card. No Lares check. | `cardStillWaiting` and `claimAnswer` in `console/lib/chat-proxy.ts`; the sentence `ANSWER_NOT_USED` in `console/lib/chat-session.ts`. | No. Only web chat has a guard, and part of it is a list held in the console's memory. |
| Reply to an answered request | `cos/lib/approval-card-turns.ts`, the same at every door of that role. | The same file for the chief-of-staff role. The creative role has no such rule. | The same file for the chief-of-staff role. | No, it is local to one role. The two sentences for a refused reply are shared (`kit/approval-reply-sentence.ts`). |
| Approval records | `kit/approval-ledger.ts` (table `approval_asks`), written by `kit/approval-record-hook.ts`. | The same. | The same, plus the exact-approval columns (`kit/approval-execution.ts`). | Yes. The table has no column for the door a card was posted on or for the card address (its `answered_via` column says only how a card was answered), and it lists approvals only, not questions. |

Four facts about the framework shape the decision:

- eve decides who may answer an **approval** through a `response` policy on the tool. By default
  only the person who asked may answer. Lares already replaces that default on every gated tool.
- eve's documentation gives no such policy for a **question** (see also vercel/eve#6283).
- eve treats an answer to a request that is already settled as a new message, and starts a turn
  for it. This happens in one door-neutral place, `deliver()` in `harness/hitl/delivery.js`
  (`convertStaleResponsesToUserMessage`), as read on `rc.9`. It was not re-read on `rc.10`. The
  Lares patch already changes that file once, so that typed text never answers an approval.
- eve ships a bridge, `eve/channels/chat-sdk`, that turns any Chat SDK adapter into a door. The
  bridge takes the state store it is given and passes the tapper's identity on
  (`resolveInputAuth`).

## Decision

1. **eve's `response` policy is the one rule for who may answer an approval.** Per-door owner
   checks go away. A door's own gate stays for two things only: who the sender is, and whether
   that person is on the door's allow-list.

2. **A late or second tap on a settled card is dropped in one door-neutral place:** eve's
   delivery step, by a small addition to `patches/eve.patch` at `harness/hitl/delivery.js`. No
   door keeps its own table of cards. The eve project is asked to make this an option. The
   requests are vercel/eve#6280 (an option to drop an answer to a settled request) and #6283 (an
   answer hook for Telegram's buttons, as Slack has). Related: #5751 (typed text never answers an
   approval) and #5750 (a documented card renderer for Telegram and Teams).

3. **Unknown cards and questions.** An unknown card is a card that is not in the card
   record. The owner's tap on an unknown card goes through to eve; a member's is refused. A
   question put to a member is answered by that member only.

4. **One module in the kit holds what eve lacks:**
   - who may answer a question;
   - the sentences a person is told when a tap is refused or a card is no longer waiting;
   - the rule that nothing reaching other people starts in the reply to an answered request
     (today in `services/chief-of-staff/lib/approval-card-turns.ts`);
   - one card record. It extends the existing `approval_asks` table; there is no new table.

5. **A door adapter provides exactly five things:**
   1. the verified identity of a sender;
   2. a tap, mapped to the door, the card address and the person who tapped;
   3. the card address, recorded when the door posts a card;
   4. one fixed sentence, said privately to one person;
   5. whether the door can show buttons.

   Nothing else.

6. **These stay per door, on purpose:** transport and signature checks; platform limits (message
   length, button count); how "privately" is done; whether the door works in private chats only
   or also in shared rooms; when a conversation is replaced by a new one.

7. **A new door starts from eve's own channel where eve ships one for that platform** (use what
   is already installed before adding a layer). Where eve has none, it starts from eve's Chat SDK
   bridge (`eve/channels/chat-sdk`) with state kept on the owner's server, when an adapter exists
   that works self-hosted. Otherwise it is a custom eve channel with the same adapter contract. An adapter that routes messages through a hosted
   relay service fails this project's rules (self-hosted only; nothing phones home) and is not
   used.

8. **A framework patch that enforces a layer rule is allowed only at a door-neutral spot, and it
   comes with a request to the eve project.** This narrows ADR-0016 §2 and ADR-0021 §7.

9. **When rules 1 to 8 hold, a new door costs:** one adapter file, one live probe
   (`tests/live/<door>.live.mts`), and a pass of the shared contract test. It adds no rule, no
   sentence and no table.

## What must go through the layer

- Every decision about whether a tap counts: who may answer, whether the card still waits,
  whether the card is known.
- Every sentence a door says about a card, a refusal, a conversation that is too long, a shared
  room or a spending limit. A door passes the kit's sentence on; it never writes one.
- The card record: every read and every write.
- The rule about the reply to an answered request.
- The claim flow (`packages/agent-kit/src/door-authority.ts`, `door-channels.ts`), which the kit
  already holds.
- The allow-list check. The kit does not hold it today: `allowedPrincipalIds` and
  `isAllowedPrincipalId` are written once in each role's `lib/principals.ts`. The two copies run
  the same code but cover different channels (the chief-of-staff copy knows Slack, Telegram and
  web chat; the creative copy knows Slack and web chat only). The check moves into the kit,
  once, and a door calls it.

## What stays per door

The five adapter functions of rule 5 and the list in rule 6. A door file may contain platform
calls, payload parsing, secret reading and the platform's own limits. It may not contain a rule
about people, a sentence for a person, or a list of cards.

## Consequences

**The contract test.** One shared test, to be built with the layer in `packages/agent-kit`, runs
against every door adapter with a fake platform. A door ships only when it passes. It checks at
least:

1. A message from a sender the door cannot verify, or who is not on the allow-list, starts
   nothing.
2. A posted card's address is in the card record.
3. The owner's tap on a waiting approval is delivered once, as the owner.
4. A member's tap on an approval is refused; nothing is delivered; that member, and nobody else,
   is told the kit's refusal sentence.
5. A question put to a member takes that member's answer and refuses anyone else's.
6. A second tap on a settled card starts no turn, and the person is told the kit's "no longer
   waiting" sentence.
7. On an unknown card, the owner's tap reaches eve and a member's is refused.
8. A door that reports it cannot show buttons never lets typed text answer an approval.
9. In the reply to an answered request, nothing that reaches other people starts.
10. The door file holds no sentence of its own.

**The refactor list: what moves where.**

Telegram (`services/chief-of-staff`):

- `lib/telegram-tap-gate.ts`: the owner and approver decision and the two sentences move to the
  kit. Recognising a tap and reading the tapper stay, as adapter function 2.
- `agent/channels/telegram-webhook.ts`: stays as the front door (secret check, forward). It asks
  the kit whether a tap counts and says the kit's sentence.
- `agent/channels/telegram.ts`: the card outcome wording, the shortened-card note and the
  spending-cap sentence move to the kit. Reading eve's private channel state for the card's
  message id is replaced by the card address in the card record. Posting, HTML conversion,
  message splitting and conversation rotation stay.

Slack (`services/chief-of-staff` and `services/creative`):

- `authorizeSlackAnswer` in both `agent/channels/slack.ts` files: the owner check goes (rule 1).
  What stays is handing the tap and the tapper to the kit.
- `SLACK_TAP_REFUSAL` in `packages/agent-kit/src/door-channels.ts` becomes the kit's one refusal
  sentence for every door. Its present wording ("Only the owner…") is not true for a member's
  question and changes.
- `lib/slack-approval-card.ts`, twice: becomes one file in the kit.
- `answerFailure` and the spending-cap sentence, twice: become one kit function per failure.
- `nativeAnswerDecision`, `isOwnerPrincipal` and the allow-list check (`allowedPrincipalIds`,
  `isAllowedPrincipalId` in each role's `lib/principals.ts`), written in both roles: become one
  each, in the kit. The answerer that one role keeps in process memory is kept in the card record instead.
- `lib/approval-card-turns.ts` moves from the chief-of-staff role to the kit, so the creative
  role gets the rule too.

Web chat (`services/console` and each role's `agent/channels/eve.ts`):

- `cardStillWaiting` and the in-memory claim list in `lib/chat-proxy.ts`: the decision that an
  answer is late moves to eve's delivery step (rule 2).
- `ANSWER_NOT_USED` in `lib/chat-session.ts` moves to the kit as the "no longer waiting"
  sentence. The kit module that holds it must have no imports, because the browser reads it too.
- Sign-in, the conversation binding and the closed list of request fields stay. They are this
  door's identity and transport.

Shared:

- `approval_asks` gains the door, the card address and the person a card was put to, and it
  lists question cards as well as approvals. This needs a migration, and the migration needs the
  manual image-probe run before it reaches main.
- `startedInSharedSlackRoom` in `private-console-surface.ts` no longer reads Slack's own channel
  ids by name. How a door tells the layer that a conversation is shared is open question 5.
- `patches/eve.patch` gains the delivery-step addition of rule 2.

**Accepted costs.**

- Behaviour changes on Slack: a member can answer a question put to that member. Today only the
  owner can answer any card there.
- The framework patch grows by one hunk in minified code until eve accepts #6280.
- Until the layer is built, the drift in the table above remains.

## Unverified

These points could not be confirmed by reading the code on the framework branch. Each is checked
when the layer is built.

1. What eve does with a member's tap on a question on Telegram. The tap gate lets an allowed
   person through; that any presser's answer then stands is taken from vercel/eve#6283, not
   driven here.
2. What a second allowed person sees on Telegram when the `response` policy refuses the answer.
   No Lares sentence is sent on that path.
3. That a refusal by the `response` policy can reach the door's "say one sentence privately"
   function. eve's documentation says a refused answer is reported as `response.settled` with
   outcome `refused`; this was read, not run.
4. That the delivery-step drop also covers two answers arriving at the same moment, so that the
   console's in-memory claim list can go.
5. That the patch which stops typed text answering an approval also covers the numbered options
   the Chat SDK bridge shows on a door without buttons.
6. Which Chat SDK adapters and state stores work fully self-hosted. This is checked per door,
   with a live probe, before the door is started.
7. The four eve issues were read on eve's public tracker on 12 November 2026; all four were
   open. #6280 describes the delivery step as of eve `rc.10`. The function it names was read in
   eve `rc.9`; it was not re-read in `rc.10`. When the framework branch is on `rc.10`, check
   that the delivery step still looks as #6280 describes before the patch addition is written.

## Open questions

1. **An unknown card in web chat.** Today the console refuses an answer to a card it has no
   record of for everyone, the owner included. Rule 3 lets the owner's tap through. Does rule 3
   apply to web chat, or does web chat keep failing closed?
2. **The Telegram card hunk in the patch.** It sits in eve's Telegram channel, which is not a
   door-neutral spot. It draws the card, and it also removes Approve from a card whose text was
   cut. Is removing Approve a layer rule (then rule 8 forbids it there) or a platform limit
   (rule 6)?
3. **May a shortened card be approved?** Telegram removes Approve from a card the kit shortened.
   Slack keeps it. Web chat was not checked. If this is a rule, it belongs in the kit with one
   answer.
4. **Question cards in `approval_asks`.** Rule 3 needs question cards in the card record. The
   table then holds more than approvals. Keep the table name, or rename it in the same migration?

5. **Private or shared.** The shared-room rule lives in the kit and must know whether a
   conversation is private. That is not one of the five things an adapter provides (rule 5).
   Does it travel with the verified sender identity, as it does on Slack today, or is it a
   sixth item?
6. **"Too long" sentences.** The kit has five, because each names that door's own way to start
   over (rule 6). Rule 9 says a new door adds no sentence. Does a new door reuse one general
   sentence, or may it add its variant to the kit?

## Cross-references

- ADR-0016 §2 and ADR-0021 §7 — the pinned, patched framework and sending patches upstream.
- ADR-0019 — live probes; self-hosted integrations.
- ADR-0020 — conversations and their records.
- ADR-0022 — web chat first; what the console's identity claim is worth.
- ADR-0023 — members, owners, and who may answer a card in a private conversation.
- [Adding a door](../adding-a-door.md) — the contributor guide for this record.
