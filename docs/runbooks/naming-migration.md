# Upgrade to the Lares namespace

This change renames the engine's workspace packages to `@lares/*`, the internal attachment hook and its matching framework patch, diagnostic identifiers, and the console session cookie. It also replaces installation-specific endpoint examples with reserved example domains. Real installation endpoints must come from configuration.

This is a coordinated image upgrade. Do not mix an old framework patch with new agent-kit code or update one shared package in place on a running server. Build all affected images from the same commit in CI, probe them, then upgrade using reviewed image digests. There is no automatic server migration in this change.

## Check current work first

Before integrating this branch, fetch the current default branch, inspect its changes since the migration base, and reconcile the package namespace in any newly added imports, manifests, Dockerfiles or workflows. Preserve other worktrees and uncommitted work. Rerun the namespace audit, package checks and image probes on the exact merged candidate. Do not merge this broad naming change while another session is preparing a release from an older tree.

## Existing local network data

New installations default to `~/.lares/config.json` and `~/.lares/network.db`. Existing installations must set **`LARES_HOME` to the absolute existing state directory** before launching the new code. The configured directory is used for both the configuration and SQLite database; the code does not discover, rename or copy another application's directory.

To move to a new directory later:

1. Stop all importers, scheduled jobs, replica exporters and database viewers that use the local state. Record the old absolute directory and keep a backup.
2. Create a private target directory. Copy the configuration, exports and operator-owned supporting files deliberately. Use SQLite's backup facility for `network.db` rather than copying a live database without its WAL. Verify integrity and row counts in the backup before switching.
3. Update `LARES_HOME` for every launcher and scheduled job, plus any explicitly configured source/replica paths. `IMESSAGE_SOURCE_DB` is an independent setting for the freshness check; preserve its actual source path.
4. Verify counts and an offline read before enabling imports. Retain the old directory until acceptance. Do not run writers against both copies.

A rollback must keep the same active data directory. Rolling back code while pointing it at an older database copy loses newer writes; use the recorded directory and backup procedure instead.

## Keychain entries

The new default service labels are `lares-network-twenty`, `lares-network-slack`, and `lares-network-slack-user`. Existing keys need not be copied or exposed: set `LARES_TWENTY_KEYCHAIN_SERVICE`, `LARES_SLACK_KEYCHAIN_SERVICE`, and `LARES_SLACK_USER_KEYCHAIN_SERVICE` to the existing service labels in the launch environment. These settings are labels, not secret values. Do not place secret values in shell history or process arguments.

## Server state and endpoints

Nine historical SQL files have comment-only changes. The migration planner recognizes only their reviewed old/new checksum pairs, skips already-applied files, and leaves the ledger intact. Other checksum changes still refuse; do not reapply SQL or rewrite a ledger to silence a refusal.

Existing Postgres roles, databases, volumes, OAuth data, identities and vault records are **not renamed**. Keep existing `DATABASE_URL`, `WORKFLOW_POSTGRES_URL`, `PGUSER` and `PGDATABASE` values in installation configuration. Lares names in SQL comments and examples describe new installations; they are not instructions to rename a live database or replay applied migrations.

The default model endpoint is now the neutral stack's `http://lares-gateway:4000`. An installation using an external gateway must keep its explicit `GATEWAY_URL`. Preserve any required public webhook URL, DNS, reverse-proxy routing and provider registration in installation configuration. Reserved example domains in this repository are examples, not deployable addresses.

Notion sync now defaults to `/etc/lares/notion-sync.config.json`. Set `NOTION_SYNC_CONFIG` to the existing absolute configuration file until deliberately moving it and updating all launchers.

## Legacy webhook relay

The relay image now requires a private NGINX configuration mounted at `/run/lares/relay.conf` (or the absolute path set by `LARES_RELAY_CONFIG`). It fails closed without it. The bundled example uses reserved domains and a documentation IP. Before upgrading, preserve the existing hostnames, upstream address, TLS verification name and exact route restrictions in that mounted file; validate it with `nginx -t` and probe host/path isolation. Do not register example domains with a provider.

## Console sessions

The session cookie is now `lares_session`. Existing users must sign in again after the upgrade. Old cookies are not accepted by the new middleware or routes. OAuth accounts, encrypted tokens and underlying user records are unchanged. Keep the signing/encryption secrets and configured OAuth callback URL unchanged.

## Acceptance before rollout

- All workspace imports, manifests, Docker build filters, extension declarations and lockfile entries agree on `@lares/*`.
- The renamed attachment hook is present in both agent-kit and the installed framework patch; regenerate extension output and build role images.
- Offline recall, extension, cookie/auth and configuration tests pass.
- The main test workflow and image probes pass on the exact candidate; no manual provider probes run as part of a naming check.
- The operator verifies existing local state paths, Keychain labels, database URLs and webhook endpoints explicitly; no empty replacement database is created.
- A rollback plan preserves current data. Deployment requires its own coordinated window.

## Legacy DNS egress refresher

`services/box/ops/refresh-egress-allowlist.sh` now requires an installation-owned hostname file at `/etc/lares/egress-hosts`, or the path in `LARES_EGRESS_HOSTS_FILE`. Before updating an installation that uses this timer, copy its existing reviewed gateway, CRM and Slack host list into that file, one hostname per line. Comments beginning with `#` are allowed. Missing, empty or malformed input refuses before changing firewall sets. This is separate from keeper-generated egress configuration; do not introduce the legacy timer into a keeper-managed setup.

## Network export identity

Before upgrading the local network CLI, explicitly set `ownLinkedInUrl` and
`ownMetaName` in its `config.json` to the existing owner's profile URL and export
display name. Personal fallback values have been removed. LinkedIn/Meta imports
refuse missing or whitespace-only identity before any source is imported, instead
of assigning message directions using another person's identity. Other sources
do not require these fields. Existing explicitly configured values and stored
interaction rows are unchanged; this change does not reclassify old imports.

## Organisation domains on fresh schemas

Migration `032_org_domains.sql` now creates only the `orgs.domains` field, with an
empty list. It no longer populates an installation's portfolio domains. Before
using prospect routing on a fresh installation, configure and verify that
organisation's internal domains; this cleanup does not provide a domain-enrolment UI.

Existing domains are retained. The migration planner recognizes only the two
reviewed historical hashes and the exact new file hash in
`services/box/lib/migration-seed-cleanup.ts`. For those existing ledger records it
skips the migration without executing SQL or rewriting the ledger. This is a
specific pre-publication seed removal, not a claim that the old and new SQL have
the same effect. Unknown hashes and later edits still refuse. Databases without a
ledger still follow the normal explicit adoption procedure; do not replay SQL to
make their hashes match. Back up and review the dry run before an upgrade.

## First-owner and organisation seeds

Migrations 014, 028 and 029 now create schema only. Fresh databases contain no
assumed member, alias, organisation or member-policy row. The installer creates the
explicitly supplied owner and email alias, then enrols that sole member as owner of
an organisation whose id and initial display name are the configured domain. It
creates the owner's default policy in the same transaction. Repair runs preserve an
existing matching membership and refuse conflicts for manual review. The owner can
rename the display name later; the domain-derived id is stable. Multi-member routing
still requires its own setup and acceptance.

Exact reviewed historical hashes in `migration-seed-cleanup.ts` are skipped for
existing ledgers without altering identities, reminder ownership, OAuth key paths,
organisation membership or policy. An existing nonempty identity register is not
a fresh installation: first-owner refuses to replace a different identity, even
if it originally came from an older seed. Resolve that case explicitly; do not
replay old SQL or delete the register to bypass the refusal.

Personal defaults in other SQL files and runtime identity helpers still require
cleanup. This revision does not claim the entire database bootstrap is neutral.

## Explicit owners on database writes

Fresh schemas no longer assign a personal owner when a write omits its owner or
principal. Migration 088 also removes these column defaults on existing tables;
it changes no stored row values. Writers must supply the intended identity.
Missing ownership now raises a database constraint error. Back up and validate
all enabled write paths before deploying this revision.

The exact historical SQL hashes remain recognized without replay or ledger
rewrites. A very old database with populated tables that have never received
principal/user_id columns cannot use the new schema-only historical migration to
infer those rows' owners: it will refuse instead. Such an upgrade requires an
explicitly reviewed ownership backfill first. Never assign a synthetic owner to
get past that failure. If standing_facts resides in a separate role database,
apply and validate default removal there too; the box migration cannot alter a
separate database.

Runtime helpers still contain legacy owner fallbacks. Their removal requires
changing import-time identity constants and validating the compiled images;
removing database defaults alone does not complete that work.

## Runtime owner configuration

Before upgrading, set `AGENT_OWNER_USER_ID` explicitly for the chief-of-staff,
travel and console processes to the existing canonical register id. Missing or
blank configuration now throws; there is no personal fallback. Do not substitute
a new id for an existing installation. Console's optional `CONSOLE_PRINCIPAL_ID`
override is retained and must agree with the account lookup identity.

Owner and console-principal helpers read configuration at operation time, so
module imports/builds do not need an installation identity. The proactive-send
wrapper checks owner configuration before its ledger-outage fallback: a missing
owner never authorizes an ungated send. Existing database-outage behavior with a
configured owner is unchanged. Legacy test suites explicitly supply their fixture
identity in Vitest configuration; that configuration is not a production default.

Slack user-token reads now require `SLACK_TOKEN_PRINCIPAL_ID` (or an explicit
principal argument). Set it to the principal of the existing enrolled Slack token
before upgrading. No token row is renamed, copied or re-enrolled by this change;
missing configuration refuses before credential lookup. Do not assume the Google
principal or owner id matches an older Slack token row without checking.

## Public alpha configuration cleanup

This source release does not deploy or migrate an existing server. Before upgrading:

- Atlas repository routing now requires `LARES_ATLAS_REPOSITORIES_FILE`, a mounted JSON
  object mapping codebase directory names to `{ "owner": "github-owner", "repo": "repository" }`.
  Unknown or invalid entries fail the read; they never mean that a remote file was deleted.
  Grant the read-only GitHub token access to those repositories. Doctor mode additionally
  requires `LARES_ATLAS_PROBE_CODEBASE` and `LARES_ATLAS_PROBE_NOTION_PAGE` for your own probe targets.
- Set `TWENTY_BASE_URL` explicitly. No installation CRM endpoint is supplied by the engine.
- `LARES_HTTP_USER_AGENT` can identify your installation's weather/geocoding client.
  The fallback identifies the public Lares project, without a personal email address.
- Legacy firewall files in `services/box/ops` and related fixtures contain documentation IPs.
  They are examples, not deployable installation allow-lists. Generate the real policy from
  your installation configuration using the keeper; preserve and review the deployed policy.
- The signal catalogue seed now contains general entries only. Keep installation-specific
  service keys/descriptions in installation data. Existing database rows are not deleted.

The integration catalogue still contains legacy instance identifiers used by existing
credential bindings. These are compatibility identifiers, not usable credentials or an
installation template. Moving the remaining generated instance registry entirely to runtime
configuration is follow-up work. Do not invent accounts or mount secrets solely because an
identifier appears in the catalogue.
