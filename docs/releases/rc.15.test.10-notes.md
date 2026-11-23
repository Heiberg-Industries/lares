# rc.15.test.10 release notes

**This is a test release, not a finished release.** Do not use it for an installation you depend on. Its record is `releases/2026-11-23-rc.15.test.10.json`. The name deliberately differs from the usual date, `rc.` and number, so that nobody following the install guide picks it by accident.

## What it is built from

The images listed as built below were built from commit `8cfd295f12ef257d820360e553faaf222a83ff89`, by the publishing run https://github.com/Heiberg-Industries/lares/actions/runs/45139444776, on 2026-11-23.

The previous release is 2026-11-21-rc.15.test.9.

### Images built and images carried over

A carried-over image keeps the digest of the previous release and the commit that release recorded for it. It is never described as built from this release's commit.

| Image | This release | Built from | Why |
|---|---|---|---|
| console | built in this run | `8cfd295f12ef257d820360e553faaf222a83ff89` | docs/releases/rc.15.test.9-notes.md is inside the build context that services/console/Dockerfile copies whole ("COPY . .") (and 25 more) |
| keeper | built in this run | `8cfd295f12ef257d820360e553faaf222a83ff89` | packages/agent-kit/package.json is copied into the image by services/keeper/Dockerfile ("COPY packages/ ./packages/") (and 24 more) |
| egress proxy | built in this run | `8cfd295f12ef257d820360e553faaf222a83ff89` | releases/2026-11-21-rc.15.test.9.json is named as an input by .github/workflows/keeper-runtime-images.yml, which builds egress-proxy (that workflow's image proofs read release records) |
| firewall helper | built in this run | `8cfd295f12ef257d820360e553faaf222a83ff89` | releases/2026-11-21-rc.15.test.9.json is named as an input by .github/workflows/keeper-runtime-images.yml, which builds firewall-helper (that workflow's image proofs read release records) |
| chief-of-staff runtime | built in this run | `8cfd295f12ef257d820360e553faaf222a83ff89` | docs/releases/rc.15.test.9-notes.md belongs to the sources of the public docs corpus (.public-docs-bake), which a workflow step writes before the build and services/chief-of-staff/Dockerfile copies (and 17 more) |
| creative runtime | built in this run | `8cfd295f12ef257d820360e553faaf222a83ff89` | docs/releases/rc.15.test.9-notes.md belongs to the sources of the public docs corpus (.public-docs-bake), which a workflow step writes before the build and services/creative/Dockerfile copies (and 13 more) |
| sync jobs | built in this run | `8cfd295f12ef257d820360e553faaf222a83ff89` | packages/agent-kit/package.json is in @lares/agent-kit, which @lares/notion-sync depends on (@lares/notion-sync -> @lares/agent-box -> @lares/agent-kit); services/sync-jobs/Dockerfile installs or builds @lares/notion-sync (and 11 more) |

The database image, the gateway image (the upstream LiteLLM image) and the proxy in front of the console (Caddy) are not built by this project. They are copied unchanged from the 2026-11-21-rc.15.test.9 record; nothing in this run checked whether newer ones exist.

In total 7 images were built and 0 carried over.

## Changes since the previous release

Commit titles from 9a0d53ca785a4e1e98b4e6b6fb0ea6752edbfc47 to 8cfd295f12ef257d820360e553faaf222a83ff89, newest first:

- Fix token connections, key-as-tool-name, and send tools on drafts-only mailboxes (#428)
- release: record the rc.15.test.9 test release (#427)

## What changed, and what breaks

- An outside tool that needs a token can now be connected. Before, saving it failed with a database permission error, because the keeper asked the wrong database login which connections already hold a token.
- The Connect screen refuses a tool name that looks like a key, and says the key belongs in the Token field. The keeper no longer repeats refused names in its log.
- An agent whose mailbox only writes drafts is no longer offered sending. It says up front that it can only write a draft, so it never asks you to approve a send that cannot happen.
- Nothing breaks: the update adds no database file and changes no setting.

Model prices were last checked on 18 November 2026.

## Security scan

Scanner: Trivy, no ignore list, run by CI against each final linux/amd64 image immediately before it was published (the number of the version is in the scan step's output). The published digests were not scanned a second time. High and critical findings of the images built in this run:

| Image | Critical | High |
|---|---|---|
| console | 1 | 37 |
| keeper | 3 | 135 |
| egress proxy | 0 | 0 |
| firewall helper | 1 | 37 |
| chief-of-staff runtime | 1 | 113 |
| creative runtime | 1 | 113 |
| sync jobs | 1 | 112 |

A carried-over image was scanned when it was built, for 2026-11-21-rc.15.test.9; this run did not scan it again, and reuse does not clear it.

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
