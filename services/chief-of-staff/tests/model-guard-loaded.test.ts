// The agent eve builds from this service must load the model guard.
//
// eve keeps only a model's id between steps and, picking a conversation up cold, resolves that id
// again through the AI SDK's default provider, which reaches a hosted gateway. The kit's
// `installRefusingDefaultProvider()` replaces that default with one that refuses, and locks it. It
// runs from an instrumentation file, and so does the stop on an invalid agent definition.
//
// `eve build` does NOT fail when the instrumentation folder is missing, empty, or holds only files
// it skips (test files, other extensions): it builds with no providers, and the agent starts with
// neither the guard nor the stop. So this test asks eve's OWN layout reader (the function the build
// uses) which files it would load from `agent/`, and then loads exactly those, in a process where
// nothing has installed a default provider yet. The built image is checked separately, in
// `services/keeper/tests/runtime-image.probe.py`.
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";

// The tool catalogue is not what this test reads; leaving it out keeps the test independent of the kit build.
vi.mock("../catalogue/index.js", () => ({ CATALOGUE: {} }));

const agentRoot = fileURLToPath(new URL("../agent", import.meta.url));
// Not in eve's exports map, so addressed by its real path. An eve upgrade that moves it fails this
// test at load, which is the signal to look again at how eve finds instrumentation.
const eveRoot = realpathSync(fileURLToPath(new URL("../node_modules/eve", import.meta.url)));
const layoutModule = pathToFileURL(`${eveRoot}/dist/src/internal/instrumentation-layout.js`).href;

async function loadedProviders(): Promise<Record<string, string>> {
  const { resolveInstrumentationLayout } = (await import(/* @vite-ignore */ layoutModule)) as {
    resolveInstrumentationLayout(input: { agentRoot: string }): { modulePathsBySlot: Record<string, string> };
  };
  return resolveInstrumentationLayout({ agentRoot }).modulePathsBySlot;
}

/** The first statement of a module source that is neither an import nor a comment. */
function firstStatement(source: string): string {
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const withoutImports = withoutComments.replace(/^\s*import\s[^;]*;?\s*$/gm, "");
  return withoutImports.trim().split("\n")[0]!.trim();
}

describe("the agent eve builds loads the model guard", () => {
  it("eve finds an instrumentation file that installs the guard as its first statement", async () => {
    const providers = await loadedProviders();
    const guarded = Object.values(providers).filter((path) => firstStatement(readFileSync(path, "utf8")) === "installRefusingDefaultProvider();");
    expect(Object.keys(providers), "eve would build this agent with no instrumentation at all").not.toHaveLength(0);
    expect(guarded, `none of the files eve loads installs the guard first: ${JSON.stringify(providers)}`).toHaveLength(1);
    expect(readFileSync(guarded[0]!, "utf8")).toMatch(/import\s*\{\s*installRefusingDefaultProvider\s*\}\s*from\s*["']@lares\/agent-kit\/gateway-budget["']/);
    // The same file holds the stop on an invalid agent definition.
    expect(readFileSync(guarded[0]!, "utf8")).toContain("bootDefinitionOrStop(");
  });

  it("loading what eve loads leaves the AI SDK's default provider refusing every request, and locked", async () => {
    // A fresh process (vitest isolates test files): nothing has installed a default provider yet.
    // Without this, the check below could be satisfied by something loaded earlier.
    expect(Object.getOwnPropertyDescriptor(globalThis, "AI_SDK_DEFAULT_PROVIDER")).toBeUndefined();
    for (const path of Object.values(await loadedProviders())) await import(/* @vite-ignore */ pathToFileURL(path).href);
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "AI_SDK_DEFAULT_PROVIDER");
    expect(descriptor).toBeDefined();
    expect(descriptor!.writable).toBe(false);
    expect(descriptor!.configurable).toBe(false);
    const provider = descriptor!.value as { languageModel(id: string): { doGenerate(): unknown; doStream(): unknown } };
    expect(() => provider.languageModel("anthropic/some-model").doGenerate()).toThrow("outside the engine's gateway");
    expect(() => provider.languageModel("anthropic/some-model").doStream()).toThrow("outside the engine's gateway");
  });
});
