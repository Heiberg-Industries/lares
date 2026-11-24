# rc.15.test.14 release notes

**This is a test release, not a finished release.** Do not use it for an installation you depend on. Its record is `releases/2026-11-24-rc.15.test.14.json`. The name deliberately differs from the usual date, `rc.` and number, so that nobody following the install guide picks it by accident.

## What it is built from

The images listed as built below were built from commit `09f9f637448733818f572f25c0a25d680d3c0187`, by the publishing run https://github.com/Heiberg-Industries/lares/actions/runs/45354562957, on 2026-11-24.

The previous release is 2026-11-23-rc.15.test.13.

### Images built and images carried over

A carried-over image keeps the digest of the previous release and the commit that release recorded for it. It is never described as built from this release's commit.

| Image | This release | Built from | Why |
|---|---|---|---|
| console | built in this run | `09f9f637448733818f572f25c0a25d680d3c0187` | docs/releases/rc.15.test.13-notes.md is inside the build context that services/console/Dockerfile copies whole ("COPY . .") (and 7 more) |
| keeper | built in this run | `09f9f637448733818f572f25c0a25d680d3c0187` | releases/2026-11-23-rc.15.test.13.json is named as an input by .github/workflows/keeper-runtime-images.yml, which builds keeper (that workflow's image proofs read release records) (and 6 more) |
| egress proxy | built in this run | `09f9f637448733818f572f25c0a25d680d3c0187` | releases/2026-11-23-rc.15.test.13.json is named as an input by .github/workflows/keeper-runtime-images.yml, which builds egress-proxy (that workflow's image proofs read release records) |
| firewall helper | built in this run | `09f9f637448733818f572f25c0a25d680d3c0187` | releases/2026-11-23-rc.15.test.13.json is named as an input by .github/workflows/keeper-runtime-images.yml, which builds firewall-helper (that workflow's image proofs read release records) |
| chief-of-staff runtime | built in this run | `09f9f637448733818f572f25c0a25d680d3c0187` | docs/releases/rc.15.test.13-notes.md belongs to the sources of the public docs corpus (.public-docs-bake), which a workflow step writes before the build and services/chief-of-staff/Dockerfile copies (and 4 more) |
| creative runtime | built in this run | `09f9f637448733818f572f25c0a25d680d3c0187` | docs/releases/rc.15.test.13-notes.md belongs to the sources of the public docs corpus (.public-docs-bake), which a workflow step writes before the build and services/creative/Dockerfile copies (and 1 more) |
| sync jobs | built in this run | `09f9f637448733818f572f25c0a25d680d3c0187` | services/box/tests/real-install-image.probe.py is copied into the image by services/sync-jobs/Dockerfile ("COPY services/box services/box") (and 2 more) |

The database image, the gateway image (the upstream LiteLLM image) and the proxy in front of the console (Caddy) are not built by this project. They are copied unchanged from the 2026-11-23-rc.15.test.13 record; nothing in this run checked whether newer ones exist.

In total 7 images were built and 0 carried over.

## Changes since the previous release

Commit titles from 915a62ded49ece6e86b9e108d23355d538e79d86 to 09f9f637448733818f572f25c0a25d680d3c0187, newest first:

- Fix outside-tool lookups on a real install (proxy address form), and prove the whole connect there (#436)
- release: record the rc.15.test.13 test release (#435)

## What changed, and what breaks

TO BE WRITTEN BY A PERSON. Replace this paragraph with what changed in plain words, one short paragraph or bullet for each change a person using the release would notice. Then write each breaking change as one sentence in the `breaking` list of the release file, or delete the placeholder line if nothing breaks. The tests refuse to pass while this marker is still in a release file or in these notes.

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

A carried-over image was scanned when it was built, for 2026-11-23-rc.15.test.13; this run did not scan it again, and reuse does not clear it.

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
