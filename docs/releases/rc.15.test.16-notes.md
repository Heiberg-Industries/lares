# rc.15.test.16 release notes

**This is a test release, not a finished release.** Do not use it for an installation you depend on. Its record is `releases/2026-11-24-rc.15.test.16.json`. The name deliberately differs from the usual date, `rc.` and number, so that nobody following the install guide picks it by accident.

## What it is built from

The images listed as built below were built from commit `ee10c30460d22b3896b03983cb28ab506cc80182`, by the publishing run https://github.com/Heiberg-Industries/lares/actions/runs/45446976832, on 2026-11-24.

The previous release is 2026-11-24-rc.15.test.15.

### Images built and images carried over

A carried-over image keeps the digest of the previous release and the commit that release recorded for it. It is never described as built from this release's commit.

| Image | This release | Built from | Why |
|---|---|---|---|
| console | built in this run | `ee10c30460d22b3896b03983cb28ab506cc80182` | docs/decisions/0019-integrations.md is inside the build context that services/console/Dockerfile copies whole ("COPY . .") (and 41 more) |
| keeper | built in this run | `ee10c30460d22b3896b03983cb28ab506cc80182` | releases/2026-11-24-rc.15.test.15.json is named as an input by .github/workflows/keeper-runtime-images.yml, which builds keeper (that workflow's image proofs read release records) (and 36 more) |
| egress proxy | built in this run | `ee10c30460d22b3896b03983cb28ab506cc80182` | releases/2026-11-24-rc.15.test.15.json is named as an input by .github/workflows/keeper-runtime-images.yml, which builds egress-proxy (that workflow's image proofs read release records) |
| firewall helper | built in this run | `ee10c30460d22b3896b03983cb28ab506cc80182` | releases/2026-11-24-rc.15.test.15.json is named as an input by .github/workflows/keeper-runtime-images.yml, which builds firewall-helper (that workflow's image proofs read release records) |
| chief-of-staff runtime | built in this run | `ee10c30460d22b3896b03983cb28ab506cc80182` | docs/decisions/0019-integrations.md belongs to the sources of the public docs corpus (.public-docs-bake), which a workflow step writes before the build and services/chief-of-staff/Dockerfile copies (and 14 more) |
| creative runtime | built in this run | `ee10c30460d22b3896b03983cb28ab506cc80182` | docs/decisions/0019-integrations.md belongs to the sources of the public docs corpus (.public-docs-bake), which a workflow step writes before the build and services/creative/Dockerfile copies (and 5 more) |
| sync jobs | built in this run | `ee10c30460d22b3896b03983cb28ab506cc80182` | services/box/lib/database-privileges.ts is copied into the image by services/sync-jobs/Dockerfile ("COPY services/box services/box") (and 8 more) |

The database image, the gateway image (the upstream LiteLLM image) and the proxy in front of the console (Caddy) are not built by this project. They are copied unchanged from the 2026-11-24-rc.15.test.15 record; nothing in this run checked whether newer ones exist.

In total 7 images were built and 0 carried over.

## Changes since the previous release

Commit titles from 2fa8f34eb74ff49823f4c88662086cc2533c6fc7 to ee10c30460d22b3896b03983cb28ab506cc80182, newest first:

- Outside tools: lookups run without asking from the connect; read-only conflicts become choices (#443)
- Outside connector directory: record, owner actions, route hosts, login check (#444)
- docs(decisions): ADR-0029 danger zone for outside tools that change something (accepted) (#445)
- release: record the rc.15.test.15 test release (#442)
- Remove frees the connection name (retire the custody account to a tombstone) (#441)
- Outside tools: honest key status; a half-set-up connection never blocks refresh (#440)

## What changed, and what breaks

- Connecting an outside tool now switches its lookups (the tools the server marks as read-only) to run without asking in the same connect, recorded as the owner's decision with the time. The owner can untick any of them before connecting. They work in private Slack and Telegram chats straight away, with no separate switch-on step. The connection says where its tools work.
- A tool that changes something, on an agent that may only look things up, no longer fails the whole save. The rest is saved and the owner chooses per tool: leave it out, or let the agent use it after asking first. Only the installation's owner can choose the second; other members see only "leave it out".
- The installation keeps one directory of the outside servers it knows (name, address, how the server wants you to log in, and setup state). It holds no credentials and gives no agent any permission. The console has no screens for it yet; they come in a later test release.
- A connection's key status is shown honestly, and a half-set-up connection no longer blocks refreshing or updating agents.
- Removing an outside connection frees its name, so it can be added again under the same name.
- Known limits: outside tools are still not offered in shared channels, and a tool that changes something always asks first (the decision record for a deliberate per-tool exception, ADR-0029, is accepted but not built).
- The update adds one database file (039, the connector directory). It only adds a new table, so existing data is untouched. No setting changes.

Model prices were last checked on 18 November 2026.

## Security scan

Scanner: Trivy, no ignore list, run by CI against each final linux/amd64 image immediately before it was published (the number of the version is in the scan step's output). The published digests were not scanned a second time. High and critical findings of the images built in this run:

| Image | Critical | High |
|---|---|---|
| console | 1 | 37 |
| keeper | 3 | 137 |
| egress proxy | 0 | 0 |
| firewall helper | 1 | 37 |
| chief-of-staff runtime | 1 | 115 |
| creative runtime | 1 | 115 |
| sync jobs | 1 | 114 |

A carried-over image was scanned when it was built, for 2026-11-24-rc.15.test.15; this run did not scan it again, and reuse does not clear it.

## What the automated run tested

These jobs of the publishing run finished, in this order of name:

- console / build-push: success
- console / typecheck: success
- keeper-runtime / keeper: success
- keeper-runtime / real-install: success
- keeper-runtime / runtime (chief-of-staff): success
- keeper-runtime / runtime (creative): success
- keeper-runtime / select: success
- plan: success
- record: 
- sync-jobs / build-push: success

The automated run does not replace trying the release on a test server: nothing above says that a live conversation, a live approval or an update with a conversation open works. Add here what a person has tried.
