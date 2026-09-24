# Lares — organisations and multiple users, design

**Date:** 2026-08-31
**Status:** **APPROVED FOR BUILD** (the owner, 2026-09-01). Implementation plan is the next step;
build lands in its sequenced slot — before config-driven agents and the admin UI.
**Owner:** the owner
**Parent spec:** `docs/superpowers/specs/2026-08-17-shared-agent-stack-design.md`
**Sibling:** `docs/superpowers/specs/2026-08-31-lares-engine-overlay-inventory-design.md`

## Why this exists

the owner, Notion, 2026-08-26:

> Possible to set up Lares for multiuser, with admin features to control what users can do on
> their own and what knowledge and context is shared throughout the organisation

Every other item on the Lares list is a feature. This one is a foundation: it changes who an agent
is talking to, whose knowledge it reads, whose money it spends, and who may approve what. It is
written up separately because the rest of the roadmap reads differently once it is settled.

It also **resolves an open question left by the sibling spec.** That document's finding F3 asked
whether a taste profile is per installation or per user, and blocked `ORB-102` on the answer. The
ask above answers it: **per user, inside a shared org.**

## The finding, up front

**The identity substrate is already multi-user. It simply has one row.**

Verified on the live box, 2026-08-31:

```
users         id | display_name   | primary_email      →  1 row: bendik
user_aliases  system | alias | user_id                 → 10 aliases across 5 systems
                                                          (legacy 5, email 2, google 1,
                                                           slack 1, telegram 1)
```

`user_aliases` maps any system's address — a Slack user id, a Telegram numeric id, an email
address — to a canonical user id. That is exactly the shape multi-user needs, built for One Brain
W5 and never exercised beyond one person.

Two more pieces are already in place:

- **Principals are resolved per channel and checked at two points.** `lib/principals.ts` holds one
  allowlist per channel; `agent/channels/*.ts` decides who may *start* a turn, and
  `lib/approvals.ts`'s `assertApprover` decides who may *approve* a gated action. Both read the
  same module, deliberately, so they cannot drift.
- **Slack's allowlist is already plural.** `SLACK_ALLOWED_USER_IDS` is comma-separated because
  "the workspace has more than one trusted human". Telegram's is singular today but parsed
  identically, so a second Telegram principal is a comma, not a code change.

**Consequence for scoping: this is not a rewrite.** The work is to give the existing user concept an
organisation around it, scope the stores by user, and constrain grants per user — not to invent an
identity model.

## Part 1 — What an installation is

**One installation serves one organisation. Users are members of that organisation.**

This is deliberately *not* multi-tenancy, and it keeps the parent spec's non-goal intact — but that
non-goal needs one word of amendment, because it currently reads:

> SaaS / multi-tenant hosting. Every installation is its own single-tenant stack.

**Single-tenant is not single-user.** The amendment: *every installation is its own single-tenant
stack, serving one organisation and its members.* One org per install; many users per org; never
two orgs in one install.

That boundary is what makes the security posture hold. Today each box carries its own LUKS root,
its own nft egress seal and its own squid allowlist. Those are per-installation controls, and they
only mean anything if an installation has exactly one organisation's data behind them.

## Part 2 — What is shared and what is private

the owner's ask names this directly: *"what knowledge and context is shared throughout the
organisation"*.

**The answer already exists in the store split, and multi-user makes it load-bearing rather than
incidental.** The fleet has always had two knowledge stores, split by a rule recorded long before
this question was asked: **Brain is personal; Atlas is business.**

| Store | Scope | Why |
| --- | --- | --- |
| **Atlas** | **Org-shared** | business knowledge — entities, projects, ICP, portfolio. Every member benefits; none of it is personal. |
| **Brain** | **Per-user private** | personal knowledge, conversation logs, reflections. Already Saga-only by design. |
| **Taste** | **Per-user private** | location and listening history. This is the F3 answer. |
| **Standing facts** | **Per-user private** | `standing_facts` holds *his own words*; another member's facts are not his. |
| **Network** | **Per-user private, org-visible by policy** | see below — the hardest one. |
| **Tasks** (`ORB-29`) | **Both** — per-user tasks in an org-shared store, filtered per brand | this is what "per-brand views" already means |

**`network` is the hard case and should ship private-by-default.** A contact graph is the most
personal thing in the system and the most commercially useful to share. "Who do I know at X" is
exactly what an org wants; "here is my entire message history" is not what a member wants to hand
over. The design position: **the graph is per-user; a query across the org returns *who* can make
an introduction, never the underlying evidence.** A member learns that a colleague knows someone —
not what they said to each other.

### The third scope: `participants` — derived, not configured

The table above has two scopes, and a meeting transcript fits neither. It is not personal, and it
is not automatically everyone's — board meetings, hiring conversations and 1:1s prove that
immediately. So knowledge carries one of **three** scopes:

| Scope | Who reads it | How it is assigned |
| --- | --- | --- |
| `org` | every member | source default or explicit promotion |
| `participants` | the members who were in the room | **derived from the meeting's attendee list** |
| `private` | one user | source default |

`participants` is never configured by hand. The set already exists as data: the calendar event's
attendees, which notion-sync's attendee pass already matches and `user_aliases` already resolves to
canonical users. A transcript is born scoped to its participants because the meeting knows who was
there. External attendees are not members and get no store access — see the delivery distinction
below.

### Control is policy per source, not per-document ACLs

This is the answer to *"different orgs would need tools to control this"* (the owner, 2026-08-31).
Nobody will manage permissions on individual notes — per-document ACL management is the failure
mode of every document-permission system. Instead the **owner sets one default scope per knowledge
source**, and individual items are promoted or demoted as explicit exceptions:

| Source | Shipped default |
| --- | --- |
| Meeting transcripts, chat logs | `participants` |
| Docs, wiki | `org` |
| Decisions, summaries, action items | `org` |
| Brain, taste, standing facts, personal notes | `private` |

An org that wants transcripts fully open flips one default. That is the whole control surface.

**the owner's hypothesis, affirmed with one inversion:** sharing across the business is the default
posture — everything *derived* and *documentary* flows org-wide. Only the inherently conversational
raw material defaults to the room it happened in.

### Raw and derived artifacts carry different scopes

The deliberation is not the decision. A transcript stays with its participants while the summary
and action items derived from it flow org-wide — which is how the useful knowledge spreads without
the raw conversation doing so.

One hard rule makes this safe: **a derived artifact inherits the narrowest scope of its sources
unless a human explicitly promotes it.** Without that rule, summarisation is a laundering machine
for restricted content — ask an org-scoped agent to "summarise last week's meetings" and the
restricted transcript leaks through its own summary.

### Enforcement lives in the retrieval layer, below the agent

If search returns a chunk of a restricted transcript into an agent's context, the leak has already
happened — no instruction can un-read it. So:

- **Every store query carries the requesting canonical user**, resolved from the channel address
  via `user_aliases` — the same plumbing Part 3 already requires.
- **The scope filter is applied once, in the shared store library** (agent-kit's notes-store), not
  per-tool. The fleet has already learned that per-tool enforcement leaks: *"NOTHING catches an
  ungated write under a `read` grant"* (ORB-144 finding). The store boundary is the only place the
  filter cannot be forgotten.

### The follow-up flow is the live proof (ORB-156)

Saga already drafts a summary email to a meeting's participants — `ORB-156`, live since
2026-08-24 — and it obeys this model without knowing it:

- The summary goes to **the attendee list**: the `participants` scope, applied as a delivery
  audience.
- **Per-series consent** (which meeting series may send without asking, managed on the console's
  `/meetings` page with a Revoke button) is policy-per-source with explicit exceptions — the exact
  control shape proposed above, already shipped for one source.

One distinction it makes visible: **store access and delivery audience are different things.**
External attendees receive the follow-up email — the meeting is their meeting too — but they are
not members and can never read the store. Scope governs what members' agents can retrieve;
delivery governs where a specific artifact is explicitly sent. Promotion of a summary to `org` is
a store operation; emailing it to attendees is a delivery. The two must never be conflated, or
sending an email would silently widen store access.

## Part 3 — Whose agents

Three shapes, and the fleet already demonstrates two of them:

| Shape | Example today | Multi-user behaviour |
| --- | --- | --- |
| **Personal agent** | Saga — one person's chief of staff | one instance per user; reads that user's private stores |
| **Org agent** | Calliope — the studio's creative partner | one shared instance; reads Atlas; knows which member is talking |
| **Domain agent** | Marcel — travel | either, by configuration |

**Recommendation: support personal and org agents; make it a property of the agent definition, not
a separate mechanism.** `agent.json` gains a scope — `personal` or `org` — and the store bindings
follow from it. A personal agent's `brain` capability resolves to the speaking user's Brain; an org
agent's `atlas` resolves to the shared Atlas.

This costs less than it sounds because **eve sessions are already per-channel-address**. A session
is one chat-day on one address, so two members talking to the same org agent are already two
sessions. What is missing is resolving that address to a canonical user via `user_aliases` and
scoping the stores by the result.

## Part 4 — Admin controls as constrained grants

the owner's ask: *"admin features to control what users can do on their own"*.

**This does not need a new permissions system.** Capabilities are already declarative — `agent.json`
carries `grants: [{capability, scope}]` and tools resolve from them at build time (`ORB-144`). Org
admin is therefore **constraining the grant space available to a member**, not inventing a parallel
model.

Three roles, which is as few as the requirement allows:

| Role | May |
| --- | --- |
| **Owner** | everything; manages members, adapters, org-wide grants and spend caps |
| **Member** | create personal agents; grant only capabilities the owner has made available; connect their own accounts |
| **Restricted** | use agents the owner created; create none |

Four things an owner constrains per member: **which capabilities** may be granted, **which adapters**
may be connected, **whether personal agents may be created at all**, and **a spend cap**.

The spend cap is not optional and belongs here rather than in a features list. The 2026-08-14/15
incident was a $250 uncapped retry loop against a paid model on the owner's own key, and it was
invisible in the usual spend logs. In a multi-user installation that risk is multiplied by the
member count and the owner pays. **Per-user spend caps are an engine concern, enforced at the
gateway.**

## Part 5 — What breaks today

Single-user assumptions that must be found and fixed. This list is the audit, not a guess.
The build plan's Task 11 preserves this audit as `docs/runbooks/second-user-onboarding.md`.

1. **`TELEGRAM_PRINCIPAL_ID` is singular** — parsed as a list, documented as extensible, but named
   and used as one person.
2. **`standing_facts` has no owner column.** `ORB-167` added a principal check on *who may write*,
   but the rows themselves are not scoped to a user.
3. **`packages/taste/` has no owner dimension at all** — one directory, one human, and every design
   comment in it says "the owner".
4. **Brain is one vault at `/srv/brain`**, mounted per container. Per-user Brains change the mount
   model.
5. **The briefs address one person.** "What's on his plate today" is a personal-agent contract; it
   is correct, and it needs to resolve *which* person rather than assume.
6. **`DIGEST_SLACK_TARGET` is one Slack user id.** Same shape in several schedules.
7. **The identity registry has no organisation** — `users` has no org column because there has only
   ever been one org.
8. **`ORB-171` is a privacy bug here, not a quality bug.** The notes-store searches Saga's own
   conversation logs under `_meta/` and cites them as knowledge. In a multi-user installation those
   logs contain user A's private conversations, and search would surface them to user B. The
   `_meta/` exclusion stops being polish and becomes load-bearing for the scope model — it must
   land before a second user exists.
9. **Knowledge objects carry no scope.** Nothing in the Brain or Atlas note format records `org` /
   `participants` / `private`, and the store libraries filter nothing. The scope model in Part 2 is
   entirely unbuilt.

## Part 6 — The consequence nobody wants to discover later

**Multi-user sharpens the GDPR question the parent spec already flags.**

Today the agent box holds the owner's own data, including roughly 31k Meta DMs, recorded as an
accepted risk with a DPIA and a lawyer named as prerequisites before scaling. Multi-user changes
the calculus twice over:

- **Other people's data enters the installation.** A member's Brain, their messages, their contact
  graph. The owner becomes a controller of their colleagues' personal data.
- **For a managed client deployment on the owner's servers, he becomes the processor** for an
  organisation's members, not just for one customer.

**Ruling: the DPIA is a prerequisite for multi-user, not a follow-up.** It already blocks the
`network` importers per the sibling spec; multi-user extends that to the whole installation.

## Part 7 — Cross-member access: tiers, not consent dialogs

Decided 2026-09-01 (the owner: *"We need the possibility to have agents read across calendars and
more, that's where a lot of value is"*). Three tiers, by sensitivity — and the observation that
makes it cheap is that **most of the cross-member value sits in the least sensitive tier**:

| Tier | What | Mechanism |
| --- | --- | --- |
| 1 | **Free/busy — org-visible by default** | policy-per-source, owner can flip it off. "Book me and Stefan next week" needs availability, not contents; this makes the highest-value case work with no grants and no content exposure. Matches Google Workspace's own inside-org default. |
| 2 | **Full reads (calendar contents; later other stores)** | **standing grants**: a member grants *to the org's agents*, never to another person. Revocable in the console, always listed, and **surfaced periodically in the member's own brief** — the known failure mode of standing grants is that people forget them. Every cross-member read lands in the audit table with whose request triggered it. |
| 3 | **Per-request consent cards** | **not built in v1.** Consent fatigue is the failure mode; grants cover the booking case. The trigger to build it is a real installation asking for finer grain. |

Enforcement sits where the scope model already lives: the capability layer checks the grant table
when resolving member B's calendar on behalf of member A's request. One mechanism, one more table,
no new architecture.

## Open questions — resolved 2026-09-01

Four of the five forks were ruled on by the owner:

- **Bot identity: shared bot, routed by principal.** One Slack app and one Telegram bot per
  installation; `user_aliases` resolves who is talking. The wizard's hardest steps happen once,
  not per member. Accepted cost: members' agent DMs traverse a bot token the owner controls.
- **A member's Brain on departure: export to them, then delete.** Their store is theirs — archive
  out, install deletes, org-shared artifacts they authored stay. The export path rides ORB-187's
  backup machinery.
- **Cross-member reads: the tier model above** (Part 7) — free/busy open by default, standing
  grants for full reads, no consent dialogs in v1.
- **Orakel billing: org-level subscription.** One per installation, shared by every member's
  agents; the org is already the billing boundary for the server itself.

Still open:

- **How does an org-wide `network` query prove a path without leaking evidence?** Part 2 states
  the rule; the implementation is unspecified.

## What this design does not cover

- The onboarding wizard that creates the first org and its owner — Lares sub-project 4.
- Update distribution to installations — parent spec open question, unchanged.
- Backup and restore of an installation, which multi-user makes more urgent but does not change in
  kind.
