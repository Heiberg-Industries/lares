# Pull request CI

The `tests` workflow runs on pull requests targeting `main`, in the merge queue (`merge_group`), on pushes to `main`, and on manual dispatch. It uses read-only repository permissions, no live credentials, and disposable hosted runners. It does not build or publish images or deploy anything. PR runs test GitHub's proposed merge commit.

The single **CI passed** status from GitHub Actions is the required check. It passes only when the complete configured test matrix and the workspace typecheck both succeed; failed, cancelled and skipped dependencies do not pass. The merge queue needs the `merge_group` trigger to produce that status on its temporary branch.

All test jobs run without path filters. board-evals requires a model and is not run, and slack-relay and sync-jobs are not workspace packages and have no test scripts. A green gate is not image-probe or deployment validation.

To limit wasted Actions minutes, a newer commit cancels only an earlier run for the same PR. Main and manual runs have independent concurrency groups. Each job has a timeout; the configured maximum is 177 runner-minutes per run (14 test jobs, one typecheck, one gate), with actual consumption normally lower. Tests still run after merging to main. Draft PRs also run checks.

Image publishing workflows retain their existing triggers. Repository instructions additionally require a manual `keeper and neutral runtime images` run on workflow changes before merging; run it on the exact candidate branch and record its result in the PR. It publishes commit-specific images but does not deploy them.

## Image builds in the public repository

PR checks run automatically. Image workflows can be dispatched manually; automatic image
builds require the repository variable `BUILD_IMAGES=true`. Publishing images additionally
requires `PUBLISH_IMAGES=true` and explicit GHCR package access for this repository.
A manual run of the console, sync-jobs, or keeper and neutral runtime workflows publishes
only when its `publish` box is ticked, whatever `PUBLISH_IMAGES` says.
Both variables are unset at the public source launch. Builds do not deploy services.
A public source repository does not imply that existing private container packages are public.
