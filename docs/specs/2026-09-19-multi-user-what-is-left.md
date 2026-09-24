# What is still single-member — written down

**Date:** 2026-09-19. **Written for:** the owner, first; second, whoever builds multi-user next.
**What this is:** a description of what happens **today**, not a task list. A task list goes
stale the first time someone fixes one line of it; a description of behaviour stays true until
the behaviour actually changes, and this document's own test (`multi-user-inventory-agrees.test.ts`)
fails the day a new table or a new "the owner" environment variable appears without being added
here.

**What this is not:** a decision. Nothing below tells the owner what multi-user should look like.
Part 3 lists the choices only the owner can make; everything else is a plain report of what the
code does right now.

---

## Part 1 — For the owner, in one page

**What "multi-user" will mean.** Today, one installation of Lares serves exactly one person. The
identity register — the one table that already knows "this Slack id, this Telegram number, this
email address are all the same human" — is built and correct. What is missing is not a place to
put a second person's name; it is **routing**: which door speaks to which member, which
schedule's reminder goes to whose phone, whose deadlines a page shows, and whose words a fact,
a note, or an overnight observation belongs to.

**What already works today, for more than one person.**

- **Logging into the console.** `CONSOLE_ALLOWED_EMAILS` is a genuine comma-separated allow-list —
  several named people can already sign in.
- **A vault note can already say whose it is.** A note's frontmatter can carry `scope: private`
  plus `owner: <person>`, or `scope: participants` plus a list of people — and the tool the agent
  itself uses to read a note (`readNote`) already hides a `private` note from anyone but its
  declared owner, and a `participants` note from anyone not named. This is live code, not a plan.
- **The agent can already tell who is chatting**, when that person's channel identity (their Slack
  id, their Telegram number) is registered as an alias of a real person: the vault's own read tool
  resolves "who is asking" through the identity register on every turn.
- **Google can already hold two people's separate mailboxes** in the same table, side by side — a
  database change made months ago for exactly this reason.
- **A per-member spending cap already has a column** (`org_member_policy.spend_cap_usd_month`) —
  nothing reads it yet, but the household-billing question already has a place to be answered.

**What would go wrong today if a second member were simply added to the identity register** — each
of these was checked against the running code, not assumed:

1. **Both members would see, and could each overwrite, the same standing facts, deadlines,
   reminders, quiet hours, spending ceiling, and market watchlist.** The library code that reads
   and writes these already takes "whose" as a parameter — but almost every place that calls it
   passes one fixed, configured value instead of asking who is actually speaking. A second
   member's "remember this" would file under the first member's name; their own "what do you know
   about me" would read the first member's facts back to them.
2. **The nightly learning could not tell whose preference a row is, for anything written before
   the second member arrived, and — by its own explicit rule — refuses to guess once there are two
   members.** Those rows are left blank forever, on purpose, rather than guessed at. Nothing that
   reads them today filters by owner either, so even correctly-labelled preferences from two
   different people would be pooled together as if they were one person's.
3. **Only the first Telegram id in the list receives the agent's own scheduled messages** — the
   morning brief, the evening brief, the weekly summary, deadline reminders. A second member can
   already talk to the agent on Telegram; they will never receive anything the agent sends on its
   own initiative.
4. **The agents' doors answer to one shared approver list per channel, not to a specific member.**
   Anyone on that list can approve any gated action the agent proposes — there is no way today to
   address "please confirm this" to the specific person it concerns.
5. **A permission dial (how much an agent may do unattended) is one dial per agent for the whole
   installation.** Raising it for one member raises it for everyone who talks to that agent.
6. **Connecting a second person's Google account from the console files it under the one
   configured owner, not under whoever actually clicked "connect."** The database could hold both
   mailboxes correctly; the console's own connect button does not ask whose it is.
7. **A vault note with no owner marker, once there are two members and the note is not in an
   obviously shared folder, is quietly skipped by the "did I forget this file" check** — not an
   error, just silence. The very people who most need that protection — two members with private
   notes — are the ones a missing marker leaves unprotected.

**What is not broken by this.** Erasing or exporting a person, and the "forget a file" guard, were
both explicitly redesigned this round specifically so they do not silently do the wrong thing —
they are described fully in Part 2 below. Erase-a-person and export-a-person are not built yet at
all; this round of work is what makes them buildable honestly, not the features themselves.

**Rough sizing, in three buckets.** No estimate below is more precise than this:

- **Small (days).** Anywhere the data is already shaped for more than one person — standing
  facts, agent notes, memory read/use records, the register itself — and the only change is
  making a call site ask "who is speaking" instead of reading one fixed name.
- **Medium (a week or two).** Anywhere the shape is right but the wiring touches several
  services at once — fanning schedule pushes out to every member's own chat, giving the console
  a real per-member view, teaching the Google-account connect flow to ask whose account it is.
- **Large (needs design first).** Anywhere there is no safe mechanical fix: the vault's
  per-member folders and sharing rules do not exist yet; the forget ledger's old entries can
  never be relabelled if a person's key ever changes; and several real decisions — can members
  see each other's approvals, is there one household bill or one per member — have to be made by
  a person, not inferred from the code.

---

## Part 2 — What is left, by area

Every row below was checked against the code on this branch. Reference letters (A1, B3, …) are
resolved to file and line in the Appendix, so this table stays readable.

### A — Who the person is

| # | What it is | What happens with two members today | What has to change | Size | Depends on |
|---|---|---|---|---|---|
| A1 | Three independent copies of `ownerId()` (chief-of-staff, travel, console), each with the same hard-coded fallback name | All three still agree, because they share the same literal — so every write and every gated approval in the whole fleet funnels through one configured string, never "whichever member is acting" | Converge the three into one shared module, and make it resolve a real per-turn speaker where one exists (the vault's read tool already does this — see C2/C3) instead of reading one fixed key | Medium | none |
| A2 | The env override (`AGENT_OWNER_USER_ID`) vs. the identity register | `checkOwnerKeyAgreement` only checks the configured key against the register once per process, and only reports agree / disagree / several-members / register-unreadable — it does not route a second member's actions under their own id | Replace "the one configured id" with "the id of whoever is speaking this turn" at every write site | Medium | A1 |
| A3 | Five remaining legacy "principal" tables: `digest_requests`, `workflow_jobs`, `meeting_followup_sent`, `agent_door_connections`, `agent_door_claim_audit` | Reachable only through the resolver's alias list, not by a direct column match; an erase or export must ask the resolver first | Left for after launch on purpose (frozen list, may only shrink); migrate later or accept the resolver reaches them | Small (once undertaken) | resolver (built) |
| A4 | The identity register itself (`users`, `user_aliases`) and the resolver (`resolvePerson`, `spellingsFor`) | Already correct for more than one person — this is the one part of the system built for the destination state, not the current one | Nothing — this is the foundation the rest of the list stands on | Done | — |

### B — Memory

| # | What it is | What happens with two members today | What has to change | Size | Depends on |
|---|---|---|---|---|---|
| B1 | Standing facts (`standing_facts.user_id`) | The table and its queries already scope every read and write by a person id — genuinely ready at the data layer. But `remember`, `forget`, and the facts shown in every conversation all pass the one fixed configured owner, never the speaking member | Make every call site pass a resolved speaker instead of the fixed key | Small, once A2 exists | A2 |
| B2 | Agent notes, memory-use records, memory-read records (`agent_notes.owner`, `memory_use.owner`, `memory_reads.owner`) | Same shape as B1: the library functions already take an explicit `owner` argument; the call sites pass the fixed key | Same fix as B1 | Small, once A2 exists | A2 |
| B3 | Dream observations and preferences (`dream_observations.owner`, `dream_preferences.owner`) | A nullable `owner` column exists; the labelling step deliberately refuses to guess and leaves rows `NULL` the moment more than one member exists; and nothing that reads these tables filters by owner at all today, labelled or not | Decide what a mixed-owner or `NULL` row means, add an owner filter to every reader (weekly summary, the promotion gate), and stop the nightly reflection from treating every human turn as "the owner" speaking | Medium–large (touches the learning gate's meaning, not just plumbing) | none blocking |
| B4 | The forget ledger (`forget_ledger.owner`, hash-only) | The one table box 083 deliberately did not normalise: its hash is derived from the owner string itself, and the forgotten words are never stored, so a row can never be re-keyed | If a second member's identity key ever needs separating from the first's, existing rows silently stop protecting; no safe fix exists today (a lookup under a person's other known spellings was considered and not built) | Large — no mechanical fix, needs a decision | resolver (built) |
| B5 | Memory proposals (`memory_proposals`) | No person column; reached only by resolving the row or the ref it points at (a standing fact, a preference) | Reachable already through the tables it points at; no change needed beyond what B1/B3 already require | Small | B1, B3 |

### C — The vault and sync

| # | What it is | What happens with two members today | What has to change | Size | Depends on |
|---|---|---|---|---|---|
| C1 | Per-member vault folders (`private/<member>/`, planned by ADR-0017) | Do not exist yet. The forgotten-file guard has a rule ready for them that matches nothing until they exist — harmless, not broken | Design and build the folder convention, and migrate or leave existing notes | Large — needs design (what moves, what a write tool defaults to) | none |
| C2 | Frontmatter owner markers (`scope:`, `owner:`, `participants:` on a note) | **Already live and enforced on reads.** The read tool hides a `private` note from anyone but its declared owner, and hides a `participants` note from anyone not listed. Almost no existing note carries these keys yet, because today's vault predates a second member | Backfill the keys onto notes that need them, and make the write tools set them automatically | Small | none |
| C3 | The forgotten-file guard's per-path ownership check (four rules, tried in order) | Rule 1 (the note's own frontmatter owner) and rule 3 (there is only one member) work today. Rule 2 (a `private/<member>/` folder) matches nothing until C1 exists — dead code, not broken code. Rule 4 (several members, no marker) is the honest "I don't know" the guard already returns, and it fails open (the sync proceeds; the forget check is skipped for that one file) | Nothing in this file needs to change; once C1 exists, rule 2 starts working with no further edit here | None (already correct) | C1 |
| C4 | Notion and Atlas sync-state tables with no person column (`notion_sync_docs`, `notion_sync_proposals`, `notion_sync_fidelity`, `atlas_notes`, `atlas_proposals`) | Reached only by resolving the vault path first — with two members, a shared path's sync state genuinely belongs to nobody, and a private path's is only as attributable as C2's frontmatter makes it | No table change; an export or erase reaches these through the vault path, which this track already designed for | None additional | C1, C2 |
| C5 | Cross-member sharing (`cross_member_grants`, `cross_member_reads`, `org_member_policy`) and one organisation per installation (`orgs`) | Built (box 028/029) and genuinely unused — no code outside tests reads or writes any of these three tables today | Wire them in once there is a second member to grant something to | Medium, once needed | A2 (needs a real second speaker to grant to) |

### D — The doors (Telegram, Slack, web)

| # | What it is | What happens with two members today | What has to change | Size | Depends on |
|---|---|---|---|---|---|
| D1 | Telegram's primary chat (`TELEGRAM_PRINCIPAL_ID`, parsed as a comma-list, but only the first id used for outgoing pushes) | More than one Telegram id CAN start a conversation with the agent today. But every schedule-initiated message — morning brief, evening brief, weekly summary, deadline nudges, the default reminder destination — goes to the first id in the list only | Give every schedule a per-member destination instead of "the first configured chat" | Medium | A2 |
| D2 | The daily Telegram session (`telegram_daily_log`, `telegram_session_rotation`) | Keyed by chat id, not by member. Two members in the same chat interleave into one rotation and one daily summary as if they were one person; two members in separate chats get separate rotations, but only the primary one (D1) receives scheduled pushes | Key the rotation by (chat, member) once a member can be resolved per turn | Medium | A2, D1 |
| D3 | Slack's allow-list (`SLACK_ALLOWED_USER_IDS`) | A flat list with no per-member routing — but Slack already scopes by channel or DM, so this matters less than Telegram's single-destination default | No urgent change to the list itself; per-member settings still need a destination per member | Small | E |
| D4 | The web door (console) | Login already supports several named people (`CONSOLE_ALLOWED_EMAILS`); every write still lands under one configured owner value, and the code's own comment already names the fix: "resolve the principal from the authenticated session" | Do exactly what the comment says | Medium | A2 |
| D5 | Approver lists (who may confirm a gated action) | One allow-list per channel; anyone on it can approve anything the agent proposes for anyone. There is no rendering of "this approval concerns member B" | Scope an approval to the member the action concerns, not just to the channel it arrived on | Medium–large (also touches how the approval card itself is rendered — a known limit today) | A2, F |

### E — Schedules and proactivity

| # | What it is | What happens with two members today | What has to change | Size | Depends on |
|---|---|---|---|---|---|
| E1 | Schedule hours (`schedule_settings`, one row per installation per schedule) | Changing "when the morning brief runs" changes it for every member of the installation | Key by member, and give the console a per-member control | Medium | A2, D4 |
| E2 | Proactivity settings, the daily ceiling, the owner clock (`proactivity_settings`, `initiations`, `owner_clock_signals`) | One quiet-hours window, one do-not-disturb flag, one daily message ceiling, one clock, for the whole installation. The code's own comment already names the failure: a mismatch "would give a second owner their own quiet hours and their own ceiling while the console showed the first one's" | Key by member | Medium | A2, D4 |
| E3 | Deadlines and markets settings (`deadlines`, `deadline_candidates`, `deadline_settings`, `markets_settings`) | Same single-installation pattern. Two of these columns (`deadlines.owner`, `deadline_candidates.owner`) still carry a hard-coded owner name as the schema default, not just in code | Key by member; the literal schema defaults are already flagged (separately, for the wave-9 naming clean-up) for removal | Medium | A2 |

### F — Approvals and the permission ratchet

| # | What it is | What happens with two members today | What has to change | Size | Depends on |
|---|---|---|---|---|---|
| F1 | The permission ratchet (`ratchet`, `ratchet_audit`) — how much an agent may do unattended, per capability | No member column at all. A permission level applies to every door and every member talking to that agent. Whoever last changed it is recorded (`updated_by`/`changed_by`) as an audit label only, never as a scope | Requires a real decision first (Part 3, Q4) — whether a permission level should ever differ by member — before any plumbing is built | Large (decision, then build) | Part 3 Q4 |
| F2 | The approval re-check (`assertApprover`) | Checks a raw channel id against a flat per-channel list; has no concept of which member an action concerns | Needs D5's per-member approval scoping to mean anything more targeted | Medium | D5, A2 |
| F3 | The approval ledger (`approval_asks`, box 086) — what was asked, and what the owner answered | No member column at all, deliberately: `answered_via` names the door ("telegram", "slack"), never a person, because the approver list is still one env-configured list per channel, not per member. What happens today: an approval rate is computed across the whole installation, not per member | When the approver list becomes a member list this table gains a `member` column of kind `registry` (and a migration to fill it), the same pattern as every member-scoped table above | Small, once D5/A2 exist | D5, A2 |

### G — The console

| # | What it is | What happens with two members today | What has to change | Size | Depends on |
|---|---|---|---|---|---|
| G1 | Pages scoped to one owner with no member selector: Deadlines, Proactivity (quiet hours, do-not-disturb, ceilings, brief language, schedule hours), Markets, and the Google-account "remove" action on the Integrations page | Every one of these reads or writes through the console's own `ownerId()`, which falls back to a hard-coded name if nothing is configured | Give each page a member selector, or default to "whoever is logged in" once G3 resolves a session to a member | Medium, once G3 exists | G3 |
| G2 | Pages that are correctly installation-wide, not a member gap: Backup status, Voice (mailbox-scoped, not member-scoped), Taste (single-writer by explicit design), Signals, Meetings, the Fleet/Agents pages | Nothing to fix here — these are not "single-member" bugs, they describe the installation, not a person | None | n/a | n/a |
| G3 | `app/actions/accounts.ts`'s own comment: "v1 is single-principal; when real multi-user lands, resolve the principal from the authenticated session here" | The console can already log in several named people, but nothing it writes uses which one is logged in for anything beyond an audit column | Do exactly what the comment says: resolve the acting member from the session | Medium | none blocking |
| G4 | A console Memory page | Built for, in the library layer (`listMemory` exists "for a future console Memory page"), but no such page exists in `services/console/app` today | Not a single-owner bug — a feature not yet started | n/a (not started) | n/a |

### H — Integrations and secrets

| # | What it is | What happens with two members today | What has to change | Size | Depends on |
|---|---|---|---|---|---|
| H1 | The Google-token table's shape (`oauth_tokens`, unique on principal + provider + mailbox) | Already relaxed, months ago, specifically so one person can hold more than one mailbox — and by extension, two different people's mailboxes can already sit in this table side by side | Nothing — the schema is not the gap | Done | — |
| H2 | Which principal a Google connection is filed under | Every running service reads ONE environment variable for its whole lifetime (its own configured principal), and the console's own "connect a Google account" button always stamps the one configured value, regardless of who clicked it | Let the connect flow ask, or infer, which member a new connection belongs to | Medium | G3 |
| H3 | `integrations/installation.json` (organisation and agent-instance config; no member axis at all) | Correctly has no member concept — a household shares which vendors it uses; only the Google mailbox differs per member (H2) | Keep the "no member axis" shape when this file leaves the engine (already planned, for an unrelated reason) | Small, once H2 exists | H2 |

### I — Export and erase

| # | What it is | What happens with two members today | What has to change | Size | Depends on |
|---|---|---|---|---|---|
| I1 | Erase-a-person and export-a-person | **Not built at all yet.** This entire round of work (the resolver, the inventory, the two migrations) exists to make these two features buildable honestly — neither exists as a command today | Build them (the next wave's work) on top of the resolver and inventory this round produced | Not sized here — it is the next wave, not this list | resolver + inventory (done) |
| I2 | The six "actor" audit columns (`ratchet.updated_by`, `ratchet_audit.changed_by`, `keeper_audit.actor`, `settings.updated_by`, `settings_audit.changed_by`, `voice_profile.updated_by`) | The owner has already ruled: an erase replaces the name with the fixed word `erased`, keeping the audit trail rather than deleting it. **Not implemented anywhere yet** — there is no code today that writes `erased` into any of these columns | Build it into the erase command when I1 is written | Small, once I1 exists | I1 |
| I3 | Tables that can only be cleared as a whole, never per member | `voice_exemplar` has no person or mailbox column at all — nothing to join on — so on a single-member installation it is cleared whole and correctly attributed; with two members it is not attributable to either. The forget ledger's pre-existing rows have the same limit for a different reason (B4) | `voice_exemplar` needs its own column (or an accepted, stated limit); the forget ledger has no safe fix | Medium (voice_exemplar); Large (forget ledger) | none |

---

## Part 3 — Decisions the owner will have to make before multi-user is built

Nothing here is decided. Each is a real question with real options; a recommendation is offered
only where the code already leans one way.

**Q1 — Is a household one shared vault with private areas, or one vault per member?**
- (a) One shared vault: a `private/<member>/` area per person, plus `shared/` and `atlas/` areas
  everyone can see. This is what ADR-0017 already describes.
- (b) A fully separate vault per member, with an explicit way to share a note across vaults.
- *Leaning:* (a) — it is the already-approved design, and the frontmatter mechanism (`scope:`,
  `owner:`, `participants:`) that already works today (C2) was built assuming one shared vault.

**Q2 — Can members see, or approve, each other's pending confirmations?**
- (a) Fully private: one member's approvals are invisible to another.
- (b) Fully visible: anyone on the household's approver list can see and approve anything — this
  is what happens today, because approvals are scoped to a channel, not to a member.
- (c) Visible to a designated household administrator only.
- *No leaning offered* — this is a genuine household-trust question.

**Q3 — Is there one shared spending ceiling, or a cap per member?**
- (a) One shared ceiling for the household (today's behaviour).
- (b) A cap per member — a column for exactly this (`org_member_policy.spend_cap_usd_month`)
  already exists and is already unused.
- (c) A household ceiling with a per-member sub-cap under it.
- *No leaning offered*, beyond noting that (b)'s column is already there, waiting.

**Q4 — Should the permission ratchet (how much an agent may do unattended) ever differ by member?**
- (a) No — one dial per agent, the same for everyone who talks to it (today's behaviour).
- (b) Yes — a dial per agent, per member.
- (c) A middle ground: a member may only approve or raise autonomy for actions that concern
  themselves, never another member's.
- *No leaning offered.*

**Q5 — What happens to a founding member's existing history when a second member joins?**
- (a) Left as the household's shared, unattributed history — exactly what the dream tables already
  do for rows written before a column existed: labelled only when there was exactly one member at
  the time, otherwise left blank on purpose rather than guessed at.
- (b) Everything is attributed to the founding member.
- (c) The owner reviews and reassigns by hand.
- *Leaning:* (a), only because it is the precedent this round already set for the one place this
  exact question already came up (box 084's dream-row labelling rule).

**Q6 — Does each door serve one shared chat, or one chat per member?**
- (a) One shared chat or channel; the agent tells members apart by who is speaking within it.
- (b) One door instance per member, each with its own scheduled pushes.
- *No leaning offered* — note that today's Telegram env var is already a list of ids (so (b) is
  partially wired for inbound messages already), but nothing fans scheduled pushes out to more
  than the first entry (D1).

---

## Part 4 — The order this would be built in

1. **Converge the three `ownerId()` copies (A1) and make writes resolve a real speaker.** This one
   change is what every "small" item in Memory (B1, B2) and most of Doors/Schedules/Console
   depends on — it is the single highest-leverage step.
2. **Wire the resolved speaker into standing facts, agent notes, and the memory read/use
   records (B1, B2, B5).** Mechanical once step 1 exists; nothing here needs new schema.
3. **Build erase-a-person and export-a-person (I1).** This is independent of steps 1–2 — the
   resolver and inventory this round produced already make it buildable, and it does not need to
   wait for anything above.
4. **Fan Telegram (and any per-member) scheduled pushes out to every member's own destination
   (D1, D2).** Needs step 1.
5. **Build the vault's per-member folders and backfill frontmatter owner markers onto existing
   notes (C1, C2 backfill).** Unblocks the forgotten-file guard's dormant second rule (C3) with no
   further code change there, and gives export/erase a real per-member vault to work from.
6. **Answer Q5 (what happens to a founding member's existing history), then filter every dream
   and preference read by owner (B3).** The decision has to come first — filtering before the
   decision is made would just be a different guess.
7. **Give the console a real per-member view: resolve the session to a member (G3), then scope
   Deadlines, Proactivity, and Markets to it (G1).** Needs step 1.
8. **Teach the Google-account connect flow which member it is connecting for (H2).** Needs step 7.
9. **Answer Q2 and Q4 (approvals, permission levels), then build per-member approval scoping and,
   if the answer calls for it, a per-member ratchet (D5, F1, F2).** These are decisions before
   they are slices — building the plumbing before the decision would bake in a guess.
10. **Answer Q3 (shared vs. per-member spending) and wire `org_member_policy.spend_cap_usd_month`
    if the answer calls for a per-member cap.** The column already exists; nothing reads it.

---

## Appendix

### The four frozen lists, as they stand today (`services/box/tests/member-scope-inventory.test.ts`)

These may only **shrink**. A slice that fixes one of these tables removes it from its list in the
same change; a new table using one of these kinds without being added here fails the test.

- **`LEGACY_PRINCIPAL_TABLES` (5):** `digest_requests`, `workflow_jobs`, `meeting_followup_sent`,
  `agent_door_connections`, `agent_door_claim_audit`.
- **`LEGACY_OWNER_KEY_TABLES` (1):** `forget_ledger`.
- **`FROZEN_ACTOR_TABLES` (6):** `ratchet`, `ratchet_audit`, `voice_profile`, `keeper_audit`,
  `settings`, `settings_audit`.
- **`LEGACY_COLUMNLESS_TABLES` (7):** `memory_proposals`, `voice_exemplar`, `notion_sync_docs`,
  `notion_sync_proposals`, `notion_sync_fidelity`, `atlas_notes`, `atlas_proposals`.

The full inventory (`services/box/lib/member-scope.ts`) holds **71 entries**: 42 `member`, 22
`operational`, 7 `resolved`. Of the 42 `member` tables, 30 use `idKind: "registry"`, 5 use
`"principal"`, 1 uses `"owner-key"`, and 6 use `"actor"` (5 + 1 + 6 + 30 = 42, matching the four
lists above exactly). The 21st `operational` table is `approval_asks` (box 086, W7A-s4) — see F3.
The 22nd is `update_history` (box 087, W8D-s2): which image digests were running before an
update, so a rollback has something to put back. It carries no member concept at all, and none is
owed — an update or a rollback replaces every image the release names for the whole installation
at once, never one member's software; there is no "whose update" the way F3's approval rate is at
least computed per agent and tool.

### File and line references for Part 2

**A1/A2** — `services/chief-of-staff/lib/principals.ts:40-43` (`ownerId`, with a hard-coded
fallback name); `services/travel/lib/principals.ts` (byte-identical `ownerId`, its own doc comment:
"Lares multi-owner (sub-project 8) is what replaces the fallback"); `services/console/lib/proactivity.ts:350-352`
(a third copy, missing the other two's `LARES_AGENT_INCARNATION` fail-closed check);
`services/chief-of-staff/lib/identity-client.ts` (`canonicalUserId`, `CANONICAL_USER_ID`,
`checkOwnerKeyAgreement`, `OwnerKeyAgreement`).
**A3** — `services/box/lib/member-scope.ts`'s `LEGACY_PRINCIPAL_TABLES` comment; `services/box/sql/003_digest.sql`,
`005_workflow_jobs.sql`, `027_meeting_followup.sql`, `044_agent_door_connections.sql`.
**A4** — `services/box/lib/person-identity.ts` (`resolvePerson`, `spellingsFor`,
`unresolvableValues`); `services/box/sql/014_identity.sql`.

**B1/B2** — `services/chief-of-staff/lib/standing-facts.ts` (`WHERE user_id = $1` scoping,
verified directly); `services/chief-of-staff/catalogue/remember.ts`, `catalogue/forget.ts`,
`agent/instructions/standing-facts.ts` (all import and pass `CANONICAL_USER_ID`);
`services/chief-of-staff/lib/agent-notes.ts`, `lib/memory-reads.ts` (owner is an explicit
parameter, not hardcoded, in the library functions themselves).
**B3** — `services/chief-of-staff/lib/dream/store.ts` (`ensureDreamTables`'s `ADD COLUMN IF NOT
EXISTS owner`; `labelExistingDreamRows`'s `skippedBecauseSeveralMembers` return when
`memberCount !== 1`; `activePreferences()`'s `SELECT * FROM dream_preferences WHERE valid_to IS
NULL` — no owner filter); `services/box/sql/084_dream_tables_owner.sql`;
`services/chief-of-staff/lib/dream/reflect.ts`'s `speakerLabel` (returns the literal string
`"the owner"` for any non-scheduled turn).
**B4** — `packages/vault-format/src/forget-ledger.ts` (`forgetKey`, `assertCanonicalOwner`,
the file's own header on why an owner rewrite would break every existing row);
`services/box/sql/083_owner_key_is_the_register_id.sql` (excludes `forget_ledger` by name).
**B5** — `services/box/sql/072_memory_proposals.sql`; `services/box/lib/member-scope.ts`'s
`memory_proposals` entry (`reachedBy`).

**C1/C3** — `docs/decisions/0017-the-vault.md:62-63` ("one folder per member once a second member
exists"); `services/notion-sync/lib/path-owner.ts` (the full four-rule `ownerOfPath` function, its
header explaining which rules are live and which wait on ADR-0017's folders).
**C2** — `packages/agent-kit/src/notes-store.ts` (`noteScope`, `visibleTo`, `readNote`); this
mechanism is separate from `lares_origin` (`packages/vault-format/src/origin.ts`), which is a
trust/provenance stamp (owner/agent/synced/third_party/system), not a per-member marker — the two
are easy to conflate and are not the same thing.
**C4** — `services/box/sql/015_notion_sync.sql`, `016_notion_sync_phase3.sql`,
`019_atlas_sync.sql` (all five `CREATE TABLE` statements read in full; none has a person column).
**C5** — `services/box/sql/028_orgs.sql`, `029_cross_member.sql`; `packages/agent-kit/src/cross-member.ts`
(no importer found outside its own test file).

**D1/D2** — `services/chief-of-staff/lib/principals.ts` (`primaryTelegramChatId`, returns
`allowedPrincipalIds("telegram", env)[0]`; called from `agent/schedules/morning-brief.ts`,
`evening-brief.ts`, `weekly-summary.ts`, `proposals-watch.ts`, `reping.ts`, `deadlines.ts`,
`catalogue/remind_set.ts`); `services/box/sql/020_telegram_session_rotation.sql` (both tables keyed
by `chat_id` alone); `services/chief-of-staff/lib/telegram-rotation.ts`.
**D3** — `services/chief-of-staff/lib/principals.ts` (`allowedPrincipalIds`, `SLACK_ALLOWED_USER_IDS`);
`services/chief-of-staff/agent/channels/slack.ts` (`isAllowedSlackUser`).
**D4** — `services/console/lib/auth.ts` (`allowed()`, `CONSOLE_ALLOWED_EMAILS`);
`services/console/lib/accounts.ts` (`CONSOLE_PRINCIPAL`); `services/console/app/actions/accounts.ts:16-18`
(the comment quoted verbatim in G3 below).
**D5/F2** — `services/chief-of-staff/lib/approvals.ts` (`assertApprover`, `approverFrom`); no
dedicated approval-card renderer file exists in this repository — the card comes from eve's own
built-in rendering, which carries no member concept.

**E1** — `services/box/sql/065_schedule_settings.sql` (`PRIMARY KEY (owner, schedule)`);
`packages/agent-kit/src/schedule-settings.ts`; `services/chief-of-staff/lib/schedule-hours.ts`.
**E2** — `services/box/sql/035_proactivity.sql`; `services/chief-of-staff/lib/principals.ts`'s own
comment ("A mismatch would give a second owner their own quiet hours and their own ceiling while
the console showed the first one's").
**E3** — `services/box/sql/036_deadlines.sql` (`deadlines.owner text NOT NULL DEFAULT '<a hard-coded owner name>'`;
`deadline_candidates.owner text NOT NULL DEFAULT '<a hard-coded owner name>'` — verified directly by reading the file).

**F1** — `services/box/sql/008_ratchet.sql` (`PRIMARY KEY (agent, capability, action)`, no member
column); `services/box/sql/038_permissions_board.sql` (`ratchet_audit`, same key shape);
`services/console/app/actions/autonomy.ts` (`setAutonomy`, records the console session's email as
`updated_by` only).

**G1/G3/G4** — full page list read directly from `services/console/app/`: `page.tsx` (Fleet),
`activity`, `agents/[name]` (+ `edit`, `new`), `backup`, `deadlines`, `integrations`, `markets`,
`meetings`, `proactivity`, `signals` (+ `catalogue`, `rules`), `taste`, `voice`. Owner-scoped:
`app/deadlines/page.tsx` → `lib/deadlines.ts`'s `getDeadlinesView()`; `app/proactivity/page.tsx` →
`lib/proactivity.ts`; `app/markets/page.tsx` → `lib/markets.ts`; the Google-account remove action
on `app/integrations/page.tsx` → `app/actions/accounts.ts`'s `removeAccount`. Not owner-scoped, and
correctly so: `app/backup/page.tsx`, `app/voice/page.tsx` (mailbox-keyed), `app/taste/page.tsx`
(`lib/taste-store.ts`'s own comment: "the only writer in v1 — no agent writes it"),
`app/signals/*`, `app/meetings/page.tsx`. **No console Memory page exists** — grepped for and not
found; `packages/agent-kit/src/memory-read.ts`'s `listMemory` has exactly one consumer today
(`services/chief-of-staff/catalogue/memory_used.ts`), not a console page.

**H1/H2** — `services/box/sql/006_oauth_tokens.sql` (original `UNIQUE (principal, provider)`);
`services/box/sql/010_oauth_tokens_multi_account.sql` (relaxes it to
`UNIQUE (principal, provider, email_address)`, its own comment: "so one principal can hold several
Google accounts"); `services/chief-of-staff/lib/google.ts`'s `googleClients()` (defaults to
`process.env["GOOGLE_PRINCIPAL_ID"]`); `services/console/app/api/accounts/google/start/route.ts`
(stamps every new connection with the one `CONSOLE_PRINCIPAL_ID`).
**H3** — `integrations/installation.json`'s own `_README` block, read in full; instances are keyed
by organisation or agent persona, never by household member.

**I1** — confirmed by searching this repository for any erase or export implementation: none
exists (`find . -iname "*erase*"` returns nothing outside this plan's own documents).
**I2** — confirmed by searching for the literal replacement string: no code writes `'erased'` into
any column anywhere in this repository today.
**I3** — `services/box/sql/013_voice.sql:27-36` (`voice_exemplar`'s columns:
`id, lang, text, vector, source_message_id, included, created_at` — no person, no mailbox).

### Environment variables named as "the owner," one value per installation (not per member)

`AGENT_OWNER_USER_ID`, `GOOGLE_PRINCIPAL_ID`, `NOTION_SYNC_PRINCIPAL`, `CONSOLE_PRINCIPAL_ID`,
`TELEGRAM_PRINCIPAL_ID` (a comma-list for inbound identification, but only its first entry is used
for outbound pushes — see D1), `SLACK_ALLOWED_USER_IDS` (a genuine list, but with no per-member
routing behind it — see D3), and `OWNER_HOME_TZ` (one timezone for the whole installation's clock).

### What was verified directly, and what came from delegated but still file-grounded reading

This document's author opened and read, in full, the following before writing the tables above:
`services/box/lib/member-scope.ts`, `services/box/tests/member-scope-inventory.test.ts`,
`services/box/lib/person-identity.ts`, `packages/vault-format/src/forget-ledger.ts`,
`services/notion-sync/lib/path-owner.ts`, `services/chief-of-staff/lib/principals.ts`,
`services/travel/lib/principals.ts`, `services/console/lib/proactivity.ts`,
`services/chief-of-staff/lib/identity-client.ts`, `packages/agent-kit/src/notes-store.ts`,
`packages/agent-kit/src/note-tools.ts`, `services/box/sql/006_oauth_tokens.sql`,
`services/box/sql/010_oauth_tokens_multi_account.sql`, `services/box/sql/028_orgs.sql`,
`services/box/sql/029_cross_member.sql`, `services/box/sql/083_owner_key_is_the_register_id.sql`
(header and dry-run section), `docs/decisions/0017-the-vault.md`, `integrations/installation.json`,
the full `services/console/app/` directory tree, and every `docs/decisions/*.md` filename (to
verify the ADR-0009 gap independently — see below).

The remaining file-and-line citations in this appendix (the console's action files, the schedule
call sites for `primaryTelegramChatId`, the exact wording of `app/actions/accounts.ts:16-18`, the
full `oauth_tokens` write-path trace) were gathered by three focused, read-only passes over this
same worktree, each instructed to open the actual file and quote real code rather than infer from
a comment — not taken from the wave notes or the plan without checking. Every citation from those
passes that overlapped with this author's own direct reading (the three `ownerId()` copies, the
`oauth_tokens` constraint history, `resolveInstallationOwner`'s removal, the sync tables' columns)
matched exactly.

Two claims were taken from the wave-3 notes and the plan **without** re-verification, because they
describe process rather than code: the build order in Part 3 of the identity plan, and the
existence of the earlier "multi-user substrate" design spec
(`docs/specs/2026-08-31-lares-org-and-multi-user-design.md`, marked "approved for build") that
`packages/agent-kit/src/notes-store.ts` and `note-tools.ts` implement — its file was not opened by
this document's author, only the code it produced.

### Open contradictions and corrections found while writing this

1. **The "server-side readers only" console rule describes future work by this track, not the
   current console.** The identity plan's own rule ("No console page. The console is planned as
   data plus server-side functions only") refers to what THIS track may add to the console — it
   adds none. The console itself already has a full read-and-write surface today
   (`app/actions/*.ts` are Next.js Server Actions performing real inserts, updates, and deletes) —
   this document's Part 2 area G describes that real surface, not a future one.
2. **The ADR-0009 citation count has fallen since the wave-3 notes recorded it.** The notes say
   "cited by 11 files"; as of this branch, 9 files cite it
   (`services/box/lib/audit.ts`, `services/box/lib/member-scope.ts`,
   `services/box/sql/004_audit_principal.sql`, `005_workflow_jobs.sql`, `006_oauth_tokens.sql`,
   `012_email_watch_cursors.sql`, `packages/agent-kit/src/ratchet.ts`, `governance-ratchet.ts`,
   `manifest.ts`). `docs/decisions/` still jumps `0010` → `0013` — ADR-0009 does not exist in this
   repository. Not fixed here, as the plan itself already deferred it to the wave-9 naming sweep.
3. **The `oauth_tokens` uniqueness constraint most call sites assume is stale.** The table was
   created with `UNIQUE (principal, provider)` (box 006) but relaxed by box 010 to
   `UNIQUE (principal, provider, email_address)` specifically so one person can hold more than one
   mailbox. Anyone reasoning about this table from box 006 alone would understate what it already
   supports.
4. **A live, working per-member mechanism already exists in the vault's read path** (C2/C3 above)
   that neither the identity plan nor the wave-3 notes mention by name — `noteScope`,
   `visibleTo`, and `readerForTurn` (`packages/agent-kit/src/notes-store.ts` and `note-tools.ts`),
   apparently built by an earlier "multi-user substrate" round referenced only in a code comment.
   It resolves a real per-turn speaker for vault reads through the identity register today — the
   asymmetry worth remembering is that **reads** in the vault can already tell members apart in
   principle, while nearly every **write** path across the rest of the fleet (standing facts,
   deadlines, schedules, the forget ledger) still cannot.
