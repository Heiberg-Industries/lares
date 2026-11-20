# How an agent's messages look on every door

This is the standard for what a person reads when an agent talks to them through a door. It
follows [ADR-0025](decisions/0025-one-door-layer.md): the rules, the facts and the wording live
once, in the shared kit (`packages/agent-kit`). A door draws them with its own widgets.

**The rule that holds for every kind below:** the same facts, the same wording and the same
decisions on every door. The widgets may differ. A door that drops a fact, or words a fixed
sentence its own way, is wrong. No door file carries formatting of its own for a message kind;
formatting comes from the kit.

Order of doors: Slack first, Telegram second, web chat last. WhatsApp, email and iMessage are
written down only as what a later door must be able to show (last column of each table).

## The words we use

- **Card**: a message that asks for a decision, with buttons. Today the only card is an approval.
- **Approval**: "may I do this?" The card shows the exact change and has Deny and Approve.
- **Settled**: the card has been answered or closed.
- **The exact change**: every field the action will use, nothing summarised away. An email is the
  recipients, the subject and the whole body. A calendar change is the title, time and guests.

## Rules that hold for all kinds

1. **Facts first, decoration last.** The first line says what the message is. Anything a person
   needs to decide or to check is in the message itself, not behind a link.
2. **An approval card always shows the exact change.** A tool whose card shows only a title must be
   named, with a reason, in `CARD_NEEDS_NO_DETAILS` (`approval-summary.ts`). A test fails
   otherwise.
3. **A card too long to show whole offers no Approve.** Deny stays. The card says that it is
   shortened, how much is not shown, and where the whole request can be read and approved (the
   kit's `shortenedCardSentence`). Slack draws a long card whole across as many blocks as fit
   (50 per message) and only falls under this rule beyond that. Telegram cuts at about 4,000
   characters, so it falls under it much earlier.
4. **Buttons read Deny, then Approve.** The safe answer is where a thumb lands first.
5. **A settled card keeps the change on screen** and ends with one line, in the kit's words:
   "✅ Approved", "✖ Denied", or "✖ Not approved — this was closed without an answer." (nobody
   decided: withdrawn, interrupted, expired). Where the door knows who answered, it may add
   "by <name>". When the agent proposed a revised card in its place, a second line says
   "Revised — see the new card".
6. **Fixed sentences are the kit's.** A refusal, "no longer waiting", "could not check", the
   spending cap, "conversation too long": a door passes the kit's sentence on and never writes one.
7. **Text that reaches a person is plain wording.** No markup characters show as typed: no `*`
   around labels, no `&amp;`, no `**`. Each door converts the kit's text into what its platform
   renders.
8. **Missing or stale data is said, never guessed.** A message that could not read a value says
   so in words ("I could not read your calendar just now") and does not show a blank or an old
   value as current. The model's reply is not edited for this; the rule is in what the agent is
   told and in the tools' own messages.

## The kinds

### 1. A plain reply

| | |
| --- | --- |
| **Order** | The answer first. Detail after. Sources or links last, if any. |
| **Wording** | The agent's own voice. No "Sure!" preamble. |
| **Buttons** | None. |
| **Long text** | Sent whole, split on line breaks into several messages when the platform's limit is reached. Nothing is dropped. |
| **Slack** | Posted in the thread under the person's message as markdown that Slack renders natively. |
| **Telegram** | Markdown converted to Telegram HTML (bold, links, bullets), split at 3,800 characters on line breaks (`telegram-markdown.ts`). |
| **Later doors** | WhatsApp: plain text with its own bold marks; a long answer is split. Email: the same text as a body. iMessage: plain text only. |

### 2. Working / thinking

| | |
| --- | --- |
| **Order** | One short line saying the agent is working. It disappears when the reply arrives. |
| **Wording** | The framework's own status line. |
| **Slack** | A typing status under the thread. |
| **Telegram** | The "typing…" indicator. |
| **Later doors** | WhatsApp: a typing indicator where offered, else nothing; replies are buffered until complete rather than streamed. Email: nothing. iMessage: typing bubble. |

### 3. An approval card

| | |
| --- | --- |
| **Order** | Title line (what will happen, in one sentence). Then the exact change, labelled (To, Subject, then the body). Then the buttons. |
| **Wording** | Title and labels come from the kit (`approvalCardShape`). The title names every recipient; it is never abbreviated to "and N more". A title is marked "shortened" only when a value was really cut. |
| **Buttons** | Deny, Approve. |
| **Long text** | Rule 3. |
| **Slack** | One message: a card block with the title and buttons, then the change in sections. |
| **Telegram** | One message of plain text (title, blank line, the change as "Label: value" lines) and two inline buttons. |
| **Later doors** | WhatsApp: at most three buttons; Deny and Approve fit, and a long change is sent as a link to read it. Email: the change in the body with two links. iMessage: no buttons; a link. |

### 4. A draft

A draft is an approval card for saving or sending an email. The title says "Draft email to …" or
"Send email to …". The change is To, Subject and the whole body, in that order, on every door. It
is a card, so rules 2 to 5 apply.

### 5. A receipt (done)

| | |
| --- | --- |
| **Order** | The settled line (rule 5) on the card itself. After an approved action runs, the agent's next reply says what was done, in one sentence, with the thing's name. |
| **Slack** | The card is repainted in place: title, change, then the line. The buttons go. |
| **Telegram** | The card text is edited in place: the line is added under it and the buttons go. |
| **Later doors** | A door that cannot edit a sent message (email, iMessage) sends the line as a new message that quotes the title. |

### 6. A refusal

A refusal is a fixed kit sentence, said privately to the person it concerns where the platform
allows (`card-sentences.ts`). It says what happened and that nothing was done. Same words on every
door; no door adds a reason of its own.

### 7. An error

A failed turn says that it failed and offers the obvious next step (send again). The spending cap
and "conversation too long" have their own kit sentences. The spending-cap sentence is one
constant for every door (`SPENDING_CAP_REFUSED_TEXT`). If a turn had already done something before
it failed, the message says part of it may already be done.

### 8. A long answer

Rule 1 of the reply applies. In addition, a long answer starts with its conclusion, so that the
first message is useful alone. Nothing is cut on any door; the answer arrives as several messages.

### 9. A source-linked report

The one example that json-render will later draw. The facts are the same on every door:

1. A one-line title and the date it covers.
2. The headline finding, one sentence.
3. The supporting points, each with its source name as a link.
4. A line "Generated <time>. Sources as of <time>." so a stale report is visible as stale.

| | |
| --- | --- |
| **Slack** | A header block, a section per point with link text, a context line for the generated time. |
| **Telegram** | The title in bold, one line per point with the link, the generated line last. If it is longer than one message, the first message holds title and headline and ends with a link to the full report in the console. |
| **While generating** | "Working on it…" is the working state (kind 2). The report is never shown half built. |
| **If interrupted** | One line: "This report was not finished." and what is available so far is not shown. |
| **If a source is missing** | The point is shown with "source not available" in place of the link. It is not dropped. |
| **Web chat** | The full report. |
| **Later doors** | WhatsApp: title, headline and a link. Email: the whole report. iMessage: title, headline and a link. |

This kind is a rule on paper today: the report itself is built in the next release. The kinds
above are enforced by tests.

## What the tests check

`services/chief-of-staff/tests/door-message-standard.test.ts` renders the same fixture through
the Slack renderer and the Telegram card, and fails when:

- a fact of the change (recipients, subject, body, calendar title, guests) is missing from either door;
- the buttons are not Deny then Approve on both;
- a card shown whole loses Approve (a mail to two people included), or a cut card keeps it;
- a settled card does not end with the kit's line;
- the spending-cap refusal differs between doors;
- a long reply loses text when split.

## Gaps

These are known and not fixed by this standard.

1. **Slack's open card says "I've paused until someone approves or denies."** under the buttons;
   Telegram has no such line. It is eve's own subtext, not the kit's.
2. **Slack's settled card cannot say "Revised — see the new card".** The Slack renderer is pure
   and synchronous and the revision is looked up in the database. Telegram says it.
3. **Slack replies are the framework's markdown rendering**; Telegram's are Lares's own
   converter. They agree on bold, links and bullets. Tables and nested lists are untested on both.
4. **The source-linked report (kind 9) has no code yet.** Shared report records and their
   rendering are the next release's work.
5. **The "missing or stale data" wording (rule 8) is not checked by a test**, because it lives in
   the agent's instructions and the tools' messages, not in the door layer.
6. **The app icon cannot be set from a manifest on Slack.** It is a one-time upload by the owner.
7. **Web chat is not covered here.** It is last in the order and draws the same kit text.
