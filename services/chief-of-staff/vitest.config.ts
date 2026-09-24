import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Deep imports into eve's dist for tests/eve-hitl-expiry-notice.test.ts — the suite that
// pins our pnpm patch on eve@0.32.0 (see that file's header comment). The package's exports
// map does not expose these internals, so the aliases point at the files directly (absolute
// paths — a bare "eve/dist/..." specifier would be re-blocked by the exports map).
const eveInternal = (p: string) =>
  fileURLToPath(new URL(`./node_modules/eve/dist/src/public/channels/${p}`, import.meta.url));

// Same purpose, different tree: the approval-card title patch (ORB-121) edits eve's HARNESS,
// not a channel, so it needs its own base path. Kept as a separate helper rather than a
// parameterised one because these two trees move independently across eve versions, and a
// single "guess the subpath" helper would hide which of them broke.
const eveHarness = (p: string) =>
  fileURLToPath(new URL(`./node_modules/eve/dist/src/harness/${p}`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "eve-internals/slack-api": eveInternal("slack/api.js"),
      "eve-internals/slack-channel": eveInternal("slack/slackChannel.js"),
      "eve-internals/slack-interactions": eveInternal("slack/interactions.js"),
      "eve-internals/slack-hitl": eveInternal("slack/hitl.js"),
      "eve-internals/telegram-channel": eveInternal("telegram/telegramChannel.js"),
      "eve-internals/telegram-hitl": eveInternal("telegram/hitl.js"),
      "eve-internals/input-extraction": eveHarness("input-extraction.js"),
    },
  },
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
