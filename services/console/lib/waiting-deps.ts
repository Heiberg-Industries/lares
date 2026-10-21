/**
 * The runtime half of `lib/waiting.ts`: the pool, the mounted route password, the clock. Kept apart
 * so `lib/waiting.ts` is tested with fakes, and out of the `"use server"` action file, where every
 * export would become a callable endpoint.
 */
import { signedInMember, isConsoleOwner } from "./auth";
import { pool } from "./db";
import { CREDENTIAL_SLOT } from "@lares/agent-kit/credential-lifecycle";
import { keeper } from "./keeper-client";
import { readSecret } from "./secrets";
import type { WaitingDeps } from "./waiting";

export const waitingDeps: WaitingDeps = {
  connect: () => pool.connect(),
  signedInMember: async () => { const member = await signedInMember(); return member && isConsoleOwner(member) ? member : null; },
  query: (sql, values) => {
    // Built as a variable, as app/api/chat/[name]/[...path]/route.ts does: `pg`'s published
    // QueryConfig type does not name `query_timeout`, which its runtime honours.
    const config = { text: sql, values, query_timeout: 3000 };
    return pool.query(config);
  },
  fetch: (input, init) => fetch(input, init),
  routePassword: () => readSecret("EVE_ROUTE_PASSWORD"),
  // The keeper answers a credential status request for its configured administrator only.
  isAdministrator: (member) => keeper("credential.status", { slot: CREDENTIAL_SLOT }, member).then(() => true, () => false),
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};
