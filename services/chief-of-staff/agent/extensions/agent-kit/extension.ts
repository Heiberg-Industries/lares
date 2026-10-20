// Mounts @lares/agent-kit's eve extension as a DIRECTORY mount (not a flat
// `agent-kit.ts` file), because that gives each of the extension's ten
// contributions an override file beside this one (tools/*.ts) that resolves it against
// `agent.json`. The mount directory name is load-bearing: every tool this extension
// contributes gets the mandatory `agent-kit__` prefix from it.
// The mount factory is NOT at "@lares/agent-kit/extension": the actual
// `eve extension build` output (verified: packages/agent-kit/dist/index.d.ts) puts it
// on the package's bare specifier instead, matching eve's own documented
// convention (`import crm from "@acme/crm"`, node_modules/eve/docs/extensions.md).
import agentKit from "@lares/agent-kit";
import { assertDeclarationIntegrity, grantedVaultAreas, isGranted } from "@lares/agent-kit/manifest";

import manifest from "../../../agent.json";
import { isAllowedPrincipal } from "../../../lib/principals.js";

// `assertDeclarationIntegrity` is opt-in — the kit cannot force a call, so if nobody makes
// one the declaration enforces nothing. This is that call: `eve build` evaluates this module
// once per build, so a duplicate grant, an unknown capability, an autonomy level over an
// ungranted capability, or an empty persona fails the BUILD rather than surfacing at 07:00 in
// front of a schedule. tests/agent-declaration.test.ts asserts the same thing in the suite.
// Its return value is the PARSED manifest, which is also what `isGranted` needs below —
// TypeScript widens agent.json's `scope` to `string`, so the raw JSON module is not an
// AgentManifest until it has been through the schema.
const declaration = assertDeclarationIntegrity(manifest);

// Config-not-code: a capability's config key is populated only when the manifest
// grants it. Revoking a capability in agent.json takes that capability's configuration with it,
// and its tool overrides resolve to disableTool in the same pass — no code edit either side.
//
// A GRANT IS NOT A DEPLOY, though, and the tools/*.ts phrasing of that line ("you do not write
// or delete code") is true at the CODE seam only. Going the other way — granting a capability
// this agent does not hold today — mounts tools that throw on their first call until the
// container is given what they read from the environment. Concretely for `brain`: the vault
// root does NOT come through this config object. `vault_write`/`vault_file`/`vault_drop` and
// the four `vault_*` reads all resolve it via `storeRoot("brain")`
// (@lares/agent-kit/notes-store:64-68), which reads VAULT_PATH off process.env and raises
// StorePathNotConfiguredError when it is unset — see packages/agent-kit/extension/extension.ts
// for why there is deliberately no `vaultPath` config field. the chief of staff has VAULT_PATH and the
// /srv/brain mount (services/box/compose.yaml:885, :981); an agent that does not, gets
// ten mounted tools and ten runtime errors. Grant in agent.json, THEN env + volume + secret in
// compose, then deploy.
export default agentKit({
  signals: isGranted(declaration, "signals")
    ? {
        tokenFile: process.env["SIGNAL_READ_TOKEN_FILE"] ?? "/run/secrets/signal-read-token",
        baseUrl: process.env["SIGNAL_SPINE_URL"],
        // The spine host is on the chief of staff's plain sealed-egress allowlist, so this must not go
        // through createTelegramFetch's proxy.
        fetch,
      }
    : undefined,
  // `isAllowedPrincipal` is the ONLY thing that crosses into the extension —
  // it's a closure over chief-of-staff's own `lib/principals.ts` (which reads
  // SLACK_ALLOWED_USER_IDS/TELEGRAM_PRINCIPAL_ID from process.env), handed to the extension
  // as a plain function value. `packages/agent-kit` never imports `lib/principals.ts` or
  // `lib/approvals.ts` itself — see `extension/lib/approval-gate.ts`'s docblock.
  // The config KEY is still called `brain` (it is the kit extension's own field name for "who may
  // approve a write to the personal note store"). The CONDITION is the Vault area: the capability
  // called `brain` no longer exists, and a check against it would be false for ever — which
  // refuses every note write, the owner's included.
  brain: grantedVaultAreas(declaration).includes("private")
    ? {
        isApprovedPrincipal: (authenticator, userId) => isAllowedPrincipal(authenticator, userId, process.env),
      }
    : undefined,
});
