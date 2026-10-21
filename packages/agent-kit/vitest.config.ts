import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Test fixtures read the home clock as a fixed zone; production defaults to UTC when the
    // installation names none (see `homeTzFromEnv`, which has its own test).
    env: { OWNER_HOME_TZ: "Europe/Berlin" },
  },
});
