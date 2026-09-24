// The pool, in the shape a role service's `catalogue/index.ts` has it — a real module keyed by tool
// name, each entry naming the capability whose grant decides it. Two capabilities make
// inclusion, exclusion and grant changes independently visible to the required eval.
import type { Catalogue } from "@lares/agent-kit/catalogue";

import gmail_list from "./gmail_list.js";
import vault_list from "./vault_list.js";

export const POOL: Catalogue = {
  gmail_list: { capability: "gmail", tool: gmail_list },
  vault_list: { capability: "vault", area: "shared", tool: vault_list },
};
