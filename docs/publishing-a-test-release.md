# Publishing a test release

For maintainers. One command builds what changed, publishes it and prepares the release record. One
pull request, with its checks, records it. The server side is already one command (`lares update`).

## The steps

1. Start the run on `main`:

   ```bash
   gh workflow run publish-test-release.yml --ref main -f release=2026-11-20-rc.15.test.7 -f publish=true
   ```

   The name is the date, `rc.`, the number and, for a test release, `.test.` and its number.
2. The run's summary first shows a table: for every image, "build" or "carry over", with the reason.
   An image is compared with the commit **it** was last built from (the `sources` in the newest
   file under `releases/`), not with one shared commit. A changed image is built, probed and pushed.
   An unchanged image keeps its old digest and its old source commit; it is never described as
   built from the new commit. Any doubt builds the image.
3. When every needed image is built, probed and pushed, the run writes `releases/<name>.json` and
   `docs/releases/<short name>-notes.md` from those digests, and pushes them to the branch
   `release/<name>`. It never pushes `main`.
4. The run summary ends with one line to run, to open the pull request. A pull request opened by a
   person gets its checks; one opened by a workflow with the default token would not, and a pull
   request with no checks cannot pass the merge queue.

   ```bash
   gh pr create --repo <owner>/<repo> --head release/2026-11-20-rc.15.test.7 --base main --fill
   ```
5. The notes hold a marked section ("TO BE WRITTEN BY A PERSON") for what changed in plain words,
   and the release file's `breaking` list holds one marked line. The tests fail while either marker
   is there, so an unfinished record cannot merge. Write them on the branch, push, and merge when
   the checks are green.
6. On the server: `lares update --release 2026-11-20-rc.15.test.7`.

## Trying it without publishing

Leave `-f publish=true` out (or start the run on any branch). Images are built and probed, nothing is
pushed, no branch is made, and the last job only checks that a record could be written.

## If a run stops half way

"Re-run failed jobs" on the run keeps every job that finished and repeats only the rest. A new run
with the same name starts over. Nothing is recorded until every image is done, so a half-finished
release never reaches `main`. A name that already has a record file or a `release/<name>` branch is
refused.

## What is facts and what is yours

The workflow fills in: the commit, which images were built and which carried over (with each image's
real source commit), the high and critical counts from this run's scans, the jobs of the run, and the
commit titles since the previous release. It does not write what changed in words, what breaks, or
what a person has tried on a test server. Whether a day already has a test release is a rule for
people; nothing here checks it.

A release whose previous record has no `sources` (everything before this workflow) builds every
image the first time; pass `-f base=<commit>` to say "the previous images match this commit" and
only the images changed since then are built.
