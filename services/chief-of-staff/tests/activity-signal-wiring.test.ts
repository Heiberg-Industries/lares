import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const serviceRoot = resolve(import.meta.dirname, "..");
const source = (path: string) => readFileSync(resolve(serviceRoot, path), "utf8");

describe("Saga activity signal wiring", () => {
  it.each([
    ["agent/schedules/email-triage.ts", "email-draft-written", "result.account"],
    ["agent/schedules/proposals-watch.ts", "proposal-offered", 'key: "notion"'],
    ["agent/schedules/proposals-watch.ts", "proposal-offered", 'key: "atlas"'],
    ["agent/schedules/morning-brief.ts", "brief-sent", 'key: "morning-brief"'],
    ["agent/schedules/evening-brief.ts", "brief-sent", 'key: "evening-brief"'],
    ["agent/schedules/digest.ts", "digest-run", 'key: "digest"'],
  ])("%s emits %s with catalogue key %s", (file, event, key) => {
    const text = source(file);
    expect(text).toContain(`emitSignal("${event}"`);
    expect(text).toContain(key);
    expect(text).toContain('kind: "event", severity: "info"');
  });
});
