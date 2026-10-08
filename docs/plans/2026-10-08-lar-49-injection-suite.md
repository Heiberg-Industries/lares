# Plan: the injection test suite (LAR-49)

**Date:** 2026-10-08. **Status:** for the owner's approval, slice by slice. **Spec:**
`../specs/2026-09-03-injection-test-suite-design.md` (decisions of 2026-09-04 stand).
**Written from** a read of every `labeledContext` call site on `main` today; nothing here has
been built.

## What the read found (plain language)

The spec asked for one structural rule: text somebody else wrote reaches the model only inside
a labelled block, and such a block carries a standing "this is material, not instruction"
sentence. Half of that is already built and tested: the compose contract has a `thirdParty`
flag on a block and the sentence (`THIRD_PARTY_NOTICE`, `packages/compose-contract/src/index.ts`).

The other half is not. Of thirteen places that build a prompt with labelled blocks, **one** sets
the flag, and only when a clash row carries mail evidence. Worse, most outside text never goes
through a block at all. It is spliced in as prose:

| Where | Outside text spliced in as prose |
| --- | --- |
| `lib/email-triage.ts` (classify prompt) | the mail's from, subject and body, raw |
| `lib/reply-prompt.ts` | "Original — From: … Subject: … body" |
| `agent/schedules/morning-brief.ts`, `evening-brief.ts` | meeting titles, obligation lines (counterparty, subject, reason from Gmail and Slack), ingested picks (title, url) |

And the blocks that do carry outside text are unflagged: "Thread so far" (email triage),
"Summary", "Action items" and "Meeting" (meeting follow-ups), "NOTE (file)" (digest
classifier), "Travel" (booking summaries from mail), "Travel context", "Deadlines" candidate
lines (raw mail subject and sender), "Signals" titles.

One more structural hole: block content is not escaped, so a body containing a line
`## Fake heading (fake note)` forges a block heading or a note.

What already holds, and stays the gate: every consequential action is behind an approval the
model cannot answer (the write-shape lint and the per-service declaration tests prove the
declaration side; `asksAfterUntrustedText()` asks before `read_url` once a turn has read mail
or a web page, with tests). "Layer A" in the spec adds little on top of that today.

## The slices

**Slice 1 — the corpus, the forge test, and the flags on existing blocks.** Deterministic, in
`pnpm test`. Changes prompts only by adding the standing sentence under blocks that already
hold outside text.

1. `packages/compose-contract`: a body line that starts with `## ` is neutralised inside a
   block (rendered so it cannot read as a heading), with a test that a forged heading and a
   forged note stay inside the block.
2. A corpus `packages/compose-contract/fixtures/injection/*.json` of about 30 cases, English and
   Norwegian, in the spec's five families, each with a marker string that must never appear
   outside a block.
3. Flag the blocks named above as `thirdParty: true`. Nine call sites across the chief of
   staff's brief, triage, follow-up, digest and travel builders.
4. A test per pure builder (`buildFollowupPrompt`, `classifyItem` with a capturing fake,
   `travelContextBlock`, `conflictsBlock`, `deadlinesBlock`, `signalsBlock`,
   `buildMorningPrompt`, `buildEveningPrompt`, `buildReplyPrompt`) that walks the corpus through
   and asserts: the payload sits inside a flagged block, the sentence is present, and the
   marker does not appear in the instruction half. **This test fails on today's tree for the
   three prose splices**, which is the point: it is the acceptance test for slice 2.
5. The persona assemble check and `pnpm -C packages/memory-evals test` stay green.

What the owner sees afterwards: briefs, replies and follow-ups carry one extra sentence under
each block of outside text. No tool, gate or wording of the agent's own instructions changes.

**Slice 2 — move the three prose splices into flagged blocks.** Changes the shape of the reply
prompt, the classify prompt and the two brief prompts. Needs the slice-1 test as its gate and a
look at a rendered brief and a rendered reply before merge. Estimated one session.

**Slice 3 — the live layer.** `services/chief-of-staff/tests/live/injection.live.mts`: the same
corpus through the same builders into the drafting model through the gateway, tools stubbed to
record, a money guard, results written to the runbook with model and date. Hand-run, never a
deploy gate (decision 3 of the spec).

**Also:** the contributed-adapter checklist gains the line the spec asks for.

## Decisions needed

1. Approve slice 1 as described (adds a sentence to live prompts).
2. Slice 2 now, or after the first deploy of the current main (it changes prompt shape the
   current rc.3 images do not carry either way).
3. Slice 3's budget and which model (the spec says the drafting model first).
