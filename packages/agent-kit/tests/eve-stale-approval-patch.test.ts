/**
 * Conformance: the INSTALLED eve carries the stale-answer hunk from patches/eve.patch, and it does
 * what the hunk is for (ADR-0025 rule 2).
 *
 * eve treats an answer to a request that is no longer waiting as a new message and starts a turn
 * for it (`convertStaleResponsesToUserMessage`, `harness/hitl/stale-responses.js`, called from
 * `deliver()`). That is one door-neutral place. The hunk drops such an answer when the request it
 * names is an approval that has already settled, so a late or second tap on any door starts no
 * turn. An answer to anything else (a question, a budget prompt, an id the view does not know) is
 * converted exactly as before.
 *
 * An eve bump that drops the hunk fails here, not in a chat.
 */
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);

function eveRoot(): string {
  let dir = path.dirname(require.resolve("eve"));
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(path.join(dir, "package.json")) && path.basename(dir) === "eve") return dir;
    dir = path.dirname(dir);
  }
  throw new Error("could not locate the installed eve package root from require.resolve('eve')");
}

async function convert(input: { answers: Array<{ interactionId: string; optionId: string }> }, interactions: Record<string, unknown>, pending: string[]) {
  const url = pathToFileURL(path.join(eveRoot(), "dist/src/harness/hitl/stale-responses.js")).href;
  const mod = (await import(url)) as {
    convertStaleResponsesToUserMessage(a: { pendingRequestIds: Set<string>; view: unknown; stepInput: unknown }): { kind: string; stepInput?: { answers?: unknown[]; message?: unknown } };
  };
  return mod.convertStaleResponsesToUserMessage({ pendingRequestIds: new Set(pending), view: { interactions }, stepInput: input });
}

const approval = (status: string) => ({ request: { kind: "approval", options: [{ id: "approve", label: "Approve" }] }, status });

describe("the installed eve drops a late answer to a settled approval", () => {
  it("starts no message for it, and keeps the answers to requests that still wait", async () => {
    const result = await convert(
      { answers: [{ interactionId: "late", optionId: "approve" }, { interactionId: "open", optionId: "approve" }] },
      { late: approval("settled"), open: approval("open") },
      ["open"],
    );
    expect(result.kind).toBe("unchanged");
    expect(result.stepInput?.message).toBeUndefined();
    expect(result.stepInput?.answers).toEqual([{ interactionId: "open", optionId: "approve" }]);
  });

  it("still turns an answer to anything else that is not waiting into a message, as eve does", async () => {
    const question = { request: { kind: "question", options: [{ id: "yes", label: "Yes" }] }, status: "settled" };
    const converted = await convert({ answers: [{ interactionId: "q", optionId: "yes" }] }, { q: question }, []);
    expect(converted.kind).toBe("converted");
    const unknown = await convert({ answers: [{ interactionId: "nobody-knows", optionId: "approve" }] }, {}, []);
    expect(unknown.kind).toBe("converted");
  });
});
