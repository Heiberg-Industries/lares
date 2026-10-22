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

The runtime-image workflow exports and verifies the corpus from its checked-out source before
building either role image. Both Dockerfiles copy the snapshot and its separate identity into a
fixed, read-only image path. The agents expose a short index and read one allowlisted page by ID;
they do not accept a path or URL from the conversation. At runtime, the reader verifies the image
identity against the snapshot before returning page text. A candidate build remains a candidate
even when it is later used while preparing a numbered release.

Once the final release manifest exists, a separate release-binding receipt can bind its exact
bytes to the source commit, release name and corpus hash. The receipt does not say that the
website imported or published the corpus. The website importer remains separate and must verify
the same identity before it claims to use this corpus.

This initial corpus contains only three public pages and does not complete the wider public-help
coverage. It does not provide rc.13 update guidance, recovery and restore guidance, the full
connections and import walkthrough, or a submitted support intake path. The historical rc.12
notes are not presented as rc.13 guidance. Those topics should be added only from accurate public
source pages once their behavior and release gates are settled.

Unknown documentation questions are not recorded as support requests by this mechanism. No
runtime intake-card route is part of the corpus exporter or receipt.
