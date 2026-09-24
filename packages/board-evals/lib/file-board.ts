// The board's levels come from a file the eval edits (the database path is covered by agent-kit's own
// tests); a skew file moves the policy's clock past its 30 s cache; every decision is appended to an
// events file. Env is read per call, never at load: eve evaluates these modules while compiling.
//
// Why this is NOT in agent/instrumentation.ts (where it was first written): eve compiles
// instrumentation.ts into one bundle and agent.ts + the tools into another, and each bundle inlines
// its OWN copy of @lares/agent-kit/board-approval. A setBoardDeps() in instrumentation set a variable
// the tools' copy never reads — the bundler even dropped the whole setup body as dead code, and the
// tools fell back to the production deps (no DATABASE_URL → failed closed on every call). So every
// tool imports this module: it installs the deps into the copy of board-approval that the tools
// themselves call.
import { readFileSync, writeFileSync } from "node:fs";
import { setBoardDeps } from "@lares/agent-kit/board-approval";

const env = (key: string): string => {
  const v = process.env[key];
  if (!v) throw new Error(`board-evals: ${key} is not set`);
  return v;
};

setBoardDeps({
  explicitLevel: async (_agent, capability) => {
    const levels = JSON.parse(readFileSync(env("BOARD_LEVELS"), "utf8")); // throws on a garbled file → fail closed
    return levels[capability] ?? null;
  },
  // One line per eve callId — the same dedupe the database does (approval_events.call_id, ON CONFLICT
  // DO NOTHING). A dropped repeat goes to `<events>.resumed` instead, so the eval can see that eve
  // really did consult the policy again on resume, with the same id.
  record: async (e) => {
    const file = env("BOARD_EVENTS");
    if (e.callId) {
      const seen = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { callId?: string });
      if (seen.some((s) => s.callId === e.callId)) {
        writeFileSync(`${file}.resumed`, `${JSON.stringify(e)}\n`, { flag: "a" });
        return;
      }
    }
    writeFileSync(file, `${JSON.stringify(e)}\n`, { flag: "a" });
  },
  now: () => 1_000_000_000_000 + Number(readFileSync(env("BOARD_SKEW"), "utf8") || "0"),
});
