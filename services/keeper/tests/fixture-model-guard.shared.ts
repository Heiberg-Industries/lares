// Shared body of the two fixture guard tests. The two keeper fixture agents the hand-run runtime
// probes build (conversation-runtime.probe.mts, door-runtime.probe.mts) must be unable to reach a
// model provider.
//
// Their models are mocks, which is not enough alone: eve keeps only a model's id between steps
// and, picking a conversation up cold, resolves that id again through the AI SDK's default
// provider, which reaches a hosted gateway. The kit's `installRefusingDefaultProvider()` replaces
// that default with one that refuses, and locks it.
//
// ONE TEST FILE PER FIXTURE, on purpose. The guard locks a property on `globalThis` for the rest
// of the process, so a second fixture loaded in the same process would find it already locked and
// prove nothing. Each file therefore runs in its own process (vitest isolates test files), and
// each first asserts that no default provider is installed yet, so a lost isolation fails the
// test instead of letting it pass without proving anything.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const at = (fixture: string, path: string) => fileURLToPath(new URL(`./fixtures/${fixture}/agent/${path}`, import.meta.url));

/** The first statement of a module source that is neither an import nor a comment. */
function firstStatement(source: string): string {
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const withoutImports = withoutComments.replace(/^\s*import\s[^;]*;?\s*$/gm, "");
  return withoutImports.trim().split("\n")[0]!.trim();
}

export function describeFixtureGuard(fixture: "conversation-agent" | "door-agent"): void {
  describe(`${fixture}: the model guard`, () => {
    it("is an instrumentation file where eve 1.0 reads one, and the removed single file is absent", () => {
      expect(existsSync(at(fixture, "instrumentation/model-guard.ts"))).toBe(true);
      expect(existsSync(at(fixture, "instrumentation.ts"))).toBe(false);
    });

    it("installs the guard as its first statement", () => {
      const source = readFileSync(at(fixture, "instrumentation/model-guard.ts"), "utf8");
      expect(source).toMatch(/import\s*\{\s*installRefusingDefaultProvider\s*\}\s*from\s*["']@lares\/agent-kit\/gateway-budget["'];?/);
      expect(firstStatement(source)).toBe("installRefusingDefaultProvider();");
    });

    it("loading it (and nothing else) leaves the AI SDK's default provider refusing every request, and locked", async () => {
      // A fresh process: nothing has installed a default provider yet. Without this, the check
      // below could be satisfied by something loaded earlier.
      expect(Object.getOwnPropertyDescriptor(globalThis, "AI_SDK_DEFAULT_PROVIDER")).toBeUndefined();
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
}
