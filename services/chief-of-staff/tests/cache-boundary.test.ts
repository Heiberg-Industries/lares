// The prompt-cache boundary sits after every session-stable instruction block and before every
// per-turn one (`@lares/agent-kit/prompt-cache`, `agent/instructions/zz-cache-boundary.ts`).
//
// eve runs this directory's resolvers in filename order (`localeCompare`) and puts every
// session-scoped result ahead of every turn-scoped one (eve 0.60.1,
// `context/dynamic-instruction-lifecycle.js`, `buildDynamicInstructionMessages`). So the
// boundary is in the right place exactly when it is the LAST session-scoped resolver and is
// not itself turn-scoped. A new session-scoped file named after `zz-` would land after the
// boundary and fall outside the cache; this test is what says so.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { PROMPT_CACHE_BOUNDARY } from "@lares/agent-kit/prompt-cache";

const DIR = join(__dirname, "../agent/instructions");
const BOUNDARY_FILE = "zz-cache-boundary.ts";

type Handler = (event: unknown, ctx: unknown) => Promise<{ markdown: string }>;

async function eventsOf(file: string): Promise<Record<string, Handler>> {
  const mod = (await import(join(DIR, file))) as { default: { events: Record<string, Handler> } };
  return mod.default.events;
}

describe("chief-of-staff prompt-cache boundary", () => {
  const files = readdirSync(DIR)
    .filter((f) => f.endsWith(".ts"))
    .sort((a, b) => a.localeCompare(b));

  it("is the last session-scoped resolver, and only session-scoped", async () => {
    const sessionScoped: string[] = [];
    for (const file of files) if ((await eventsOf(file))["session.started"]) sessionScoped.push(file);
    expect(sessionScoped.at(-1)).toBe(BOUNDARY_FILE);
    expect(sessionScoped).toContain("aa-definition.ts");
    expect(sessionScoped).toContain("standing-facts.ts");
    expect(Object.keys(await eventsOf(BOUNDARY_FILE))).toEqual(["session.started"]);
  });

  it("emits exactly the marker the gateway provider looks for", async () => {
    const { markdown } = await (await eventsOf(BOUNDARY_FILE))["session.started"]!(undefined, {});
    expect(markdown).toBe(PROMPT_CACHE_BOUNDARY);
  });
});
