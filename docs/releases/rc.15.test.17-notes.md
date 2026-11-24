# rc.15.test.17 release notes

**This is a test release, not a finished release.** Do not use it for an installation you depend on. Its record is `releases/2026-11-24-rc.15.test.17.json`. The name deliberately differs from the usual date, `rc.` and number, so that nobody following the install guide picks it by accident.

## What it is built from

The images listed as built below were built from commit `355c2965efefb7a7a3cd25b305143cf8310b864b`, by the publishing run https://github.com/Heiberg-Industries/lares/actions/runs/45478304138, on 2026-11-24.

The previous release is 2026-11-24-rc.15.test.16.

### Images built and images carried over

A carried-over image keeps the digest of the previous release and the commit that release recorded for it. It is never described as built from this release's commit.

| Image | This release | Built from | Why |
|---|---|---|---|
| console | built in this run | `355c2965efefb7a7a3cd25b305143cf8310b864b` | .gitignore is inside the build context that services/console/Dockerfile copies whole ("COPY . .") (and 9 more) |
| keeper | built in this run | `355c2965efefb7a7a3cd25b305143cf8310b864b` | packages/agent-kit/src/origin-taint.ts is copied into the image by services/keeper/Dockerfile ("COPY packages/ ./packages/") (and 6 more) |
| egress proxy | built in this run | `355c2965efefb7a7a3cd25b305143cf8310b864b` | releases/2026-11-24-rc.15.test.16.json is named as an input by .github/workflows/keeper-runtime-images.yml, which builds egress-proxy (that workflow's image proofs read release records) |
| firewall helper | built in this run | `355c2965efefb7a7a3cd25b305143cf8310b864b` | releases/2026-11-24-rc.15.test.16.json is named as an input by .github/workflows/keeper-runtime-images.yml, which builds firewall-helper (that workflow's image proofs read release records) |
| chief-of-staff runtime | built in this run | `355c2965efefb7a7a3cd25b305143cf8310b864b` | docs/decisions/0019-integrations.md belongs to the sources of the public docs corpus (.public-docs-bake), which a workflow step writes before the build and services/chief-of-staff/Dockerfile copies (and 8 more) |
| creative runtime | built in this run | `355c2965efefb7a7a3cd25b305143cf8310b864b` | docs/decisions/0019-integrations.md belongs to the sources of the public docs corpus (.public-docs-bake), which a workflow step writes before the build and services/creative/Dockerfile copies (and 6 more) |
| sync jobs | built in this run | `355c2965efefb7a7a3cd25b305143cf8310b864b` | packages/agent-kit/src/origin-taint.ts is in @lares/agent-kit, which @lares/notion-sync depends on (@lares/notion-sync -> @lares/agent-box -> @lares/agent-kit); services/sync-jobs/Dockerfile installs or builds @lares/notion-sync (and 3 more) |

The database image, the gateway image (the upstream LiteLLM image) and the proxy in front of the console (Caddy) are not built by this project. They are copied unchanged from the 2026-11-24-rc.15.test.16 record; nothing in this run checked whether newer ones exist.

In total 7 images were built and 0 carried over.

## Changes since the previous release

Commit titles from ee10c30460d22b3896b03983cb28ab506cc80182 to 355c2965efefb7a7a3cd25b305143cf8310b864b, newest first:

- Outside lookups: a trusted lookup may chain on the same connection after outside text (#449)
- release: record the rc.15.test.16 test release (#447)
- chore: ignore the Node compile cache folder (#446)

## What changed, and what breaks

- Several lookups in one message. An agent may now run more than one "run without asking" lookup from the same tool in a single message, for example a company search followed by its record and its shareholders. Before, the first result stopped any further lookup in that message, and a chat door (Slack, Telegram) told you to ask again.
- The safety rule still holds for everything else. If the message has read anything else from outside (mail, a web page, another tool, or a tool that is not set to run without asking), the next lookup asks first on web chat and is refused in words on a chat door, as before.
- What remains possible: text coming back from a trusted tool can steer further read-only lookups to that same tool, and can include conversation text in those lookups. It cannot reach another tool, send anything, or change anything without the usual checks. Decision record 0019 has the details.
- No database file and no setting changes.

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

A carried-over image was scanned when it was built, for 2026-11-24-rc.15.test.16; this run did not scan it again, and reuse does not clear it.

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
