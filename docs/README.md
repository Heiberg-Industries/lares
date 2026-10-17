# Lares docs

The engine's decision records, how-tos and runbooks. The decision records say why the engine is built the way it is; follow them and the runbooks for implementation. Internal planning lives in the project tracker, not in this repository.

To install Lares on a server, follow [`install.md`](install.md).

Start with `decisions/0015-…` (agents are definitions), `decisions/0017-the-vault.md` (memory) and `decisions/0022-the-tested-install-path.md` (how Lares is installed).

## decisions

- [`0010-knowledge-store-authority.md`](decisions/0010-knowledge-store-authority.md) — One owner per fact: the vault, the atlas, Notion, repositories, the CRM, and a separate taste layer
- [`0013-agents-name-purposes-gateway-maps-models.md`](decisions/0013-agents-name-purposes-gateway-maps-models.md) — Agents name purposes, the gateway maps them to models
- [`0014-proactivity-contract.md`](decisions/0014-proactivity-contract.md) — Every proactive message passes one gate, on the owner's clock, and the gate keeps the receipts
- [`0015-agents-are-definitions-resolved-at-runtime.md`](decisions/0015-agents-are-definitions-resolved-at-runtime.md) — Agents are definitions resolved at runtime; no image, Dockerfile or build per agent
- [`0016-fleet-runs-on-eve.md`](decisions/0016-fleet-runs-on-eve.md) — The fleet runs on eve, self-hosted, and carries three standing costs knowingly
- [`0017-the-vault.md`](decisions/0017-the-vault.md) — The Vault: one name, one writable home per piece of knowledge
- [`0018-learning-and-dreaming.md`](decisions/0018-learning-and-dreaming.md) — Agents learn by adding; consolidation proposes, never edits in place; third-party content never becomes memory
- [`0019-integrations.md`](decisions/0019-integrations.md) — Integrations: official SDKs and typed adapters for the core, a manifest that generates the registries, un-reviewed tools only through MCP
- [`0020-conversations.md`](decisions/0020-conversations.md) — One conversation record, kept twelve months by default, erasable per person
- [`0021-releases-and-upgrades.md`](decisions/0021-releases-and-upgrades.md) — Dated monthly releases, a migration for every breaking change from the first public release, and eve bumped monthly
- [`0022-the-tested-install-path.md`](decisions/0022-the-tested-install-path.md) — One tested install path, web chat first, and no promised support

Numbering has gaps; see [`decisions/README.md`](decisions/README.md).

## how-to

- [`using-the-console.md`](how-to/using-the-console.md) — A tour of the console's pages
- [`erasing-a-person.md`](how-to/erasing-a-person.md) — Erase one person from an installation

## runbooks

- [`definition-backups.md`](runbooks/definition-backups.md) — Optional Git backups of agent definitions
- [`export-and-teardown.md`](runbooks/export-and-teardown.md) — Export, restore and tear down an installation
- [`outside-tool-tokens.md`](runbooks/outside-tool-tokens.md) — Placing the token file for an outside tool

## releases

Release notes say what changed, what breaks and how to upgrade. The newest is
[`rc.11-notes.md`](releases/rc.11-notes.md) (draft); earlier ones are
[rc.10](releases/rc.10-notes.md), [rc.9](releases/rc.9-notes.md), [rc.8](releases/rc.8-notes.md),
[rc.7](releases/rc.7-notes.md) and [rc.6](releases/rc.6-notes.md).

## installation

- [`door-ingress.nginx.conf.example`](installation/door-ingress.nginx.conf.example) — Example configuration for an NGINX reverse proxy in front of the door

## contributing

- [`pr-ci.md`](pr-ci.md) — What CI runs on a pull request
- [`website-repository.md`](website-repository.md) — Where the public website lives
- [`tools/design-preview/README.md`](../tools/design-preview/README.md) — standalone visual and interaction preview; sample state only
