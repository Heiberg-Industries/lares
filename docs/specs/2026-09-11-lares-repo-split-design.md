# Lares engine repository boundary

This document retains the architectural outcome of the repository separation. Installation-specific migration history belongs in the installation's private records.

## Engine

Lares owns shared runtime code, neutral role definitions, packages, schema migrations, images, the console and public engine documentation. A stranger's installation must not require access to a maintainer's private repository.

## Installation

Each installation owns its agent definitions, personas, settings, identities, credentials, data, domains and deployment configuration. These are resolved at runtime and stay outside the engine repository. Installing a new agent adds data and settings, not a per-installation engine fork.

## Builds and releases

Build engine images in CI and deploy by digest. Do not build on a running installation. Engine changes are reviewed contributions. Use the current release and upgrade decision records for the tested path.

## Names and migration

Use Lares names for the engine's public package namespace and documentation. Existing persisted state must be preserved during naming changes; see [the naming migration](../runbooks/naming-migration.md). Do not infer live migration steps from an old design document.
