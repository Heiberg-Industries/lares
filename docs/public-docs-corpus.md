# Public documentation corpus

The public documentation corpus is a reviewed selection of engine documentation that can be
packaged with a release and later consumed by the website or an agent. The source files remain
the engine's documentation; generated copies are checked against their source bytes and are not
edited independently.

The current selection contains the tested install guide, the coding-agent install guide and the
console tour. Decision records, internal runbooks, private planning and installation data are not
included. A page joins the corpus only through the explicit allowlist in
`packages/agent-kit/src/public-docs.ts`.

An export records the full source commit and either `candidate` or a full dated release-candidate
name. `candidate` is for validation builds and is not a release label. The exporter requires the
source checkout and allowlisted files to match that commit, copies the source bytes unchanged,
and records per-page and whole-corpus SHA-256 hashes. The verifier checks the index, every file,
the expected page set, and the supplied trusted corpus hash. A missing, altered, extra or
unrecognized file invalidates the snapshot.

Once the final release manifest exists, a separate release-binding receipt can bind its exact
bytes to the source commit, release name and corpus hash. The receipt does not say that the
website imported or published the corpus. The website importer, image packaging and runtime
consumption are separate steps; they must verify the same identity before they claim to use this
corpus.

Unknown documentation questions are not recorded as support requests by this mechanism. No
runtime intake-card route is part of the corpus exporter or receipt.
