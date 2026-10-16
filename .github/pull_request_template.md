## What and why

<!-- What this changes, and the problem it solves. Link the issue if there is one. -->

## How it was checked

<!-- Commands you ran and what they showed. Say what you did not check. -->

- [ ] Tests and typecheck for the affected packages pass locally
- [ ] `node scripts/check-namespace.mjs` passes

## Checklist

- [ ] Nothing here names or describes an installation: no server names, hosts or addresses, no personas, no owner or agent ids, no secrets or where they live. Examples use neutral placeholders.
- [ ] Installation identity, endpoints and secrets come from configuration, with neutral defaults.
- [ ] A change that depends on a third-party API's behaviour ships a live probe under `tests/live/`, run by hand and described here, without credentials or private responses.
- [ ] A database change, a change to the image probe or a workflow change has had a manual CI run on a pushed branch (see `AGENTS.md`).
- [ ] Migration and rollback needs are written down, or there are none.
- [ ] Docs and `CHANGELOG.md` are updated where users would notice the change.
- [ ] Substantial AI assistance is disclosed in the commit message.

See [CONTRIBUTING.md](../CONTRIBUTING.md) and [CODE_OF_CONDUCT.md](../CODE_OF_CONDUCT.md).
