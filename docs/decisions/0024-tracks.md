# ADR 0024 — Tracks: what the owner follows, where it lives, and how the agent learns it

**Date:** 2026-10-26
**Status:** Accepted
**Amends:** ADR-0010 §6, ADR-0017 §2, ADR-0019 §5 and its open question on a CRM contract

## In plain language

Owners follow more than sales. They may follow fundraising, partnerships, support, hiring,
grant applications, or any other kind of work. A **track** is a named list the owner follows,
with its own steps. Lares reads those steps from the track's home and proposes changes only to
tracks the owner already follows. A CRM is optional.

The owner can explain tracks in conversation. The agent uses that guidance to understand what
an exchange is for, asks one short question when it is unsure, and records the owner's answer
as a standing fact. A track records workflow state; it does not grant identity, access,
sharing, or approval authority.

## Context

The earlier contact-routing rule treated the CRM as the home for commercial contacts and
organized proposals around sales opportunities. That does not fit work such as asking people
to help with a pitch: a person can be a partner or helper rather than a sales opportunity.
The owner's correction may be stored as a standing fact, but routing must read that guidance
and consider the purpose of each exchange before proposing a workflow change.

ADR-0010 establishes one canonical store per fact class. ADR-0017 makes the Vault the home for
markdown knowledge and sets the general boundary between files and dated records. ADR-0019
requires typed adapters for core concepts and named, gated writes. ADR-0023 separately defines
members, grants, audience, ownership and approval authority. Tracks must fit those boundaries
without introducing a new identity or permission system.

## Decision

1. **A track is an owner-defined workflow.** It has an id, name, purpose, ordered steps (with
   one or more closing steps), and exactly one home. An item records a person, an organisation,
   or both; the current step; the date it entered that step; a short note; and the source signal
   that created or last moved it. Lares ships no installation's tracks or sales assumptions.
   A setup may offer an optional template, which the owner may change or remove.

2. **The neutral concept is `tracks`.** It replaces `crm` as the core workflow concept. Each
   home implements one typed contract:
   - `listTracks()` returns tracks and steps read from the home itself;
   - `findWho(query)` resolves a person or organisation in that home as found, empty, failed,
     or not applicable;
   - `listItems(trackId, who?)` returns open items, optionally for a person or organisation;
   - `addItem(trackId, who, step, note)` and `moveItem(itemId, step, note)` are named,
     typed writes and remain behind the existing approval controls.

   The contract uses no vendor-specific field names. Vendor-specific values, such as a deal
   value or assigned user, stay within that adapter. Reading a home does not imply permission
   to act on its contents.

3. **A track has one home.** The Vault is the built-in default. Each Vault track has one folder
   under `shared/tracks/<track-id>/`: an OKF track file holds its name, purpose and steps, and
   one OKF item file per tracked item holds its person or organisation reference, step, date,
   note and source signal. Track and track-item are Vault OKF vocabulary extensions, like the
   existing taste types. These files are the truth for the track and its workflow state;
   Git history records their changes. A Vault track item is a deliberate exception to the
   general rule that dated records belong in tables (ADR-0017 §2). It does not become the
   canonical profile for the person or organisation it references.

   A track may instead live in a typed CRM adapter, with that CRM's own steps read live, or in
   an owner's CRM reached through a per-connection MCP mapping under ADR-0019. Writes through
   an MCP mapping remain approval-gated. An installation needs no CRM to use tracks. Until a
   Notion home exists, a Vault track can appear through the existing Vault-to-Notion sync; a
   Notion-owned home is a separate future adapter.

   A track lives in exactly one home, never two copies. Moving it requires an explicit,
   owner-approved migration. The home owns the track and its item state. This workflow state
   does not change the canonical home of underlying contact details or other facts, create a
   member or agent grant, widen an audience, or satisfy an approval requirement (ADR-0023).

4. **Routing starts with purpose.** For each exchange, the router determines in plain words
   what the exchange is for, checks whether the owner follows that purpose in an existing
   track, and then considers a step from that track. It reads relevant standing facts about
   people and what counts for a track. It proposes only into an existing track and never
   invents one. When the purpose is unclear, or no track fits but one plausibly should, it asks
   one short question instead of proposing. The owner's answer is saved in the owner's words.
   A person is not permanently classified by one exchange: a later exchange with a different
   purpose is judged on its own.

5. **The owner teaches tracks in conversation.** Creating a track, changing its steps, and
   changing its home are gated writes. When the owner declines a proposal, the agent asks once
   whether that means “not now” or “never for this person in this track” and records the
   answer as a standing fact. A fact about a person guides judgement but is not a permanent
   block on a different purpose.

6. **Several homes may be used.** Different tracks may have different homes, and the router
   reads the tracks it is currently authorized to use. Each proposed write and approval names
   the exact track and home. This does not grant access to a home beyond the current grants and
   audience rules.

## Consequences

**Positive:**

- Owners can follow work beyond sales, with or without a CRM.
- Step names come from each track's home rather than being hard-coded in the engine.
- The owner's corrections guide routing across foreground and background work without
  permanently labelling a person.
- Workflow state has one clear home, while the underlying contact profile keeps its own
  canonical home.

**Negative / accepted trade-offs:**

- The existing CRM-specific routing and proposal storage must move with the typed contract;
  this release does not preserve a compatibility layer for the old route.
- Vault items are Markdown files. Listing a large track requires reading those files; revisit
  that choice if the scale makes it impractical.
- Concurrent edits in an editor and through Lares need a checked write path; the exact
  conflict-detection behavior remains open below.

## Operational rules

- Do: read tracks and their steps from the authorized home; do not copy step lists into code.
- Do: route every track write through the typed operation and its existing approval gate.
- Do: propose only to a track the owner has created.
- Don't: duplicate a track across homes or treat a person's presence in a track as a
  permanent category.
- Don't: treat a track, its home, or a shared delivery as identity, membership, grant, or
  approval evidence.

## Open questions

1. **Concurrent Vault edits.** The Vault writer locks against Lares's own writers. Does it
   detect an Obsidian edit between read and write? If not, it must re-read and refuse when the
   file hash has changed, as the Notion apply step does.
2. **MCP mapping shape.** Should an owner's CRM mapping live in the agent definition per
   connection, or in a small mapping file the owner maintains? Settle this in the slice that
   builds the mapping.
3. **Owner view.** What console view should show tracks to owners who use neither Obsidian nor
   Notion? Settle it in the console slice.

## Cross-references

- ADR-0010 §6 — canonical contact and workflow ownership.
- ADR-0017 §2 — the one-home rule and the Vault item exception for Tracks.
- ADR-0019 §5 and its resolved contract question — typed core adapters and the `tracks` contract.
- ADR-0023 — member, grant, audience, resource and approval authority remain separate.
