// The two fixture agents the hand-run runtime probes build (conversation-runtime.probe.mts,
// door-runtime.probe.mts) must be unable to reach a model provider.
//
// Their models are mocks, which is not enough alone: eve keeps only a model's id between steps
// and, picking a conversation up cold, resolves that id again through the AI SDK's default
// provider, which reaches a hosted gateway. The kit's `installRefusingDefaultProvider()` replaces
// that default with one that refuses, and locks it. This file pins that each fixture carries the
// guard where eve 1.0 reads instrumentation, as its first statement, and that loading the file
// leaves the default provider refusing. It needs no Docker and no installed eve: the keeper does
// not depend on eve, so the one eve import the fixture file makes is stood in for below.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

vi.mock("eve/instrumentation", () => ({ defineInstrumentation: (definition: unknown) => definition }));

const FIXTURES = ["conversation-agent", "door-agent"] as const;
const at = (fixture: string, path: string) => fileURLToPath(new URL(`./fixtures/${fixture}/agent/${path}`, import.meta.url));

/** The first statement of a module source that is neither an import nor a comment. */
function firstStatement(source: string): string {
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const withoutImports = withoutComments.replace(/^\s*import\s[^;]*;?\s*$/gm, "");
  return withoutImports.trim().split("\n")[0]!.trim();
}

describe.each(FIXTURES)("%s: the model guard", (fixture) => {
  it("is an instrumentation file where eve 1.0 reads one, and the removed single file is absent", () => {
    expect(existsSync(at(fixture, "instrumentation/model-guard.ts"))).toBe(true);
    expect(existsSync(at(fixture, "instrumentation.ts"))).toBe(false);
  });

  it("installs the guard as its first statement", () => {
    const source = readFileSync(at(fixture, "instrumentation/model-guard.ts"), "utf8");
    expect(source).toMatch(/import\s*\{\s*installRefusingDefaultProvider\s*\}\s*from\s*["']@lares\/agent-kit\/gateway-budget["'];?/);
    expect(firstStatement(source)).toBe("installRefusingDefaultProvider();");
  });

  it("leaves the AI SDK's default provider refusing every request once loaded, and locked", async () => {
    // Only the last fixture's load would be visible if the first left the lock in place, so the
    // property is checked after each load; the install is idempotent by design.
    await import(/* @vite-ignore */ at(fixture, "instrumentation/model-guard.ts"));
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "AI_SDK_DEFAULT_PROVIDER");
    expect(descriptor).toBeDefined();
    expect(descriptor!.writable).toBe(false);
    expect(descriptor!.configurable).toBe(false);
    const provider = descriptor!.value as { languageModel(id: string): { doGenerate(): unknown; doStream(): unknown } };
    expect(() => provider.languageModel("anthropic/some-model").doGenerate()).toThrow("outside the engine's gateway");
    expect(() => provider.languageModel("anthropic/some-model").doStream()).toThrow("outside the engine's gateway");
  });
});
