# Contributing to Lares

Lares uses AGPL-3.0-only for its original public code. Before merging a person's first contribution of code, documentation, tests or other project content, we require explicit acceptance of a versioned contributor agreement with Heiberg Industries AS. That one-time agreement will cover future intentional submissions under the same terms. Contributors keep ownership; the company receives a non-exclusive grant that permits alternative licensing, including commercial terms, without asking again for each release or customer.

Ordinary bug reports, feature requests and discussion need no agreement. Code or other material offered for inclusion through an issue follows the same contribution process as a pull request. Third-party dependencies keep their own licences; this agreement cannot override them.

The policy is decided; the agreement text is being finalized before outside contributions can be merged. We will use a simple manual acceptance record initially, rather than a signing bot. Opening a pull request is not acceptance. Changes to the agreement require fresh acceptance for the changed terms and do not retroactively expand earlier grants. Any individually negotiated terms must be recorded in writing before the affected contribution is merged.

Bug reports and design discussion can use GitHub issues once the repository is public. Never include credentials, customer data, private logs, or installation-specific configuration.

For a proposed change:

1. Describe the problem, expected behavior, and a minimal reproduction.
2. Keep changes scoped. Read `CLAUDE.md` and the relevant architecture decision first.
3. Use configuration for installation identity, endpoints and secrets. Ship neutral defaults.
4. Add meaningful regression coverage. Run the relevant tests and typecheck; PR CI is the merge gate. See `docs/pr-ci.md` for its exclusions.
5. Changes to outside API behavior need an explicitly authorized, documented live probe. Do not run one automatically or commit its credentials or private responses.
6. Document migration and rollback requirements. Never replay historical migrations or silently move an existing owner's data.
7. Disclose substantial AI assistance accurately. You remain responsible for understanding and reviewing the contribution.

Maintainers provide review and support on a best-effort basis; there is no response-time commitment. Treat other contributors respectfully, address ideas rather than people, and do not publish personal information or harass participants. Maintainers may remove abusive content or restrict participation.
