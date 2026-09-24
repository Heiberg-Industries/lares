# Decision records

Architecture decision records for the Lares engine. One file per decision, numbered and never renumbered. Each record contains Context, Decision (numbered rules) and Consequences. Cite a rule as “Lares ADR-0021 §3”.

## Historical numbering

The engine inherited records 0010, 0013, 0014, 0015 and 0016 when it became a separate project. Gaps belong to decisions outside the engine and are not missing files. From 0017 onward numbering is local to Lares. This repository's records are authoritative for engine behaviour.

## References needing reconciliation

ADR-0009 is not part of this repository. ADR-0016 supersedes its runtime choice while retaining its governance principles. The following source references need individual review; do not globally replace their number, because runtime and governance references mean different things:

- `packages/agent-kit/src/governance-ratchet.ts`
- `packages/agent-kit/src/manifest.ts`
- `packages/agent-kit/src/ratchet.ts`
- `services/box/lib/audit.ts`
- `services/box/lib/member-scope.ts`
- `services/box/sql/004_audit_principal.sql`
- `services/box/sql/005_workflow_jobs.sql`
- `services/box/sql/006_oauth_tokens.sql`
- `services/box/sql/012_email_watch_cursors.sql`
