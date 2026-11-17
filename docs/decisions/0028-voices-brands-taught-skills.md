# ADR 0028 — Voices, brands and taught skills

**Date:** 2026-11-17
**Status:** Proposed; planned, nothing in this record is built yet
**Amends:** none

## In plain language

1. Each person an installation serves gets one **profile**: how that person writes, in one place.
   The owner edits it; an agent uses it when it writes for that person.
2. The owner can make **brands** in the console: add a brand by name, rename it, remove it, and
   write how the brand sounds. When a piece of writing is for a brand, the brand's voice wins over
   the person's own.
3. A person can **teach** an agent a way of doing something ("remember how I do expense
   summaries"). What is taught is a short text, saved as a note in the Vault after the person
   approves the whole text. A taught skill adds instructions only. It never gives an agent a new
   tool or a wider reach.
4. If the text of a taught skill is changed after it was approved, agents stop using it until it
   is approved again.
5. Nothing changes for an installation until this is built. This record is what the build follows.

Terms used below, each with one meaning. The **owner** is the person an installation belongs to.
A **member** is any other person the installation accepts. A **card** is an approval an agent
shows before it acts. The **kit** is the shared package `packages/agent-kit`. `cos` stands for `services/chief-of-staff`.

## Context

The maintainers decided on 16 and 17 November 2026 how voices, brands and taught skills work.
This section records what the code does today, so the build starts from facts.

- **Voices.** A voice is a card of short text: a core description plus English and Norwegian
  notes. Cards live in PostgreSQL (`voice_profile`, `voice_exemplar` in
  `services/box/sql/001_baseline.sql`). When several cards could apply, one whole card is chosen,
  never a mix (`pickCard` in `cos/lib/voice.ts`). The tables do not record which person a voice
  belongs to; `services/box/lib/member-scope.ts` classifies them conservatively for that reason.
- **Brands.** There is no brand record. The only brand-shaped data is the `CRM_BRANDS` setting,
  which annotates the tracks the CRM already reports so that work is routed to the right track
  (`cos/lib/crm-brands.ts`). It holds no voice.
- **Skills.** Every skill today is written in code: an instruction skill is a file that eve loads
  as text (for example `cos/agent/skills/sales-outreach.ts`), listed in
  `packages/agent-kit/src/skill-grants.ts`. The never-widen check (`assertSkillsWithinGrants`)
  refuses a skill whose `requires` goes beyond the agent's grants; `grantsCover` answers the same
  question per conversation. A skill adds text and never a tool. There is no way for a person to
  teach one.
- **Outside text.** The kit records, per turn, whether the turn has read words the owner did not
  write, such as an email or a web page (`packages/agent-kit/src/origin-taint.ts`).
- **Vault.** Narrative text lives in the Vault, and the Vault's git history is the version record
  (`packages/agent-kit/src/vault-git.ts`; ADR-0017).

## Decision

### Profiles

1. **One profile per person, in PostgreSQL.** It holds the person it belongs to, a revision
   number, a common card (core, English notes, Norwegian notes), one Email card per connected
   account, an "avoid" list, and the per-language model choices the voice already has. Longer
   writing guidance, if any, is a Vault note the profile points to. The cards stay short and stay
   in the database.
2. **Whole cards, as today.** An Email card for the account in use replaces the common card; the
   two are never mixed.
3. **The owner edits a profile, and the save is the approval.** There is no propose-and-approve
   flow for profiles.
4. **Moving today's voices.** The move first writes a dry-run report and may fail there. Each
   mailbox is then matched to its connected account and its person. A mailbox with no clear
   person is held, not guessed. Writing examples keep their mailbox, language and exclusion.
   Examples marked as blended from several mailboxes stay out of retrieval. A voice learning run
   that was in progress is marked interrupted and is not restarted.

### Brands

5. **Brands are made in the console.** The owner adds, renames and removes a brand by name and
   writes its voice. A brand voice has the same card shape as a person's common card, plus an
   "avoid" list.
6. **A brand is keyed by a stable brand id**, so a rename keeps its voice. Brands are stored in
   PostgreSQL. They are not taken from, and not linked to, the `CRM_BRANDS` setting, which keeps
   its routing role.
7. **How a piece of work names its brand.** The person names the brand in the request, or the
   agent asks. An agent can list the brands.

### Which voice is used

8. **One resolver in the kit decides the voice**, for every agent, through eve's dynamic
   instructions. The voice guide tool (`cos/catalogue/voice_guide.ts`) reads through the same
   resolver. The order, highest first:
   1. policy and facts;
   2. the task's own instruction;
   3. the format or recipient (the Email card for the account in use);
   4. the brand voice, only when the work names a brand;
   5. the person's common voice;
   6. a neutral voice.

   The brand voice sits above the person's voice: when writing is for a brand, the brand wins.
9. **An unavailable voice is said, never replaced.** If a profile or brand voice cannot be read,
   the agent says so. It never writes in someone else's voice instead.

### Changing a profile or a brand voice

10. **Each change is one kit tool behind a card**, and the console form calls the same function.
    The model supplies only the target, the revision it started from, and the change. Who is
    acting, the fingerprint of the change and the card's address are worked out on the server. A
    change whose starting revision is no longer current is refused, showing the starting, current
    and proposed text; nothing is overwritten. The card rules are those of the approval ledger
    (`packages/agent-kit/src/approval-ledger.ts`), including its 24-hour limit.

### Taught skills

11. **A taught skill is a Vault note**, at `<area>/skills/<name>.md`. Its header holds `name`,
    `description`, `requires` (capability and scope, as in `skill-grants.ts`) and `fingerprint`.
    Its body is the instruction text.
12. **Text only.** No files, no scripts, no links fetched when it loads. The body is at most
    64 KiB, and at most 64 KiB of taught-skill text enters one turn. Over the limit is an error,
    never a cut.
13. **The fingerprint is the approval.** The save writes a hash of exactly the approved body into
    the header; nobody types it. When a session starts, the hash is computed again. If it
    does not match, the skill is not offered and a signal is recorded. So a note edited by hand,
    or by any write that bypassed the approved save, stops working until it is approved again. A
    test proves both sides: a changed body is not offered and the signal is recorded; a matching
    body is offered.
14. **A skill adds instructions only, never tools.** The never-widen check runs when a skill is
    saved and again when each session starts. An invalid skill fails closed: it is skipped and
    the agent keeps working.
15. **Where skills live.** A member's skills live in that member's private Vault area and are used
    only in that member's conversations. Shared skills live in the shared area and only the owner
    approves them. A member's skill becomes shared only when the owner, after the member asks, copies
    it into the shared area, behind one card; the member's own copy is untouched. The version record is the Vault
    commit; retiring a skill removes the note, and history keeps it.
16. **Which skills a conversation sees.** Per conversation, a skill is offered only when the person
    owns its area or holds a grant to it, the agent's grants cover its `requires`, its fingerprint
    matches, the conversation is not in a shared room (unless the shared-room rule in
    `packages/agent-kit/src/shared-room.ts` lists it), and the conversation is not a private
    console conversation.
17. **Saving a skill.** An agent saves a skill only through an ask-first tool whose card shows the
    whole text. If the conversation has read outside text, such as an email or a web page, the
    card says so. Saving is still allowed; the person decides with the whole text in front of
    them. There is no trial state: using a way of working before saving it is simply the
    conversation.

### Records and erasure

18. **Erasure.** A person's profile is erased with that person. Brand voices are not personal and
    are not erased with a person. Every new table this record adds is classified in
    `services/box/lib/member-scope.ts`, whose test fails a table that is not.

## Consequences

**Positive:**

- One place says how a person writes, and one place says how a brand sounds. Every agent and
  every door reads the same answer.
- A person can teach an agent without a release, and nothing taught can widen what the agent may
  do.
- A change to an approved skill that did not go through approval is caught when the next session
  starts.

**Given up:**

- Taught skills are text only. A skill that needs a file or a script cannot be taught this way.
- There is no database record per skill version; the Vault's history is the only one.

**Costs:**

- New tables for profiles and brands, and owner columns on the existing voice tables. Each is a
  migration and needs the manual image-probe run before it reaches main.
- Agents read one more thing per conversation: the taught skills the conversation may see.

## Not decided here

1. **The full brand foundation**: setting a brand up in depth, fuller brand screens and
   suggestions for a brand's foundation. These come later and build on the brand records of
   rules 5 and 6.
2. **Where the fingerprint signal is shown** to the owner (rule 13).
3. **Whether the owner sees the names of a member's private skills.** The owner never sees their
   text.
4. **Importing skills** from a package or a repository, and a member proposing a skill for the
   owner to approve. Neither is planned in this record.

## Cross-references

- ADR-0015 — agents are definitions resolved at runtime; tools per session.
- ADR-0017 — the Vault and its writable homes.
- ADR-0020 — conversations, retention and erasure.
- ADR-0023 — member authority, grants and audiences.
- ADR-0025 — one door layer; cards and the card record.
