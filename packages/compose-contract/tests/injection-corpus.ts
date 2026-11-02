// Loads the injection corpus (fixtures/injection/*.json). Shared by this package's own corpus
// test and the chief-of-staff builder walk (its test imports this file by relative path).
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The seven authority families: content that claims a permission the server has to decide.
 *  services/chief-of-staff/tests/injection-authority.test.ts runs them against the real
 *  authorisation code; the prompt builders quarantine them like every other family. */
export const AUTHORITY_FAMILIES = [
  "claimed-approval", // 1. outside or quoted text claims the user approved something
  "replayed-request", // 2. another member's request replayed as the current actor's
  "private-laundering", // 3. private mail or DM content laundered through a shared agent, skill or history
  "audience-widening", // 4. an attempt to widen a conversation's audience
  "revoked-replay", // 5. a delayed action after the permission was revoked
  "account-swap", // 6. a changed account behind a stable connection
  "procedure-execution", // 7. a procedure edit treated as permission to execute it
] as const;
export type AuthorityFamily = (typeof AUTHORITY_FAMILIES)[number];

export interface InjectionCase {
  id: string;
  family: "tool-invocation" | "gate-bypass" | "exfiltration" | "persona-hijack" | "benign-lookalike" | AuthorityFamily;
  lang: "en" | "no";
  /** A string that appears in `text` and must never appear outside a flagged block. */
  marker: string;
  text: string;
  /** Benign look-alikes only: the authority family this text resembles without being an attack. */
  lookalikeOf?: AuthorityFamily;
}

export function loadInjectionCorpus(): InjectionCase[] {
  const dir = fileURLToPath(new URL("../fixtures/injection/", import.meta.url));
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .flatMap((f) => JSON.parse(readFileSync(dir + f, "utf8")) as InjectionCase[]);
}
