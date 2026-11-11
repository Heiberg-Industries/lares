import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeAll } from "vitest";

// A built extension carries a machine-checkable manifest, `dist/extension/_manifest.json`, and
// eve reads it before it loads any of the extension's code. A stale dist/extension does not warn;
// it fails to load at runtime. This asserts freshness.
//
// The contract, as eve 1.0 ships it (`compiler/extension-compatibility.js`):
//   - the manifest is format version 3: `kind`, `formatVersion`, `builtWithEve`, `contractMajor`,
//     and nothing else but an optional `build.externalDependencies`;
//   - eve's own parser refuses anything else, and names the older formats (1 and 2) as needing a
//     rebuild;
//   - `checkExtensionVersionCompatibility(manifest, installedVersion)` answers `undefined` for a
//     distribution this eve can mount, or says why not: the extension was built with a newer eve,
//     or its distribution contract is one this eve does not support.
// Earlier eve versions listed the capability contracts an extension needed, one by one, and
// exported `findUnsupportedExtensionCapabilities` to check them. That list is gone: one
// `contractMajor` number stands for the whole distribution contract, and eve's discovery refuses
// an extension whose manifest is invalid or incompatible (the last two tests pin that the check
// still refuses).
const manifestPath = fileURLToPath(new URL("../dist/extension/_manifest.json", import.meta.url));
const evePackage = (file: string) => fileURLToPath(new URL(`../node_modules/eve/${file}`, import.meta.url));

type Manifest = { kind: string; formatVersion: number; builtWithEve: string; contractMajor: number };
type Incompatibility = { kind: "newer-eve"; minimumVersion: string } | { kind: "unsupported-contract"; contractMajor: number };

// eve INTERNALS, imported by file path because the package's exports map does not expose them.
// If an eve upgrade moves or reshapes this module, this suite failing is the signal to read the
// new contract, not to delete the check.
let compatibility: {
  EXTENSION_COMPATIBILITY_MANIFEST_FORMAT_VERSION: number;
  SUPPORTED_EXTENSION_DISTRIBUTION_CONTRACT_MAJORS: readonly number[];
  UnsupportedExtensionManifestVersionError: new (...args: never[]) => Error;
  checkExtensionVersionCompatibility(manifest: Manifest, consumerVersion: string): Incompatibility | undefined;
  parseExtensionCompatibilityManifest(raw: string, manifestPath: string): Manifest;
};
let installed: string;

beforeAll(async () => {
  compatibility = await import(evePackage("dist/src/compiler/extension-compatibility.js"));
  installed = (JSON.parse(readFileSync(evePackage("package.json"), "utf8")) as { version: string }).version;
});

describe("the built extension is current with the installed eve", () => {
  it("emits a _manifest.json", () => {
    expect(existsSync(manifestPath)).toBe(true);
  });

  it("is the format version the installed eve writes, and was built with the installed eve", () => {
    const m = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
    expect(m.kind).toBe("eve-extension");
    expect(m.formatVersion).toBe(3);
    expect(m.formatVersion).toBe(compatibility.EXTENSION_COMPATIBILITY_MANIFEST_FORMAT_VERSION);
    expect(m.builtWithEve).toBe(installed);
  });

  it("passes eve's own manifest parser and compatibility check", () => {
    const m = compatibility.parseExtensionCompatibilityManifest(readFileSync(manifestPath, "utf8"), manifestPath);
    expect(compatibility.SUPPORTED_EXTENSION_DISTRIBUTION_CONTRACT_MAJORS).toContain(m.contractMajor);
    expect(compatibility.checkExtensionVersionCompatibility(m, installed)).toBeUndefined();
  });

  it("eve still refuses a distribution it cannot mount", () => {
    const m = compatibility.parseExtensionCompatibilityManifest(readFileSync(manifestPath, "utf8"), manifestPath);
    const unsupported = Math.max(...compatibility.SUPPORTED_EXTENSION_DISTRIBUTION_CONTRACT_MAJORS) + 1;
    expect(compatibility.checkExtensionVersionCompatibility({ ...m, contractMajor: unsupported }, installed)).toEqual({
      contractMajor: unsupported,
      kind: "unsupported-contract",
    });
    expect(compatibility.checkExtensionVersionCompatibility({ ...m, builtWithEve: "999.0.0" }, installed)).toEqual({
      kind: "newer-eve",
      minimumVersion: "999.0.0",
    });
  });

  it("eve still refuses a manifest in an older format, or with fields it does not know", () => {
    const m = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
    for (const formatVersion of [1, 2]) {
      expect(() => compatibility.parseExtensionCompatibilityManifest(JSON.stringify({ ...m, formatVersion }), manifestPath)).toThrow(
        compatibility.UnsupportedExtensionManifestVersionError,
      );
    }
    expect(() => compatibility.parseExtensionCompatibilityManifest(JSON.stringify({ ...m, capabilities: { tools: 99 } }), manifestPath)).toThrow(
      /is invalid/,
    );
    expect(() => compatibility.parseExtensionCompatibilityManifest("{", manifestPath)).toThrow(/not valid JSON/);
  });
});
