// The @lares/agent-kit eve extension. Each capability gets its own optional key
// so a consumer that mounts the package but doesn't use a given capability — e.g. the travel service
// overriding away every tool this extension contributes (Task 3) — is never forced to supply
// config for a capability it never calls.
import { defineExtension } from "eve/extension";
import { z } from "zod";

export default defineExtension({
  config: z.object({
    signals: z
      .object({
        tokenFile: z.string().default("/run/secrets/signal-read-token"),
        baseUrl: z.string().optional(),
        fetch: z.custom<typeof fetch>((v) => typeof v === "function"),
      })
      .optional(),
    // Task 2. Deliberately NOT a "vaultPath" field here, despite the task brief's
    // draft schema: `vault_write`/`vault_file`/`vault_drop` resolve the vault root via
    // `storeRootForArea(area)` (@lares/agent-kit/notes-store), which reads VAULT_PATH from
    // process.env directly — unchanged, and shared with Atlas's identical ATLAS_PATH
    // mechanism, which stays unmounted and can never read extension config. Adding a
    // parallel, unused `vaultPath` config field here would be dead configuration with no
    // consumer. `isApprovedPrincipal` is the only thing that genuinely needs to cross the
    // extension boundary: it's the seam that lets the extension's gated tools re-check WHO
    // approved without importing the chief-of-staff service's `lib/principals.ts`/`lib/approvals.ts` (a
    // deliberate least-privilege boundary — see extension/lib/approval-gate.ts).
    brain: z
      .object({
        isApprovedPrincipal: z.custom<(authenticator: string | undefined, userId: string | undefined) => boolean>(
          (v) => typeof v === "function",
        ),
      })
      .optional(),
    //, `transit_plan`. Optional for the same reason the two keys above are: the creative service
    // grants no `transit`, so her mount resolves the tool to a disable sentinel and must never be
    // forced to supply config for a capability she cannot call.
    //
    // `clientName` is an OVERRIDE, not a default restated here. Entur needs no API key, only an
    // `ET-Client-Name` identification header, and its value ("lares") is defined in
    // exactly one place — `../src/entur-client.ts`'s `DEFAULT_CLIENT_NAME`. A `.default()` on
    // this field would be a second copy of that literal, free to drift from the one the
    // non-extension callers (Task 3's the travel service path) get. So: absent ⇒ the client's own
    // default, present ⇒ this wins.
    transit: z
      .object({
        clientName: z.string().optional(),
        // Same override-not-default reasoning as `clientName`: the per-request bound lives once
        // in `../src/entur-client.ts`'s `DEFAULT_TIMEOUT_MS`, and this key only raises or lowers
        // it for a mount that needs to.
        timeoutMs: z.number().int().positive().optional(),
      })
      .optional(),
  }),
});
