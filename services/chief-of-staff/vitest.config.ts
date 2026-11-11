import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Deep imports into eve's dist for the suites that pin patches/eve.patch (the pnpm patch on
// eve@1.0.0-rc.9) and the framework behaviour the doors depend on. The package's exports map does
// not expose these internals, so the aliases point at the files directly (absolute paths: a bare
// "eve/dist/..." specifier would be re-blocked by the exports map). An eve upgrade that moves one
// of these files fails the importing suite at load, which is the signal to re-derive the patch.
const eveInternal = (p: string) =>
  fileURLToPath(new URL(`./node_modules/eve/dist/src/public/channels/${p}`, import.meta.url));

// Same purpose, different tree: two of the three patch hunks edit eve's HARNESS, not a channel.
// Kept as a separate helper rather than a parameterised one because these trees move
// independently across eve versions, and a single "guess the subpath" helper would hide which of
// them broke.
const eveHarness = (p: string) =>
  fileURLToPath(new URL(`./node_modules/eve/dist/src/harness/${p}`, import.meta.url));

// The session tables and the request context. The patch touches none of these; the patch tests
// use them to build a real session view from eve's own events and to run attachment hydration
// inside a real eve context, instead of hand-writing the shapes eve reads.
const eveCore = (p: string) => fileURLToPath(new URL(`./node_modules/eve/dist/src/${p}`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "eve-internals/slack-api": eveInternal("slack/api.js"),
      "eve-internals/slack-channel": eveInternal("slack/slackChannel.js"),
      "eve-internals/slack-interactions": eveInternal("slack/interactions.js"),
      "eve-internals/slack-hitl": eveInternal("slack/hitl.js"),
      "eve-internals/telegram-channel": eveInternal("telegram/telegramChannel.js"),
      "eve-internals/telegram-hitl": eveInternal("telegram/hitl.js"),
      // patches/eve.patch, hunk 1 (typed text never answers an approval) and what reads it.
      "eve-internals/hitl-delivery": eveHarness("hitl/delivery.js"),
      "eve-internals/hitl-intake": eveHarness("hitl/intake.js"),
      "eve-internals/hitl-approvals": eveHarness("hitl/approvals.js"),
      // patches/eve.patch, hunk 2b (a document reaches the agent as its text).
      "eve-internals/attachment-staging": eveHarness("attachment-staging.js"),
      "eve-internals/sandbox-refs": eveCore("internal/attachments/sandbox-refs.js"),
      "eve-internals/context-container": eveCore("context/container.js"),
      "eve-internals/context-keys": eveCore("context/keys.js"),
      // Building a session view from eve's own facts.
      "eve-internals/interaction-facts": eveHarness("interaction-facts.js"),
      "eve-internals/call-facts": eveHarness("call-facts.js"),
      "eve-internals/session-fold": eveCore("protocol/session-projection/fold.js"),
      "eve-internals/session-projection": eveCore("protocol/session-projection.js"),
      "eve-internals/session-reader": eveCore("protocol/session-projection/reader.js"),
    },
  },
  test: {
    // Explicit legacy fixture identity; production has no owner default.
    env: { AGENT_OWNER_USER_ID: "owner-1", OWNER_HOME_TZ: "Europe/Berlin", NOTION_MEETINGS_DATA_SOURCE_ID: "00000000-0000-4000-8000-000000000001" },
    include: ["tests/**/*.test.ts"],
    // Vitest 2's default pool is "forks", one worker process per available CPU core (this
    // box has 10). Many of this suite's test files each spin up their own disposable
    // `@testcontainers/postgresql` container in `beforeAll` — left uncapped, a full-suite run
    // starts up to 10 Postgres containers at once, and under that Docker-daemon contention
    // vitest's default (or even a generously-raised) hook timeout genuinely trips, not just
    // flakes (confirmed: multiple container-backed test files timed out in a full concurrent
    // run, not just `tests/person-lookup.test.ts`). Capping concurrency trades some wall-clock
    // time for a suite that is reliably green rather than green-most-of-the-time.
    // Vitest 4 replaced `poolOptions.forks.maxForks` with the top-level `maxWorkers`.
    maxWorkers: 2,
  },
});
