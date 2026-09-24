// Mounts @lares/agent-kit's eve extension (ORB-143 Task 3) — a directory mount, not a flat
// file, because every tool the extension contributes has an override file beside this one
// (tools/*.ts) that resolves it against `agent.json`. Calliope is an ideation agent whose
// whole least-privilege posture is "the Atlas, never the Brain"; this mount exists to make
// that posture ENFORCEABLE rather than incidental, not to add a feature. Both capability
// config keys are `.optional()` on the extension's zod schema
// (packages/agent-kit/extension/extension.ts) specifically so a consumer like this one can
// mount nothing configured — see docs/extensions.md's "Override a contribution" section for
// the directory-mount mechanism.
//
// WHY MOUNT AN EXTENSION AND GRANT IT NOTHING. Two concrete reasons, neither cosmetic:
//
//  1. The kit's `./tools` barrel is the source of truth for what must be overridden, and
//     tests/agent-declaration.test.ts asks it. An ELEVENTH kit tool added by a future ticket
//     with no override file here would mount UNRESOLVED — governed by no agent.json at all.
//     For Calliope that means a Brain write reaching an agent with no `brain` grant, and a
//     write into Bendik's personal vault is the one thing this service must never do.
//  2. It turns "she has no Brain access" from a fact about which files happen to exist into a
//     property of her declaration, checked at build time by the same code that gives eve-saga
//     her ten live Brain tools.
//
// ORB-144 decided WHERE that least privilege is written down: not in ten `disableTool()`
// files and a hard-coded `agentKit({})`, but in the ABSENCE of a `brain` grant and the
// ABSENCE of an `orakel` grant in ../../../agent.json. The ten override files are byte-for-byte
// the ones eve-saga carries, where the same code resolves to ten live tools.
//
// A GRANT IS NOT A DEPLOY. Adding `{"capability":"vault","scope":"write-with-confirm",
// "areas":["private"]}` to agent.json would mount ten tools that THROW on their first call,
// because the vault root does not come through this extension's config: `vault_write`/
// `vault_file`/`vault_drop` and the four `vault_*` reads all resolve it via `storeRoot("brain")`
// (@lares/agent-kit/notes-store), which reads VAULT_PATH off process.env and raises
// StorePathNotConfiguredError when it is unset. Calliope's compose block (Task 7) sets no
// VAULT_PATH and mounts no /srv/brain volume, and it must stay that way. `orakel` is the same
// shape one step milder — the grant would populate the key below, but its `baseUrl`/`keyFile`
// still come from ORAKEL_URL and the orakel-key secret, neither of which she has. So: grant in
// agent.json, THEN env + volume + secret in compose, then deploy. Two files, not one.
//
// TASK 7 CONSEQUENCE: mounting this extension means her container needs a tmpfs at
// /app/packages/agent-kit/node_modules/.cache. The mount is an authored module and gets
// bundled there even with every tool disabled — the first agent-kit deploy without that tmpfs
// crash-looped on EROFS against the read-only rootfs. eve-marcel's compose block is the
// worked example.
import agentKit from "@lares/agent-kit";
import { assertDeclarationIntegrity, isGranted } from "@lares/agent-kit/manifest";

import manifest from "../../../agent.json";

// `assertDeclarationIntegrity` is opt-in — the kit cannot force a call, so if nobody makes one
// the declaration enforces nothing. `agent/agent.ts` already carries the build-time call (Task
// 1 decision 6, kept there because it is where the model id is read from). This second call is
// not redundant: it is a pure validation of the same frozen JSON module, and it means this
// file cannot be read as trusting a manifest nothing has checked. tests/agent-declaration.test.ts
// asserts the same thing in the suite.
const declaration = assertDeclarationIntegrity(manifest);

// Config-not-code (ORB-144): a capability's config key is populated only when the manifest
// grants it. Neither is granted, so both resolve to `undefined` and this is still `agentKit({})`
// at runtime — but it is now DERIVED, so it needs no edit if that ever changes.
export default agentKit({
  orakel: isGranted(declaration, "orakel")
    ? {
        keyFile: process.env["ORAKEL_KEY_FILE"] ?? "/run/secrets/orakel-key",
        baseUrl: process.env["ORAKEL_URL"],
      }
    : undefined,
  // A FLAT `undefined`, not the travel role's "holds the private area ? {closure} : undefined"
  // — the one place this file deviates from his shape, and deliberately. His ternary is
  // config-not-code taken to its conclusion: add the grant and Brain works. For Calliope that
  // is the wrong default. Granting her `brain` is not a configuration tweak, it is a decision
  // to let an ideation agent write into Bendik's personal vault, and it should cost a reader
  // one visit to this file rather than happening as a side effect of a JSON edit.
  //
  // This is fail-closed, not a hole: `extension/lib/approval-gate.ts:118-123` resolves an
  // absent `brain` config to `undefined` and treats that as "no principal is approved", so if
  // the grant is ever added without touching this line, the ten tools mount and every gated
  // Brain write refuses. Whoever makes that decision should pass `isApprovedPrincipal` bound
  // to HER `lib/principals.ts` — `isAllowedPrincipal(authenticator, userId)`, which checks the
  // channel too, unlike eve-marcel's id-only `isAllowedAdmin`. `packages/agent-kit` never
  // imports that module itself; the function value is handed across as config.
  brain: undefined,
});
