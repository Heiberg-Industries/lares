// The guard against the defect no type can catch: a composition root wired to a
// wrong-but-PRESENT value. notion-sync Phase 4 shipped that three times — each one passed
// typecheck and the full suite, and each one quietly read the wrong store.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertReaderWiring, probeLocalStores } from "../lib/config.js";
import { makeFsReader } from "../lib/adapters/fs-source.js";
import type { ReaderMap, SourceReader } from "../lib/resolve.js";

const stub = (id: string): SourceReader =>
  ({ id, read: async (ref) => ({ ref, outcome: "found", content: "x" }) });

const good = (): ReaderMap => ({
  repo: stub("github"), vault: stub("vault"), notion: stub("notion"), atlas: stub("atlas"),
});

let fixtureAtlas: string;
let fixtureVault: string;

beforeAll(() => {
  fixtureAtlas = mkdtempSync(join(tmpdir(), "atlas-wiring-atlas-"));
  fixtureVault = mkdtempSync(join(tmpdir(), "atlas-wiring-vault-"));
  // The two sentinels, each present in exactly one store — which is what makes the probe a
  // semantic contradiction rather than a spelling check.
  writeFileSync(join(fixtureAtlas, "SCHEMA.md"), "# Schema\n");
  mkdirSync(join(fixtureVault, "_meta"), { recursive: true });
  writeFileSync(join(fixtureVault, "index.md"), "# Index\n");
});

afterAll(() => {
  rmSync(fixtureAtlas, { recursive: true, force: true });
  rmSync(fixtureVault, { recursive: true, force: true });
});

describe("assertReaderWiring", () => {
  it("accepts a correctly wired map", () => {
    expect(() => assertReaderWiring(good())).not.toThrow();
  });

  it("REJECTS the same reader wired to two prefixes — the copy-paste root", () => {
    // This is the defect the sentinel exists for: `vault: makeFsReader({id:"vault", root: atlasPath})`
    // typechecks, passes every unit test, and quietly derives every vault-backed note from
    // the Atlas itself.
    const map = good();
    map.vault = map.atlas;
    expect(() => assertReaderWiring(map)).toThrow(/distinct/i);
  });

  it("REJECTS a reader whose id is not the one that prefix expects", () => {
    const map = good();
    map.repo = stub("vault");
    expect(() => assertReaderWiring(map)).toThrow(/repo/i);
  });

  it("REJECTS a missing prefix", () => {
    const map = good();
    delete (map as unknown as Record<string, unknown>)["notion"];
    expect(() => assertReaderWiring(map)).toThrow(/notion/i);
  });
});

describe("probeLocalStores", () => {
  it("passes when both local stores answer their sentinel file", async () => {
    await expect(probeLocalStores({
      ...good(),
      atlas: makeFsReader({ id: "atlas", root: fixtureAtlas }),
      vault: makeFsReader({ id: "vault", root: fixtureVault }),
    })).resolves.toBeUndefined();
  });

  it("REFUSES to start when the vault reader is pointed at the Atlas", async () => {
    // The semantic contradiction: the Atlas has no `index.md`, the vault does. A root that
    // wired both readers at the same root cannot answer both probes — and this is precisely
    // the wiring that `assertReaderWiring` CANNOT catch, because two separately-constructed
    // readers with correct ids are distinct instances. Types pass, ids pass, the store is
    // still wrong. Only asking the filesystem settles it.
    await expect(probeLocalStores({
      ...good(),
      atlas: makeFsReader({ id: "atlas", root: fixtureAtlas }),
      vault: makeFsReader({ id: "vault", root: fixtureAtlas }),
    })).rejects.toThrow(/vault/i);
  });

  it("REFUSES to start when the Atlas mount is missing entirely", async () => {
    await expect(probeLocalStores({
      ...good(),
      atlas: makeFsReader({ id: "atlas", root: join(fixtureAtlas, "does-not-exist") }),
      vault: makeFsReader({ id: "vault", root: fixtureVault }),
    })).rejects.toThrow(/ATLAS_PATH is wrong|not mounted/i);
  });
});
