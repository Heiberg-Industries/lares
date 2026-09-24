# Lares docs

The engine's decisions, specs and research of record. Some historical documents predate this repository and contain unresolved relative links. Follow the current decision records and runbooks for implementation; historical design text is not proof of current deployment.

Start with `decisions/0015-…` (agents are definitions), `decisions/0017-the-vault.md` (memory) and `decisions/0022-the-tested-install-path.md` (how Lares is installed).

## decisions

- [`0010-knowledge-store-authority.md`](decisions/0010-knowledge-store-authority.md) — ADR 0010 — One owner per fact: Brain, Atlas, Notion, repos, CRM, and a separate taste layer
- [`0013-agents-name-purposes-gateway-maps-models.md`](decisions/0013-agents-name-purposes-gateway-maps-models.md) — ADR 0013 — Agents name purposes, the gateway maps them to models
- [`0014-proactivity-contract.md`](decisions/0014-proactivity-contract.md) — ADR 0014 — Every proactive message passes one gate, on the owner's clock, and the gate keeps the receipts
- [`0015-agents-are-definitions-resolved-at-runtime.md`](decisions/0015-agents-are-definitions-resolved-at-runtime.md) — ADR 0015 — Agents are definitions resolved at runtime; no image, Dockerfile or build per agent
- [`0016-fleet-runs-on-eve.md`](decisions/0016-fleet-runs-on-eve.md) — ADR 0016 — The fleet runs on eve, self-hosted, and carries three standing costs knowingly
- [`0017-the-vault.md`](decisions/0017-the-vault.md) — ADR 0017 — The Vault: one name, one writable home per piece of knowledge
- [`0018-learning-and-dreaming.md`](decisions/0018-learning-and-dreaming.md) — ADR 0018 — Agents learn by adding; consolidation proposes, never edits in place; third-party content never becomes memory
- [`0019-integrations.md`](decisions/0019-integrations.md) — ADR 0019 — Integrations: official SDKs and typed adapters for the core, a manifest that generates the registries, un-reviewed tools only through MCP
- [`0020-conversations.md`](decisions/0020-conversations.md) — ADR 0020 — One conversation record, kept twelve months by default, erasable per person
- [`0021-releases-and-upgrades.md`](decisions/0021-releases-and-upgrades.md) — ADR 0021 — Dated monthly releases, a migration for every breaking change from the first public release, and eve bumped monthly
- [`0022-the-tested-install-path.md`](decisions/0022-the-tested-install-path.md) — ADR 0022 — One tested install path, web chat first, and no promised support

## specs

- [`2026-08-31-lares-engine-overlay-inventory-design.md`](specs/2026-08-31-lares-engine-overlay-inventory-design.md) — Lares engine/overlay inventory — design
- [`2026-08-31-lares-org-and-multi-user-design.md`](specs/2026-08-31-lares-org-and-multi-user-design.md) — Lares — organisations and multiple users, design
- [`2026-09-01-skills-layer-design.md`](specs/2026-09-01-skills-layer-design.md) — The skills layer — design
- [`2026-09-01-accounting-concept-design.md`](specs/2026-09-01-accounting-concept-design.md) — The `accounting` concept — design
- [`2026-09-03-proactivity-contract-design.md`](specs/2026-09-03-proactivity-contract-design.md) — The proactivity contract — design
- [`2026-09-03-deadline-primitive-design.md`](specs/2026-09-03-deadline-primitive-design.md) — The deadline primitive — what the business owes institutions by a date (ORB-180, DRAFT)
- [`2026-09-03-backup-and-restore-per-installation-design.md`](specs/2026-09-03-backup-and-restore-per-installation-design.md) — Backup and restore per installation — DRAFT for the owner (ORB-187, Lares sub-project 10)
- [`2026-09-03-fresh-install-golden-path-design.md`](specs/2026-09-03-fresh-install-golden-path-design.md) — The fresh-install golden path — QA for the installation the owner does not have (ORB-197, DRAFT)
- [`2026-09-03-injection-test-suite-design.md`](specs/2026-09-03-injection-test-suite-design.md) — The injection test suite — DRAFT for the owner (ORB-200)
- [`2026-09-03-schedule-output-freshness-design.md`](specs/2026-09-03-schedule-output-freshness-design.md) — A scheduled job that stops running must say so — output freshness for every schedule (ORB-175, DRAFT)
- [`2026-09-11-lares-repo-split-design.md`](specs/2026-09-11-lares-repo-split-design.md) — Lares engine repo split — design (ORB-262)
- [`2026-09-14-lares-installer-and-wizard-design.md`](specs/2026-09-14-lares-installer-and-wizard-design.md) — Lares installer + onboarding wizard — design (ORB-266)
- [`2026-09-14-lares-releases-and-update-design.md`](specs/2026-09-14-lares-releases-and-update-design.md) — Lares releases + the one update command — design (ORB-269)
- [`2026-09-15-lares-agent-definitions-design.md`](specs/2026-09-15-lares-agent-definitions-design.md) — Lares agent definitions, the builder and the permissions board — design (ORB-278)
- [`2026-09-18-eve-upgrade-design.md`](specs/2026-09-18-eve-upgrade-design.md) — The eve upgrade, 0.32 → 0.60.x — design
- [`2026-09-18-origin-model-design.md`](specs/2026-09-18-origin-model-design.md) — The origin model — where every memory came from, stamped at the source

## research

- [`2026-09-01-governance-reconciliation.md`](research/2026-09-01-governance-reconciliation.md) — Governance reconciliation — what survived the eve migration (ORB-191)
- [`2026-09-04-lares-voice-feasibility.md`](research/2026-09-04-lares-voice-feasibility.md) — Lares voice — feasibility note (audio conversations with Saga, Marcel, Calliope)
- [`2026-09-14-orb-286-door-attachment-matrix.md`](research/2026-09-14-orb-286-door-attachment-matrix.md) — ORB-286 — door × file-type matrix (Saga, Marcel)
- [`2026-09-01-engine-security-sweep.md`](research/2026-09-01-engine-security-sweep.md) — Engine security & quality sweep — first pass (ORB-198)
- [`2026-09-16-agent-container-memory.md`](research/2026-09-16-agent-container-memory.md) — Agent capacity reading — owner approval pending
- [`2026-09-16-door-installation.md`](research/2026-09-16-door-installation.md) — Door installation contract — Task20 manual acceptance
- [`2026-09-16-eve-0.32-dynamic-seams.md`](research/2026-09-16-eve-0.32-dynamic-seams.md) — eve 0.32's dynamic seams — measured, not assumed
- [`2026-09-16-keeper-lifecycle-installation.md`](research/2026-09-16-keeper-lifecycle-installation.md) — Task14 installation contract — preparation only, Task20 remains manual
- [`2026-09-18-prelaunch/README.md`](research/2026-09-18-prelaunch/README.md) — Pre-launch research, 2026-09-18 — ten reports the 2026-09-18 decisions cite

## runbooks

- [`definition-backups.md`](runbooks/definition-backups.md) — Optional Git backups of agent definitions

## installation

- [`door-ingress.nginx.conf.example`](installation/door-ingress.nginx.conf.example) — Example configuration for NGINX reverse proxy on Door
