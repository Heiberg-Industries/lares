# rc.15.test.7 release notes

**This is a test release, not a finished release.** Do not use it for an installation you depend on. Its record is `releases/2026-11-20-rc.15.test.7.json`. The name deliberately differs from the usual date, `rc.` and number, so that nobody following the install guide picks it by accident.

## What it is built from

The images listed as built below were built from commit `e8a85fef1b60d392564d98695ae51a9678878810`, by the publishing run https://github.com/Heiberg-Industries/lares/actions/runs/44731999411, on 2026-11-20.

The previous release is 2026-11-19-rc.15.test.6.

### Images built and images carried over

A carried-over image keeps the digest of the previous release and the commit that release recorded for it. It is never described as built from this release's commit.

| Image | This release | Built from | Why |
|---|---|---|---|
| console | built in this run | `e8a85fef1b60d392564d98695ae51a9678878810` | the previous release records no source commit for this image, so nothing can be compared |
| keeper | built in this run | `e8a85fef1b60d392564d98695ae51a9678878810` | the previous release records no source commit for this image, so nothing can be compared |
| egress proxy | built in this run | `e8a85fef1b60d392564d98695ae51a9678878810` | the previous release records no source commit for this image, so nothing can be compared |
| firewall helper | built in this run | `e8a85fef1b60d392564d98695ae51a9678878810` | the previous release records no source commit for this image, so nothing can be compared |
| chief-of-staff runtime | built in this run | `e8a85fef1b60d392564d98695ae51a9678878810` | the previous release records no source commit for this image, so nothing can be compared |
| creative runtime | built in this run | `e8a85fef1b60d392564d98695ae51a9678878810` | the previous release records no source commit for this image, so nothing can be compared |
| sync jobs | built in this run | `e8a85fef1b60d392564d98695ae51a9678878810` | the previous release records no source commit for this image, so nothing can be compared |

The database image, the gateway image (the upstream LiteLLM image) and the proxy in front of the console (Caddy) are not built by this project. They are copied unchanged from the 2026-11-19-rc.15.test.6 record; nothing in this run checked whether newer ones exist.

In total 7 images were built and 0 carried over.

## Changes since the previous release

The previous release record names no source commit for its images, so the list of changes between the two releases was not worked out here. Compare by hand.

## What changed, and what breaks

TO BE WRITTEN BY A PERSON. Replace this paragraph with what changed in plain words, one short paragraph or bullet for each change a person using the release would notice. Then write each breaking change as one sentence in the `breaking` list of the release file, or delete the placeholder line if nothing breaks. The tests refuse to pass while this marker is still in a release file or in these notes.

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

A carried-over image was scanned when it was built, for 2026-11-19-rc.15.test.6; this run did not scan it again, and reuse does not clear it.

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
