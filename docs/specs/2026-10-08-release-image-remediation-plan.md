# Release-image remediation plan — 8 October 2026

Status: planning document, published 9 October 2026, not an approved delivery schedule. The private security review it draws on is not in this repository.

Proposed execution scope. No image build, publication, release manifest change or deployment
is authorised by this document. The evidence is in the 8 October security review (private).

## Outcome

Produce a retrievable, scanned candidate image set that contains the current source fixes, with a
clear disposition for residual high/critical advisories. Use the existing CI workflows and release
manifest format. Keep publication and installation rollout separate. The owner has deferred a repeat
of the full install/update/restore rehearsal; this plan does not claim that evidence for new images.

## Boundaries

- Build on CI, never on an installation server. No new orchestration, release service or hosting.
- Include the merged browser-origin fix from PR #90 in the selected engine source commit.
- Preserve existing release manifests as evidence; propose a new candidate manifest after actual
  published digests have been verified. Never fill a manifest with an unpublished build digest.
- No broad dependency upgrade: the workspace sweep is already complete. Rebuild and measure before
  changing packaging, dependency versions or distribution.
- No engine SQL changes in this workstream. Verify the migration endpoint against the selected source;
  do not infer it from an old manifest. Existing update/recovery findings remain open/deferred.

## Small execution slices

### 1. Establish one candidate and make build-only results inspectable

Select and record the exact merged engine commit and existing CI workflow revisions. Check for
concurrent release work before choosing candidate names. Read current image publication variables;
do not toggle repository-wide controls. Use explicit manual build-only inputs where available.
The shared runtime-base workflow currently follows the publication variable rather than a per-run
publish input; do not invoke it assuming the same semantics as the other workflows.

Some current workflows do not expose a loadable image for build-only inspection. Where needed, make
one narrow workflow change: load/export the built amd64 image, run the pinned/checksummed scanner,
and retain the report with source commit, image identity, platform and scanner/database timestamps.
Reuse the existing image workflow; do not create a second pipeline. Any workflow change gets the
required manual branch run before merging. Run existing neutral runtime probes too.

Acceptance: build-only checks demonstrably publish nothing; reports describe the actual built
images. Rebuilding later can change base packages/digests: do not claim a later published image is
identical merely because its source commit is the same. Scan the final published digest again.

### 2. Rebuild the eight first-party images, then assess residual findings

| Images | Existing source/workflow | Required proof |
| --- | --- | --- |
| Console | `services/console/Dockerfile`, `console-image.yml` | Current Next/sharp versions, browser-origin fix, console build; exact final-image scan |
| Keeper | `services/keeper/Dockerfile`, `keeper-runtime-images.yml` | Imports and keeper probe pass; record Docker/Compose, corepack/pnpm and native tool versions independently of the workspace lockfile |
| Chief of staff, travel, creative | Role Dockerfiles, `keeper-runtime-images.yml` | Neutral definitions, unprivileged executable and existing runtime/conformance probes pass; record dependency inventory |
| Egress proxy and firewall helper | `images/egress-proxy`, `images/firewall-helper`, `keeper-runtime-images.yml` | Existing workflow checks plus scanned base packages; preserve egress controls |
| Sync jobs | `services/sync-jobs/Dockerfile`, `sync-jobs-image.yml` | Both scheduled-job entrypoints load; no agent/persona added; image publicly retrievable after authorised publication |

The old sync-jobs digest was pushed successfully according to its historical workflow log but now
returns MANIFEST_UNKNOWN. Inspect available package-retention/visibility evidence before attributing
a cause. A newer successful build used `push: false`; it is not proof of a published replacement.
If registry administration evidence is unavailable, record that limit and verify the replacement's
availability directly rather than guessing why the previous artifact disappeared.

Rebuild first: an outdated package in the scanned images is absent from today's lockfile, and console fixes are
already in source. If unnecessary test/build dependencies remain, propose a separate small packaging
change with runtime probes. Preserve eve/tsx/native modules and workspace symlink resolution. Do not
blindly apply `--prod` or delete a dependency because a scanner labels it development-related.

### 3. Address the three third-party images and remaining toolchain findings

| Area | Smallest remedy | Evidence before selecting a new digest |
| --- | --- | --- |
| Gateway | Evaluate an upstream fixed release for residual Python dependency findings | Upstream changes, scanned package versions; isolated configuration/auth/routing compatibility checks. No change to a live gateway and no paid calls without an applicable budget |
| Database | Evaluate a patched image within the existing PostgreSQL major first | Version/extension compatibility and exact-image scan; major database upgrade is outside this scope |
| Caddy | Evaluate a patched upstream image | Existing configuration validation and exact-image scan; preserve proxy/origin behaviour |
| Keeper Docker/Compose/corepack | Update only residual affected toolchain components | Compatible keeper operations and fresh image scan; a workspace lockfile change cannot patch these bundled binaries |
| OS packages | Refresh existing base images before considering a distribution change | Installed binary/version/architecture plus vendor disposition and reachable input path |

Record each remaining high/critical match as fixed, not applicable with evidence, or unresolved.
Keep the original report. Exceptions must name the package, advisory, image digest and reason;
no blanket ignores. A distribution's package-specific applicability note is not a reason to suppress
a separately bundled copy of the same library. Unresolved findings are visible release risks,
not automatically demonstrated remote exploits or an excuse to declare the scan clean.

### 4. Publication decision and candidate manifest

Present the selected source commit, build/probe results, residual advisory dispositions and exact
publication scope for approval. Only then publish through existing CI with explicit publish inputs.
After publication, verify anonymous registry retrieval and scan each immutable digest; retain the
platform/image-index relationship in the evidence. Do not deploy anything in this step.

Prepare a new release-candidate manifest using those verified references and the reviewed migration
endpoint. Validate it with existing release-manifest tests/parser. Preserve the old candidate and
link the new scan record. A manifest/schema pass is not a runtime upgrade/rollback rehearsal.

## Delivery acceptance and owner-facing updates

- All 11 service image references retrieve anonymously and have current scan records.
- Existing CI/runtime probes pass; fixed source package versions appear in the actual images.
- High/critical matches have explicit dispositions; unresolved items are called out for the release decision.
- Release notes explain the browser-origin requirement, image refresh and any compatibility changes.
- Console release information and public docs must describe the selected published candidate honestly;
  do not advertise automatic recovery or one-click updates based on this image work.
- Marketing needs a change only if a public capability/availability claim changes; no redesign is part
  of security remediation. Update the existing status/verification records rather than another dashboard.
- Merge, publication and deployment evidence remain separate. Full install/update/restore repetition
  stays deferred until the owner explicitly reopens it; this candidate is not production certification.
