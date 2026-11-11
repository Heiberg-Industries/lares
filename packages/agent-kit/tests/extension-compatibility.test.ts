import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

// Every eve extension has to be rebuilt for the eve that loads it. `eve extension build` writes
// a machine-checkable manifest beside the build, and eve reads it BEFORE it loads any of the
// extension's code: a distribution in an older manifest format, on an unsupported contract, or
// built with a newer eve than the one installed is refused. A stale dist/extension does not
// warn at build time; it fails to load at runtime. This asserts freshness with the framework's
// own reader and check (`dist/src/compiler/extension-compatibility.js`), not a copy of them.
const manifestPath = fileURLToPath(new URL("../dist/extension/_manifest.json", import.meta.url));

interface Compatibility {
  EXTENSION_COMPATIBILITY_MANIFEST_FORMAT_VERSION: number;
  SUPPORTED_EXTENSION_DISTRIBUTION_CONTRACT_MAJORS: readonly number[];
  parseExtensionCompatibilityManifest(raw: string, path: string): { kind: string; formatVersion: number; builtWithEve: string; contractMajor: number };
  checkExtensionVersionCompatibility(manifest: unknown, consumerVersion: string): unknown;
}
const compatibility = async (): Promise<Compatibility> =>
  (await import(fileURLToPath(new URL("../node_modules/eve/dist/src/compiler/extension-compatibility.js", import.meta.url)))) as Compatibility;
const installedEve = (): string =>
  JSON.parse(readFileSync(fileURLToPath(new URL("../node_modules/eve/package.json", import.meta.url)), "utf8")).version;

describe("the built extension is current with the installed eve", () => {
  it("emits a _manifest.json", () => {
    expect(existsSync(manifestPath)).toBe(true);
  });

  it("is in the manifest format the installed eve writes and was built with the installed eve", async () => {
    const { EXTENSION_COMPATIBILITY_MANIFEST_FORMAT_VERSION, parseExtensionCompatibilityManifest } = await compatibility();
    // eve's own parser: it throws on the older "epoch" formats (1 and 2) and on anything invalid.
    const m = parseExtensionCompatibilityManifest(readFileSync(manifestPath, "utf8"), manifestPath);
    expect(m.kind).toBe("eve-extension");
    // eve 1.0 writes format 3. Held against the framework's constant as well, so an eve upgrade
    // that moves the format turns this red until the kit is rebuilt.
    expect(EXTENSION_COMPATIBILITY_MANIFEST_FORMAT_VERSION).toBe(3);
    expect(m.formatVersion).toBe(EXTENSION_COMPATIBILITY_MANIFEST_FORMAT_VERSION);
    expect(m.builtWithEve).toBe(installedEve());
  });

  it("requires no distribution contract this eve cannot consume", async () => {
    const { SUPPORTED_EXTENSION_DISTRIBUTION_CONTRACT_MAJORS, parseExtensionCompatibilityManifest, checkExtensionVersionCompatibility } = await compatibility();
    const m = parseExtensionCompatibilityManifest(readFileSync(manifestPath, "utf8"), manifestPath);
    expect(SUPPORTED_EXTENSION_DISTRIBUTION_CONTRACT_MAJORS).toContain(m.contractMajor);
    // The check eve runs before mounting: `undefined` means compatible.
    expect(checkExtensionVersionCompatibility(m, installedEve())).toBeUndefined();
    // ...and it is a real check: the same manifest is refused by an older eve and on a contract
    // this eve does not support.
    expect(checkExtensionVersionCompatibility(m, "0.60.1")).toMatchObject({ kind: "newer-eve" });
    expect(checkExtensionVersionCompatibility({ ...m, contractMajor: 99 }, installedEve())).toMatchObject({ kind: "unsupported-contract" });
  });
});
