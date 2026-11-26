# rc.15.test.18 release notes

**This is a test release, not a finished release.** Do not use it for an installation you depend on. Its record is `releases/2026-11-26-rc.15.test.18.json`. The name deliberately differs from the usual date, `rc.` and number, so that nobody following the install guide picks it by accident.

## What it is built from

The images listed as built below were built from commit `9cd65931407291e74dc48bc4514541c7a73ca40a`, by the publishing run https://github.com/Heiberg-Industries/lares/actions/runs/45773372347, on 2026-11-26.

The previous release is 2026-11-24-rc.15.test.17.

### Images built and images carried over

A carried-over image keeps the digest of the previous release and the commit that release recorded for it. It is never described as built from this release's commit.

| Image | This release | Built from | Why |
|---|---|---|---|
| console | built in this run | `9cd65931407291e74dc48bc4514541c7a73ca40a` | CHANGELOG.md is inside the build context that services/console/Dockerfile copies whole ("COPY . .") (and 72 more) |
| keeper | built in this run | `9cd65931407291e74dc48bc4514541c7a73ca40a` | packages/agent-kit/src/definition-validate.ts is copied into the image by services/keeper/Dockerfile ("COPY packages/ ./packages/") (and 65 more) |
| egress proxy | built in this run | `9cd65931407291e74dc48bc4514541c7a73ca40a` | releases/2026-11-24-rc.15.test.17.json is named as an input by .github/workflows/keeper-runtime-images.yml, which builds egress-proxy (that workflow's image proofs read release records) |
| firewall helper | built in this run | `9cd65931407291e74dc48bc4514541c7a73ca40a` | releases/2026-11-24-rc.15.test.17.json is named as an input by .github/workflows/keeper-runtime-images.yml, which builds firewall-helper (that workflow's image proofs read release records) |
| chief-of-staff runtime | built in this run | `9cd65931407291e74dc48bc4514541c7a73ca40a` | docs/README.md belongs to the sources of the public docs corpus (.public-docs-bake), which a workflow step writes before the build and services/chief-of-staff/Dockerfile copies (and 24 more) |
| creative runtime | built in this run | `9cd65931407291e74dc48bc4514541c7a73ca40a` | docs/README.md belongs to the sources of the public docs corpus (.public-docs-bake), which a workflow step writes before the build and services/creative/Dockerfile copies (and 11 more) |
| sync jobs | built in this run | `9cd65931407291e74dc48bc4514541c7a73ca40a` | packages/agent-kit/src/definition-validate.ts is in @lares/agent-kit, which @lares/notion-sync depends on (@lares/notion-sync -> @lares/agent-box -> @lares/agent-kit); services/sync-jobs/Dockerfile installs or builds @lares/notion-sync (and 17 more) |

The database image, the gateway image (the upstream LiteLLM image) and the proxy in front of the console (Caddy) are not built by this project. They are copied unchanged from the 2026-11-24-rc.15.test.17 record; nothing in this run checked whether newer ones exist.

In total 7 images were built and 0 carried over.

## Changes since the previous release

Commit titles from 355c2965efefb7a7a3cd25b305143cf8310b864b to 9cd65931407291e74dc48bc4514541c7a73ca40a, newest first:

- Danger zone for outside tools that change something (#454)
- chore: remove the merge queue test file (#458)
- chore: merge queue test (will be closed) (#457)
- Outside tools: directory, Add and connector pages (#453)
- Remove old release images after an update, and add a read-only database login (#452)
- release: record the rc.15.test.17 test release (#450)
- docs: lesson on waiting for a killed process group (depends on PID 1) (#451)
- Make the owner-bootstrap timeout tests tolerate a slow-reaping PID 1 (#448)

## What changed, and what breaks

- New outside-tools pages. Integrations > Outside tools now lists every connected service with its state, its tools and which agents use it. "Add custom connector" is one screen: name, address and Automatic or Token, then Continue. Each connector has its own page where you choose tools, set "run without asking", give agents access with a token typed once, rename it, replace the token, check that it works, or remove it. Only the owner can use these pages.
- The danger zone. At the bottom of a connector's page, a red section lists the tools that change something. You can let one such tool run without asking by typing its exact name. Each switch is recorded in the log, the tool carries a red badge wherever it is listed, and the permission switches itself off when the tool's description changes. It is never used in a shared channel. A change you make here takes full effect from the agent's next conversation; in a conversation already open, a tool you switched off is refused rather than run.
- Old release images are removed. After a successful update, lares update keeps the release now running and the one before it, removes older Lares images that no container uses, and says how much space it freed.
- A read-only database login. sudo lares db opens a database session that reads non-secret state only (connectors, custody history without sealed values, approvals, update and backup history) and cannot change anything. lares doctor has a new line that checks it.
- If an agent fails to restart at the end of an update, the update now names the command to retry them all.
- No database file and no setting changes.

Model prices were last checked on 18 November 2026.

## Security scan

Scanner: Trivy, no ignore list, run by CI against each final linux/amd64 image immediately before it was published (the number of the version is in the scan step's output). The published digests were not scanned a second time. High and critical findings of the images built in this run:

| Image | Critical | High |
|---|---|---|
| console | 1 | 38 |
| keeper | 3 | 136 |
| egress proxy | 0 | 0 |
| firewall helper | 1 | 38 |
| chief-of-staff runtime | 1 | 114 |
| creative runtime | 1 | 114 |
| sync jobs | 1 | 113 |

A carried-over image was scanned when it was built, for 2026-11-24-rc.15.test.17; this run did not scan it again, and reuse does not clear it.

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
