# rc.15.test.20 release notes

**This is a test release, not a finished release.** Do not use it for an installation you depend on. Its record is `releases/2026-11-27-rc.15.test.20.json`. The name deliberately differs from the usual date, `rc.` and number, so that nobody following the install guide picks it by accident.

## What it is built from

The images listed as built below were built from commit `4ae92750a1b4439531af1c86a8bf07bf3912c5e2`, by the publishing run https://github.com/Heiberg-Industries/lares/actions/runs/45959422240, on 2026-11-27.

The previous release is 2026-11-26-rc.15.test.19.

### Images built and images carried over

A carried-over image keeps the digest of the previous release and the commit that release recorded for it. It is never described as built from this release's commit.

| Image | This release | Built from | Why |
|---|---|---|---|
| console | built in this run | `4ae92750a1b4439531af1c86a8bf07bf3912c5e2` | CHANGELOG.md is inside the build context that services/console/Dockerfile copies whole ("COPY . .") (and 314 more) |
| keeper | built in this run | `4ae92750a1b4439531af1c86a8bf07bf3912c5e2` | packages/agent-kit/src/approval-reply-sentence.ts is copied into the image by services/keeper/Dockerfile ("COPY packages/ ./packages/") (and 301 more) |
| egress proxy | built in this run | `4ae92750a1b4439531af1c86a8bf07bf3912c5e2` | releases/2026-11-26-rc.15.test.19.json is named as an input by .github/workflows/keeper-runtime-images.yml, which builds egress-proxy (that workflow's image proofs read release records) |
| firewall helper | built in this run | `4ae92750a1b4439531af1c86a8bf07bf3912c5e2` | releases/2026-11-26-rc.15.test.19.json is named as an input by .github/workflows/keeper-runtime-images.yml, which builds firewall-helper (that workflow's image proofs read release records) |
| chief-of-staff runtime | built in this run | `4ae92750a1b4439531af1c86a8bf07bf3912c5e2` | docs/README.md belongs to the sources of the public docs corpus (.public-docs-bake), which a workflow step writes before the build and services/chief-of-staff/Dockerfile copies (and 39 more) |
| creative runtime | built in this run | `4ae92750a1b4439531af1c86a8bf07bf3912c5e2` | docs/README.md belongs to the sources of the public docs corpus (.public-docs-bake), which a workflow step writes before the build and services/creative/Dockerfile copies (and 27 more) |
| sync jobs | built in this run | `4ae92750a1b4439531af1c86a8bf07bf3912c5e2` | packages/agent-kit/src/approval-reply-sentence.ts is in @lares/agent-kit, which @lares/notion-sync depends on (@lares/notion-sync -> @lares/agent-box -> @lares/agent-kit); services/sync-jobs/Dockerfile installs or builds @lares/notion-sync (and 22 more) |

The database image, the gateway image (the upstream LiteLLM image) and the proxy in front of the console (Caddy) are not built by this project. They are copied unchanged from the 2026-11-26-rc.15.test.19 record; nothing in this run checked whether newer ones exist.

In total 7 images were built and 0 carried over.

## Changes since the previous release

Commit titles from c09263205cb2c450a6fafed76c7806e26df7007a to 4ae92750a1b4439531af1c86a8bf07bf3912c5e2, newest first:

- feat(console): an admin role, set per person on Members (#468)
- test(real-install): the browser steps find the redesigned agent pages (#473)
- docs: describe the console under its new page names (#472)
- fix(console): the agent-limit messages name the General page, not Settings (#471)
- feat(console): give General, Quiet hours and delivery, Backups, Members and Meeting follow-ups the new look (#470)
- fix(agents): name the console's Reviews page in the agents' instructions (#469)
- feat(console): give Deadlines, Saved preferences, the sign-in pages and Chat the new look (#466)
- feat(console): give the connections pages the new look and put Notion's settings on one page (#465)
- feat(console): give the agent pages and Writing style the new look (#467)
- fix(outside-tools): a run-without-asking switch reaches an open conversation, and two checks cannot overwrite each other (#463)
- feat(console): give Overview, Reviews, Permission checks, Alerts and Alert routing the new look (#464)
- Console redesign foundation: design values, page grid, shared parts, new menu and page addresses (#462)
- release: record the rc.15.test.19 test release (#461)

## What changed, and what breaks

TO BE WRITTEN BY A PERSON. Replace this paragraph with what changed in plain words, one short paragraph or bullet for each change a person using the release would notice. Then write each breaking change as one sentence in the `breaking` list of the release file, or delete the placeholder line if nothing breaks. The tests refuse to pass while this marker is still in a release file or in these notes.

## Security scan

Scanner: Trivy, no ignore list, run by CI against each final linux/amd64 image immediately before it was published (the number of the version is in the scan step's output). The published digests were not scanned a second time. High and critical findings of the images built in this run:

| Image | Critical | High |
|---|---|---|
| console | 1 | 38 |
| keeper | 3 | 132 |
| egress proxy | 0 | 0 |
| firewall helper | 1 | 34 |
| chief-of-staff runtime | 1 | 110 |
| creative runtime | 1 | 110 |
| sync jobs | 1 | 109 |

A carried-over image was scanned when it was built, for 2026-11-26-rc.15.test.19; this run did not scan it again, and reuse does not clear it.

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
