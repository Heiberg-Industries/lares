// Mounts @lares/agent-kit's eve extension (ORB-143 Task 3) — a directory mount, not a flat
// file, because every tool the extension contributes has an override file beside this one
// (tools/*.ts) that resolves it against `agent.json`. Marcel is a travel concierge with no
// legitimate use for Brain or Orakel today; this mount exists to PROVE per-agent least
// privilege, not to add a feature. Both capability config keys are `.optional()` on the
// extension's zod schema (packages/agent-kit/extension/extension.ts) specifically so a
// consumer like this one can mount nothing configured — see docs/extensions.md's "Override a
// contribution" section for the directory-mount mechanism.
//
// ORB-144 changed WHERE that least privilege is written down. It used to be ten
// `disableTool()` files and a hard-coded `agentKit({})` here. It is now the absence of an
// `orakel` grant and the absence of a `brain` grant in ../../../agent.json — the ten override
// files are byte-for-byte the ones eve-saga carries, where the same code resolves to ten live
// tools. To give Marcel Brain you add a grant; you do not write or delete code, here or
// there.
//
// A GRANT IS NOT A DEPLOY, and the tool files' phrasing of that line is true at the code seam
// only. Adding `{"capability":"vault","scope":"write-with-confirm","areas":["private"]}` to
// agent.json mounts ten tools that THROW on their first call, because the vault root does not
// come through this extension's config: `vault_write`/`vault_file`/`vault_drop` and the four `vault_*` reads all
// resolve it via `storeRoot("brain")` (@lares/agent-kit/notes-store:64-68), which reads
// VAULT_PATH off process.env and raises StorePathNotConfiguredError when it is unset — see
// packages/agent-kit/extension/extension.ts's own note on why there is deliberately no
// `vaultPath` config field. eve-marcel's compose block (services/box/compose.yaml:1047+)
// sets no VAULT_PATH and mounts no /srv/brain volume; eve-saga's sets both (:885, :981).
// `orakel` is the same shape one step milder — the grant populates the key below, but its
// `baseUrl`/`keyFile` still come from ORAKEL_URL and the orakel-key secret, neither of which
// Marcel's compose block has. So: grant in agent.json, THEN env + volume + secret in compose,
// then deploy. Two files, not one.
import agentKit from "@lares/agent-kit";
import { assertDeclarationIntegrity, grantedVaultAreas, isGranted } from "@lares/agent-kit/manifest";

import manifest from "../../../agent.json";
import { isAllowedAdmin } from "../../../lib/principals.js";

// `assertDeclarationIntegrity` is opt-in — the kit cannot force a call, so if nobody makes
// one the declaration enforces nothing. This is that call: `eve build` evaluates this module
// once per build, so a duplicate grant, an unknown capability, an autonomy level over an
// ungranted capability, or an empty persona fails the BUILD rather than surfacing mid-trip in
// front of the family group chat. tests/agent-declaration.test.ts asserts the same thing in
// the suite. Its return value is the PARSED manifest, which is also what `isGranted` needs
// below — TypeScript widens agent.json's `scope` to `string`, so the raw JSON module is not
// an AgentManifest until it has been through the schema.
const declaration = assertDeclarationIntegrity(manifest);

// Config-not-code (ORB-144): a capability's config key is populated only when the manifest
// grants it. Neither is granted today, so both resolve to `undefined` and this is still
// `agentKit({})` at runtime — but it is now DERIVED, so granting Marcel `brain` or `orakel`
// later needs no edit to this file.
export default agentKit({
  orakel: isGranted(declaration, "orakel")
    ? {
        keyFile: process.env["ORAKEL_KEY_FILE"] ?? "/run/secrets/orakel-key",
        baseUrl: process.env["ORAKEL_URL"],
      }
    : undefined,
  // The one thing that would cross into the extension if `brain` were ever granted: a closure
  // over Marcel's OWN `lib/principals.ts`, not eve-saga's. Marcel has a single approver — the
  // admin, checked by `isAllowedAdmin` against `MARCEL_ADMIN_TELEGRAM_ID`
  // (lib/principals.ts:12-17; set at services/box/compose.yaml:1086; fail-closed, so
  // unset or blank admits nobody). That is the same identity every admin-DM-gated tool in
  // agent/tools/ checks, so a gated Brain write could only ever be approved by him.
  // `packages/agent-kit` never imports this module itself; the function value is handed
  // across as config (see `extension/lib/approval-gate.ts`'s docblock).
  //
  // THE `_authenticator` IS DROPPED, AND CANNOT BE OTHERWISE. eve-saga's matching closure
  // passes its authenticator through because `isAllowedPrincipal(authenticator, userId, env)`
  // resolves it to a channel first (lib/principals.ts:82-90). Marcel's
  // `isAllowedAdmin(id, env)` takes an ID AND NOTHING ELSE — he has one door, so his
  // principals module has no channel concept to check against, and there is no signature here
  // to pass it to. The underscore records that, and this comment records the cost: a `userId`
  // string equal to MARCEL_ADMIN_TELEGRAM_ID would approve on ANY authenticator, not only the
  // Telegram webhook it was issued for. Today that is unreachable — "holds the Vault's private area" is
  // false, so this closure is never constructed — which is exactly why it needs writing down
  // rather than testing. Anyone granting Marcel `brain` should narrow this first, and the
  // honest way to do that is to give `lib/principals.ts` a channel check of its own, not to
  // inline one here where nothing tests it.
  // The config KEY is still called `brain` (it is the kit extension's own field name for "who may
  // approve a write to the personal note store"). The CONDITION is the Vault area: the capability
  // called `brain` no longer exists, and a check against it would be false for ever — which
  // refuses every note write, the owner's included.
  brain: grantedVaultAreas(declaration).includes("private")
    ? {
        isApprovedPrincipal: (_authenticator, userId) => userId !== undefined && isAllowedAdmin(userId),
      }
    : undefined,
});
