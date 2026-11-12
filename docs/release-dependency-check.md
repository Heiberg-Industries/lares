# Dependency version check

Every release candidate gets this check before it is cut. It changes nothing; it only reads.
Run it from a clean checkout of the release branch, after `pnpm install`.

1. **Ours.** `pnpm list -r --depth 0 --json` for the SDKs and frameworks (eve, the AI SDK, Workflow,
   the Chat SDK, Next.js, React, and the rest), plus the pinned images: Node and pnpm in the
   Dockerfiles, the gateway, Trivy in `scripts/scan-image.sh`, and every digest-pinned base.
2. **Latest.** `pnpm outdated -r`, then `npm view <package> version dist-tags time --json` for each
   one that matters. For a pre-release dependency, list every published pre-release and check
   whether a final exists.
3. **Security.** `pnpm audit --prod`, and `gh api "advisories?ecosystem=npm&affects=<package>"` for
   the main ones. Check the gateway and the base images against their own advisories the same way.
4. **Patches.** If a package is patched (`patches/`), compare the files the patch touches with the
   new upstream version. Identical means the patch still applies; otherwise cut it again.
5. **Must update before the release ships:** a published security fix in the version line we use; a
   pre-release that a newer one has replaced; anything past end of life (Node line, Postgres major,
   base image).
6. **May wait:** everything else. Packages from one vendor move together as one set, followed by
   the session and database proofs. A major version that waits gets a written reason.
7. **Record.** Put a "Dependency version check" section in the release's notes under
   `docs/releases/`: a table of ours, latest and decision for each, the advisory ids, the result
   of step 4, and the reason for every item that waits.
