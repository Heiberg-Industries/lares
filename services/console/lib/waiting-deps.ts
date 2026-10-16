/**
 * The runtime half of `lib/waiting.ts`: the pool, the mounted route password, the clock. Kept apart
 * so `lib/waiting.ts` is tested with fakes, and out of the `"use server"` action file, where every
 * export would become a callable endpoint.
 */
import { pool } from "./db";
import { readSecret } from "./secrets";
import type { WaitingDeps } from "./waiting";

export const waitingDeps: WaitingDeps = {
  query: (sql, values) => {
    // Built as a variable, as app/api/chat/[name]/[...path]/route.ts does: `pg`'s published
    // QueryConfig type does not name `query_timeout`, which its runtime honours.
    const config = { text: sql, values, query_timeout: 3000 };
    return pool.query(config);
  },
  fetch: (input, init) => fetch(input, init),
  routePassword: () => readSecret("EVE_ROUTE_PASSWORD"),
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};
