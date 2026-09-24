# Third-party notices

Lares's AGPL-3.0-only licence applies to its original code. It does not replace the licences, copyright notices or attribution requirements of dependencies.

The project uses eve under Apache-2.0 and ships local modifications in `patches/eve.patch`. Those modifications cover runtime integration and safety behavior; inspect the patch for the exact changes. Preserve the upstream package's Apache licence and any notices when distributing it, including in images. The patch does not transfer ownership of upstream code to Lares.

Dependency versions and integrity hashes are recorded in `pnpm-lock.yaml`. Consult each distributed dependency's licence and NOTICE files. This short notice identifies the locally patched framework; it is not a complete dependency licence audit or a substitute for the notices shipped with dependencies.
