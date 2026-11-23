# rc.15.test.11 release notes

**This is a test release, not a finished release.** Do not use it for an installation you depend on. Its record is `releases/2026-11-23-rc.15.test.11.json`. The name deliberately differs from the usual date, `rc.` and number, so that nobody following the install guide picks it by accident.

## What it is built from

The images listed as built below were built from commit `647502d6e07e693e9ad618b043b09d760738de37`, by the publishing run https://github.com/Heiberg-Industries/lares/actions/runs/45160956334, on 2026-11-23.

The previous release is 2026-11-23-rc.15.test.10.

### Images built and images carried over

A carried-over image keeps the digest of the previous release and the commit that release recorded for it. It is never described as built from this release's commit.

| Image | This release | Built from | Why |
|---|---|---|---|
| console | built in this run | `647502d6e07e693e9ad618b043b09d760738de37` | docs/releases/rc.15.test.10-notes.md is inside the build context that services/console/Dockerfile copies whole ("COPY . .") (and 3 more) |
| keeper | built in this run | `647502d6e07e693e9ad618b043b09d760738de37` | releases/2026-11-23-rc.15.test.10.json is named as an input by .github/workflows/keeper-runtime-images.yml, which builds keeper (that workflow's image proofs read release records) (and 2 more) |
| egress proxy | built in this run | `647502d6e07e693e9ad618b043b09d760738de37` | releases/2026-11-23-rc.15.test.10.json is named as an input by .github/workflows/keeper-runtime-images.yml, which builds egress-proxy (that workflow's image proofs read release records) |
| firewall helper | built in this run | `647502d6e07e693e9ad618b043b09d760738de37` | releases/2026-11-23-rc.15.test.10.json is named as an input by .github/workflows/keeper-runtime-images.yml, which builds firewall-helper (that workflow's image proofs read release records) |
| chief-of-staff runtime | built in this run | `647502d6e07e693e9ad618b043b09d760738de37` | docs/releases/rc.15.test.10-notes.md belongs to the sources of the public docs corpus (.public-docs-bake), which a workflow step writes before the build and services/chief-of-staff/Dockerfile copies (and 1 more) |
| creative runtime | built in this run | `647502d6e07e693e9ad618b043b09d760738de37` | docs/releases/rc.15.test.10-notes.md belongs to the sources of the public docs corpus (.public-docs-bake), which a workflow step writes before the build and services/creative/Dockerfile copies (and 1 more) |
| sync jobs | carried over | `8cfd295f12ef257d820360e553faaf222a83ff89` | no changed file is an input of this image |

The database image, the gateway image (the upstream LiteLLM image) and the proxy in front of the console (Caddy) are not built by this project. They are copied unchanged from the 2026-11-23-rc.15.test.10 record; nothing in this run checked whether newer ones exist.

In total 6 images were built and 1 carried over.

## Changes since the previous release

Commit titles from 8cfd295f12ef257d820360e553faaf222a83ff89 to 647502d6e07e693e9ad618b043b09d760738de37, newest first:

- Let an agent limited to lookups connect an outside tool (#430)
- release: record the rc.15.test.10 test release (#429)

## What changed, and what breaks

- An agent that may only look things up with outside tools can now be connected to one. Before, the first save of a new connection was refused, because the placeholder it carries until the server lists its tools was not marked as a lookup.
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

A carried-over image was scanned when it was built, for 2026-11-23-rc.15.test.10; this run did not scan it again, and reuse does not clear it.

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
- sync-jobs: skipped

The automated run does not replace trying the release on a test server: nothing above says that a live conversation, a live approval or an update with a conversation open works. Add here what a person has tried.
