import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Same cap eve-saga and eve-marcel run under, set here from the start rather than after
    // the first timeout. Vitest 2's default pool is "forks", one worker per CPU core (10 on
    // this box); once the studio port lands its container-backed tests, an uncapped run
    // starts up to ten disposable Postgres containers at once and the resulting
    // Docker-daemon contention genuinely trips hook timeouts rather than merely flaking.
    poolOptions: {
      forks: { minForks: 1, maxForks: 2 },
    },
  },
});
