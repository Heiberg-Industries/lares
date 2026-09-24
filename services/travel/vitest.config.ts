import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Explicit legacy fixture identity; production has no owner default.
    env: { AGENT_OWNER_USER_ID: "bendik" },
    include: ["tests/**/*.test.ts"],
    // Vitest 2's default pool is "forks", one worker process per available CPU core (this
    // box has 10). Many of this suite's test files each spin up their own disposable
    // `@testcontainers/postgresql` container in `beforeAll` — left uncapped, a full-suite run
    // starts up to 10 Postgres containers at once, and under that Docker-daemon contention
    // vitest's default (or even a generously-raised) hook timeout genuinely trips, not just
    // flakes (confirmed: multiple container-backed test files timed out in a full concurrent
    // run, not just `tests/person-lookup.test.ts`). Capping concurrency trades some wall-clock
    // time for a suite that is reliably green rather than green-most-of-the-time.
    poolOptions: {
      forks: { minForks: 1, maxForks: 2 },
    },
  },
});
