# Pull request CI

The `tests` workflow runs on pull requests targeting `main`, pushes to `main`, and manual dispatch. It uses read-only repository permissions, no live credentials, and disposable hosted runners. It does not build or publish images or deploy anything. PR runs test GitHub's proposed merge commit.

Require the single **CI passed** status from GitHub Actions in the main ruleset after this workflow reaches main and has passed on a PR. That gate requires both the complete configured test matrix and the workspace typecheck to succeed. Failed, cancelled, and skipped dependencies do not pass. Leave the existing deletion and force-push protections enabled. Requiring a PR and up-to-date branches is a separate settings change; coordinate it with active work before enabling it.

All 16 existing test jobs run without path filters. Travel tests remain excluded pending LAR-81, board-evals requires a model and is not run, and slack-relay/sync-jobs have no workspace test scripts. A green gate is not image-probe or deployment validation.

To limit wasted Actions minutes, a newer commit cancels only an earlier run for the same PR. Main and manual runs have independent concurrency groups. Each job has a timeout; the configured maximum is 197 runner-minutes per run (16 test jobs, one typecheck, one gate), with actual consumption normally lower. Tests still run after merging to main. Draft PRs also run checks.

Image publishing workflows retain their existing triggers. Repository instructions additionally require a manual `keeper and neutral runtime images` run on workflow changes before merging; run it on the exact candidate branch and record its result in the PR. It publishes commit-specific images but does not deploy them.

## Image builds in the public repository

PR checks run automatically. Image workflows can be dispatched manually; automatic image
builds require the repository variable `BUILD_IMAGES=true`. Publishing images additionally
requires `PUBLISH_IMAGES=true` and explicit GHCR package access for this repository.
Both variables are unset at the public source launch. Builds do not deploy services.
A public source repository does not imply that existing private container packages are public.
