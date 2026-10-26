# Decision records

Architecture decision records for the Lares engine. One file per decision, numbered and never renumbered. Each record contains Context, Decision (numbered rules) and Consequences. Cite a rule as “Lares ADR-0021 §3”.

## Historical numbering

The engine inherited records 0010, 0013, 0014, 0015 and 0016 when it became a separate project. Gaps belong to decisions outside the engine and are not missing files. From 0017 onward numbering is local to Lares. This repository's records are authoritative for engine behaviour.

## References to records outside this repository

ADR-0009 is not part of this repository. ADR-0016 supersedes its runtime choice while retaining its governance principles (the trust ratchet, one governance module above the model layer). No code cites ADR-0009 as a rule; the only mention in the source tree is a comment in `services/box/lib/member-scope.ts` noting that no such record exists. ADR-0007 is cited in comments in `packages/junk/src/index.ts`, `packages/junk/tests/junk.test.ts` and `services/notion-sync/lib/adapters/twenty-people.ts`; it is not part of this repository either. ADR-0011 is named in ADR-0016 as context only. Never renumber a record; a comment that cites a record missing here should name the behaviour it relies on instead.

## Decision index

| Record | Decision |
| --- | --- |
| [ADR-0010](0010-knowledge-store-authority.md) | One owner per fact; amended by ADR-0017 and ADR-0024 |
| [ADR-0013](0013-agents-name-purposes-gateway-maps-models.md) | Agents name purposes; gateway maps them to models |
| [ADR-0014](0014-proactivity-contract.md) | Proactivity contract |
| [ADR-0015](0015-agents-are-definitions-resolved-at-runtime.md) | Agents are definitions resolved at runtime |
| [ADR-0016](0016-fleet-runs-on-eve.md) | The fleet runs on eve |
| [ADR-0017](0017-the-vault.md) | The Vault and its writable-home rules; amended by ADR-0024 for track items |
| [ADR-0018](0018-learning-and-dreaming.md) | Learning and dreaming |
| [ADR-0019](0019-integrations.md) | Typed integrations; amended by ADR-0024 to define Tracks as a core concept |
| [ADR-0020](0020-conversations.md) | Conversations |
| [ADR-0021](0021-releases-and-upgrades.md) | Releases and upgrades |
| [ADR-0022](0022-the-tested-install-path.md) | The tested install path |
| [ADR-0023](0023-member-authority-and-audiences.md) | Member authority and conversation audiences |
| [ADR-0024](0024-tracks.md) | Owner-defined Tracks, their homes, and purpose-first routing |
