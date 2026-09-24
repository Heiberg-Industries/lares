import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

// eve 0.50.0 required every extension to be rebuilt against new stream-event contracts, and
// 0.60.1 emits a machine-checkable manifest saying which contract versions the build needs.
// A stale dist/extension does not warn; it fails to load at runtime. This asserts freshness.
const manifestPath = fileURLToPath(new URL("../dist/extension/_manifest.json", import.meta.url));

describe("the built extension is current with the installed eve", () => {
  it("emits a _manifest.json", () => {
    expect(existsSync(manifestPath)).toBe(true);
  });

  it("is format version 2 and was built with the installed eve", () => {
    const m = JSON.parse(readFileSync(manifestPath, "utf8"));
    const installed = JSON.parse(
      readFileSync(fileURLToPath(new URL("../node_modules/eve/package.json", import.meta.url)), "utf8"),
    ).version;
    expect(m.kind).toBe("eve-extension");
    expect(m.formatVersion).toBe(2);
    expect(m.builtWithEve).toBe(installed);
  });

  it("requires no capability contract this eve cannot consume", async () => {
    const m = JSON.parse(readFileSync(manifestPath, "utf8"));
    const { findUnsupportedExtensionCapabilities } = await import(
      fileURLToPath(new URL("../node_modules/eve/dist/src/compiler/extension-compatibility.js", import.meta.url))
    );
    expect(findUnsupportedExtensionCapabilities(m)).toEqual([]);
  });
});
