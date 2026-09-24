# Writing voice — tone by recipient, learning from the owner's edits, and a briefing the owner can hand over

**Date:** 2026-09-19
**Status:** DRAFT (LAR-77). **Needs a final audit against the repo before it becomes a plan** (see "Audit before planning" at the end). It sits under `docs/research/` on purpose: it was written while the eve upgrade was landing on main, so nothing it names has been re-checked since. After the audit its home is `docs/specs/2026-09-19-writing-voice-design.md`.
**Depends on:** ADR-0017 (the Vault), ADR-0018 (learning and dreaming), ADR-0019 (integrations), ADR-0020 (conversations, retention, erasure), the origin model (`docs/specs/2026-09-18-origin-model-design.md`)
**Research behind it:** `01-tooling-and-vendors.md` and `02-techniques-and-practice.md` in this folder, and the owner's own draft of 2026-09-19 ("Gmail drafting agent: style learning and relationship context")

## In plain language

Today an agent drafts an email in the owner's voice using one written style guide per mailbox
and three past emails chosen because they are about a similar topic. The drafts come out in
roughly the right voice but the wrong tone for the person — a client, a collaborator and a friend
all get the same register — and the owner ends up rewriting. Nothing is learned from that
rewrite: the draft is thrown away the moment the email is sent.

This design changes four things, in this order. First, the agent keeps its draft and pairs it
with what the owner actually sent, so there is finally something to measure and learn from.
Second, it picks its examples by who the email is to — this person first, then this kind of
relationship, then the mailbox — and the style guide gains short sections per kind of
relationship. Third, it reads the owner's edits, separates style changes from factual
corrections, and turns repeated style changes into plain written preferences that the owner
accepts or rejects in the console; nothing is learned without that acceptance. Fourth, because
most of what makes a reply right lives in the owner's head, the design gives the owner easy ways
to hand context over — a one-line steer, and an offer to save a fact the owner just typed into a
reply — before it tries to be clever about finding context on its own.

Only words the owner wrote ever become learned knowledge. What the other person wrote can inform
one draft and is never stored as a lesson. No outside memory product is adopted; the store is
ours, in the existing database.

## Owner rulings this design rests on (2026-09-19)

1. Tone is learned at **both** levels: relationship type as the base, the individual person
   overriding it once there is enough of the owner's own writing to that person.
2. **Tone and wording is the worse pain** (it forces a rewrite). Misreading the situation is more
   tolerable, and harder to solve, because most context lives in a human. Build order follows:
   capture → tone by recipient → learning from edits → context.
3. The edit-and-send-from-Gmail workflow stays. Sending remains the owner's action.

## What exists today (verified 2026-09-19, re-verify at audit)

| Piece | Where | What it does |
|---|---|---|
| Voice card per mailbox | `services/chief-of-staff/lib/voice.ts`, `voice-store.ts`, `services/box/sql/013`, `033` | Core + English + Norwegian sections; falls back to `default`; never another mailbox's card |
| Learner | `lib/voice-learn.ts`, `agent/schedules/voice-learn.ts` | Reads Sent mail per mailbox, strips quotes/forwards, embeds exemplars, distils a PROPOSED card the owner accepts in the console |
| Exemplars | `voice_exemplar` (`sql/013`, `026`) | Per mailbox, language-tagged, retrieved by topic similarity, 3 at a time |
| Voice guide tool | `catalogue/voice_guide.ts` | Returns card + examples before a draft |
| Reply prompt | `lib/reply-prompt.ts` | One prompt for both drafters: examples first, card second, labelled context blocks, compose contract |
| Compose contract | `packages/compose-contract` | Language mirroring (real correspondence first), no untaken actions, labelled context, grounding |
| Draft bookkeeping | `sql/022`, `034` (`email_triage_processed.draft_id`, `thread_id`) | Remembers WHICH Gmail draft belongs to which thread — not its text |
| People | `lib/person/`, network service, CRM client, vault people pages | Identity and history, in three homes already |

What is missing: any notion of the recipient in the voice; the draft's text after creation; any
comparison with what was sent; any measure of draft quality.

## Part 1 — Capture and measure (no learning yet)

**What it does.** Every draft the agent creates is kept, exactly as presented, with what went
into it. A scheduled job later finds the email the owner actually sent and pairs the two.

**Records** (names indicative; the audit settles them against the current schema):

- `draft_run` — mailbox, thread id, Gmail draft id, revision number, subject + body as generated,
  recipients, created-at, model and prompt version, voice-card version, the ids of the exemplars
  used, and references to the context blocks used. A regenerated draft is a new revision, not an
  overwrite.
- `sent_pair` — draft run + revision, sent message id, sent body (owner-authored part only, with
  quotes, forwards and signature stripped by the same code the learner uses), sent-at, match
  evidence, match confidence, and an **edit class**: `unchanged`, `light`, `rewritten`, `abandoned`
  (no send found within the window).

**Matching a draft to the sent message.** Gmail deletes the draft on send and creates a new
message; how identifiers behave is not documented well enough to build on. Per the repo rule, a
committed live probe — `tests/live/gmail-draft-to-sent.live.mts` — answers, against a real
mailbox: does a `Message-ID` header we set survive a send from the web and mobile clients; does
the thread id survive a changed subject or recipient list; what does the history feed record when
a draft is sent. The fallback matcher, used regardless as a cross-check: same thread, SENT label,
created after our draft, highest text similarity above a floor. A match below the confidence
floor is stored as uncertain and is **never learned from**.

**Measures.**

- *Survival*: the share of the draft's sentences and words that survive into the sent text
  (word- and sentence-level diff via `jsdiff`, the one new dependency). From Part 3 onward this is
  split into style edits and factual edits.
- *Unedited-send rate*: tracked as a trend only. **It is never counted as approval** — people
  accept good-enough text, and counting it is how an agent ends up reinforcing its own habits.
- *The replay set*: a frozen set of about 50 past exchanges (incoming mail + what the owner
  really sent), held out from all learning. Any change to example selection, the card or the
  prompt is run against it and scored by survival-style distance to the real reply plus a blind
  pairwise model judge. Lives beside `packages/memory-evals`, same pattern: vitest, own scorers,
  a recorded baseline that may not drop. An installation's replay set is DATA on the owner's
  server, never in the engine repo; the engine ships a small synthetic fixture set.
- *The owner's own eye*: a monthly blind A/B in the console — two drafts for the same past
  email, the owner picks — because the automatic measures are known to disagree with each other.

**Console.** A page listing pairs side by side with the edit class, and the survival trend.

**Retention.** Pairs hold full email text. They follow ADR-0020: a retention window, inclusion in
erasure, access-controlled. Learned preferences (Part 3) keep short supporting quotes, not whole
messages.

## Part 2 — Tone by person and relationship type

**Tagging the corpus.** Each exemplar gains: the recipients it was sent to (hashed or plain per
ADR-0020's ruling — audit question), and a relationship type. Types are a small installation-
editable list (neutral default: `client`, `collaborator`, `partner`, `supplier`, `authority`,
`personal`, `unknown`). The type comes from the CRM and the vault where they already say it; the
owner sets or corrects it in the console. **Unknown stays unknown** — the agent never guesses
familiarity, and an `unknown` recipient gets the mailbox baseline and neutral wording.

One person can hold several relationships with the owner. The relationship is resolved **per
email** (which mailbox, which thread, which project), not stamped on the person once.

**Example selection — the ladder.** Up to five examples, filled in this order, same language
first: (1) the owner's own earlier emails to this person; (2) the owner's emails to the same
relationship type from this mailbox; (3) the mailbox in general. Topic similarity only orders
candidates *within* a rung; it no longer chooses the rung. Research found topic-matched examples
can make output sound *less* like the author, and nobody has published a recipient-versus-topic
test — so this ships only if it beats today's selection on the replay set.

**The card.** `voice_profile` gains optional short sections per relationship type, proposed by
the learner from that type's exemplars and accepted by the owner exactly as the card is today. A
type with too few exemplars gets no section.

**Generated text must not teach.** An exemplar whose sent text matches an agent draft with edit
class `unchanged` or `light` is excluded from the corpus and from card distillation. The corpus
is the owner's writing, not the agent's writing the owner let through.

## Part 3 — Learning from the owner's edits

Blueprint: CIPHER/PRELUDE (preferences written down from edits, retrieved by situation) plus
PROSE's verification step (check a candidate against the author's other writing). Reimplemented
in TypeScript on the AI SDK's structured output; no library adopted.

1. **Eligible pairs only:** confident match, edit class `light` or `rewritten`.
2. **Mechanical diff first** (`jsdiff`, sentence then word level), then one model call per pair
   that classifies each changed span: `style`, `factual_correction`, `new_information`,
   `changed_commitment`, `recipient_change`, `one_off`. Only `style` feeds this part;
   `factual_correction` and `new_information` feed Part 4.
3. **Candidate preferences:** a readable sentence with a scope — relationship type, person,
   language, mailbox, email purpose — and the exact before/after quotes. "To collaborators: no
   opening pleasantry." Never a fact ("mention Friday").
4. **Verification:** each candidate is checked against the owner's other sent mail in the same
   scope. Contradicted by the owner's own writing → dropped, with the reason kept.
5. **Evidence:** each pair counts once however many edits it holds; support must come from at
   least **three separate threads** (a starting number — research gives no threshold; calibrate on
   real pairs). Contradicting pairs are recorded against the candidate.
5a. **No duplicates, no nagging.** Before a candidate is proposed it is compared (embedding
   similarity, then a cheap model check) against accepted preferences, pending candidates and
   **rejected** ones. A near-duplicate of an accepted or pending item adds its evidence to that
   item instead of becoming a new one. A near-duplicate of a rejected item is not proposed again
   unless its scope differs or substantially new evidence has arrived — a rejection is remembered,
   with the owner's reason when given.
5b. **Reviewed as a batch.** One learning run produces one batch the owner can read as a whole —
   "this run suggests these four changes" — accept or reject per item or discard entirely, in
   line with ADR-0018's one-reviewable-batch-per-run rule. Which kinds of change may land without
   asking (adding an exemplar) and which always ask (a preference, a card section) is a stated
   policy table, not scattered code.
6. **Proposal, never promotion.** A supported candidate appears in the console as a proposal with
   its quotes. The owner accepts, rejects, or changes its scope. This is ADR-0018's rule applied
   to style: learning without the owner in the room may only propose.
7. **Versioning:** accepted preferences live in an add-only table; a change retires the old row
   with an end date and links the new one to it. Every `draft_run` records the preference version
   it used, so a regression can be traced and a version rolled back.
8. **Use at draft time:** preferences matching the resolved scope are added to the style input,
   most specific scope first. An explicit instruction from the owner in the turn outranks all of
   them.

9. **The list must be able to shrink.** Add-only storage does not mean an ever-growing prompt.
   Rules written to correct one model's habits can hold a better model back (the lesson
   `reply-prompt.ts` already records from ORB-176). On a model change, and otherwise quarterly,
   each active preference and card section is switched off in turn against the replay set; one
   whose removal changes nothing — or improves the score — is *proposed for retirement*. The
   owner decides; a retired row keeps its history. A hard cap on how many preferences reach one
   draft (most specific scope first) holds regardless.

**Origin.** A preference is derived from owner-written text only (the sent side of a pair, and
the owner's sent corpus). The recipient's text is never an input to steps 3–5. Per the origin
model, the classification call in step 2 reads the incoming email only as context for one pair
and writes nothing derived from it.

## Part 4 — Context, designed around the owner handing it over

1. **The steer.** One sentence to the agent — "reply to Stefan: we agreed Friday, decline
   politely" — becomes the `task` instruction and outranks everything inferred. Works for a new
   draft and for a redraft of an existing one (the pattern `meeting_followup_redraft` already
   has). This is the cheapest and most reliable context source there is.
2. **Edits that reveal missing context.** A `factual_correction` or `new_information` edit means
   the agent lacked something. Because the owner typed it, it is owner-origin: the agent may
   *propose* saving it as a note on that person's vault page (one card, accept or dismiss). It
   never saves it silently, and it never turns it into a style rule.
3. **The briefing.** A shared service that, given the recipients and thread, resolves who they
   are *in this email* and assembles a short, ranked, size-capped briefing: the active
   relationship, a few recent interactions, open commitments, unknowns — each with its source and
   date. It READS the vault, the CRM, the network service and the calendar; it creates no new
   store of people (ADR-0017: one home per piece of knowledge). A calendar invite alone is not
   evidence a meeting happened. Ambiguous identity stays unresolved rather than merged. Exposed
   so other agents can reuse it; Gmail identifiers stay in the email adapter.
   **Push a little, let the agent pull the rest.** The briefing that is always handed over is
   deliberately tiny — who this is, the relationship in this email, the last interaction, open
   commitments. Anything more is fetched on demand through the read tools the agent already has
   (`vault_search`, `network_person`, `person_lookup`, the CRM reads). Audit question: the two
   triage drafters are a single model call built by `buildReplyPrompt`, not a tool-using loop, so
   they cannot pull today — decide whether they stay push-only with the tiny briefing, or become
   a short tool-using step.

## The drafting input contract

`packages/compose-contract` gains the formal shape `reply-prompt.ts` already approximates — three
separate inputs, never blended:

| Input | Holds |
|---|---|
| `task` | The incoming email, the thread as needed, the owner's steer, output constraints |
| `context` | The briefing: resolved identities, relationship, facts and commitments with sources, unknowns |
| `style` | Card version + relationship-type section, matching accepted preferences, the ladder's examples |

Rules carried over unchanged: email and retrieved files are data, never instructions; facts in
style examples are not facts for the new reply; weak evidence falls back to the mailbox baseline.

## When something fails

Matching, tagging, the ladder, the briefing — if any of them fails, drafting proceeds as it does
today and the failure is logged and told to the model as "unavailable", never disguised as "there
was nothing" (the ORB-119 rule `voice_guide` already follows). Learning jobs are idempotent per
(mailbox, pair) so a retry cannot double-count evidence. One model call per pair, capped per run;
cost stays proportional to mail volume (the Aug-14/15 lesson).

## Engine and installation

The engine ships the mechanism, neutral relationship types, and synthetic fixtures. Pairs,
preferences, tags and the replay set are installation data on the owner's server. **Learning is
off by default** in the neutral templates, like dreaming. Nothing phones home. Migrations that
touch older tables (`voice_exemplar`, `voice_profile`, `email_triage_processed`) need those files
added to the keeper image probe and a branch CI run before main.

## Vendors and libraries (decided from the research)

- **Keep:** Vercel AI SDK (already in use) for structured output, embeddings, mock models in
  tests. It is a library; it sends nothing unless telemetry is registered.
- **Add:** `jsdiff` (npm `diff`, BSD-3).
- **Skip:** Mem0, Letta, LangMem, Zep/Graphiti, Cognee — none has a human approval step or an
  owner/recipient distinction; most need a Python service; several ship telemetry on by default.
  Borrowed ideas: add-only writes, quotes with counts, end-dated retirement, version history.
- **Skip for now:** Langfuse and promptfoo for evals; AI Gateway and hosted dashboards (not
  European-only). Prompt optimisers (Ax) at most offline, proposing items for approval.
- **Later, only if measured:** a self-hosted re-ranker (`bge-reranker-v2-m3` on TEI). No published
  Norwegian numbers exist — measure in the existing recall harness first.

## Beyond email — essays and other long-form writing

The owner asked whether the same engine could cover essays. **The process carries over; the
setup and the corpus do not.** Notes for a later spec, not scope here:

| Carries over unchanged | Differs for long-form |
|---|---|
| Card + examples (research: rules carry tone, examples carry structure) | **Scope is not a recipient.** It is a *publication and form*: e.g. `own-site essay`, `newsletter`, `LinkedIn post`. The "relationship type" slot becomes "audience and form". |
| Draft-versus-final pairs, the diff, edit classification | **The pair is different.** No Gmail. The draft is a document revision; the "final" is the published piece. Capture needs a document home with revisions (the vault, or wherever the essay is written) and a "this is published" signal. |
| Candidate preferences → verification against the owner's other writing → console proposal → versioned, add-only | **Far fewer pairs.** A few essays a year against hundreds of emails. Three-thread evidence may never arrive; long-form learning leans on the *corpus* (published work) and on explicit rules the owner states, with edits as a bonus. |
| Owner-text-only origin rule | **Units are different.** An essay edit is often structural — reordering an argument, cutting a section. Sentence-level diff misses that; classification needs a level for structure and argument, and examples must be passages, not whole pieces (the email learner already drops anything over 400 words). |
| The replay-and-judge eval pattern | **Quality is not "sounds like me".** An essay is judged on argument and insight as much as voice; survival-rate is a weaker signal. The blind A/B by the owner matters more. |
| Generated text must not teach | Same rule, more important: a published essay that was mostly agent-written must be flagged so it does not become the corpus. |

Design consequence **for this spec**: build the store and the learner scoped by a generic
`(medium, scope)` pair rather than hard-wiring "mailbox" and "recipient" — e.g. `medium = email`,
`scope = {mailbox, relationship type, person, language, purpose}` — so a later `medium = essay`
adds a corpus reader and a pair source without a second engine. Do not build anything
essay-specific now. Which agent owns long-form (the creative role, `services/creative`, or a
writer role), where essays are drafted, and whether the owner's existing voice standard file
becomes the long-form card are questions for that later spec. Note that the owner's current essay
workflow deliberately writes from one voice source and a published exemplar — which is the same
card-plus-examples shape, arrived at independently.

## Build order

1. Live Gmail probe → `draft_run` / `sent_pair` capture → console pairs page → replay set and
   baseline. *Data starts accumulating on day one; nothing else can be judged without it.*
2. Recipient and relationship tags on exemplars → the ladder, gated on the replay set →
   relationship-type card sections → exclusion of agent-written text from the corpus.
3. Edit classification → candidates → verification → console proposals → versioned preferences
   in the style input.
4. The steer (may move earlier — it is small) → save-this-fact proposals → the shared briefing.

## Open questions

1. How to store recipient identity on exemplars and pairs under ADR-0020 — plain address, or a
   stable person id from the network service with the address kept only in the email adapter?
2. Which drafters are in scope for capture at step 1: email triage, outreach-reply triage,
   meeting follow-ups, and drafts the agent makes in conversation via `gmail_draft` — all four, or
   the triage pair first?
3. The three-thread threshold and the match-confidence floor — both to be calibrated on the
   first weeks of real pairs before Part 3 is switched on.
4. Does the relationship-type list belong in the definition (`agent.json`) or in installation
   settings?
5. Where the monthly blind A/B lives in the console, and whether it is worth the owner's time
   before there are two variants worth comparing.
6. Whether the steer should be settled in step 1, since it is cheap and is the owner's most
   direct lever on the pain ranked second.

## Audit before planning

This draft was written from a read of the repo on 2026-09-19 while another session was changing
it. Before it becomes an implementation plan:

- Re-verify every file, table and migration number named above against `main`.
- Check it against any ADR or spec landed since (especially anything touching ADR-0018's
  implementation, the origin model, conversations/retention, and the console).
- Re-confirm the use cases and the build order with the owner — drafting surfaces may have been
  added or removed.
- Run the live Gmail probe first; its answer can change Part 1's matching design.
- Decide whether this needs its own ADR (likely: "style is learned by proposal, from owner text
  only, scoped by medium") or amends ADR-0018.
- Move this file to `docs/specs/2026-09-19-writing-voice-design.md` (dropping DRAFT) and commit it.
