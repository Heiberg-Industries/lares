# Decision records

Architecture decision records for the Lares engine. One file per decision, numbered and never renumbered. Each record contains Context, Decision (numbered rules) and Consequences. Cite a rule as “Lares ADR-0021 §3”.

## Historical numbering

The engine inherited records 0010, 0013, 0014, 0015 and 0016 when it became a separate project. Gaps belong to decisions outside the engine and are not missing files. From 0017 onward numbering is local to Lares. This repository's records are authoritative for engine behaviour.

## References to records outside this repository

ADR-0009 is not part of this repository. ADR-0016 supersedes its runtime choice while retaining its governance principles (the trust ratchet, one governance module above the model layer). No code cites ADR-0009 as a rule; the only mention in the source tree is a comment in `services/box/lib/member-scope.ts` noting that no such record exists. ADR-0007 is cited in comments in `packages/junk/src/index.ts`, `packages/junk/tests/junk.test.ts` and `services/notion-sync/lib/adapters/twenty-people.ts`; it is not part of this repository either. ADR-0011 is named in ADR-0016 as context only. Never renumber a record; a comment that cites a record missing here should name the behaviour it relies on instead.
