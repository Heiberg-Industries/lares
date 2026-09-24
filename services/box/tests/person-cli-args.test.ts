// The two by-hand commands are documented as `pnpm -C services/box run <script> -- <who> …`, and
// pnpm hands the bare `--` through to the script. A parser that refuses it makes the documented
// command fail on its first word — which is what both of them did.
import { describe, expect, it } from "vitest";

import { parseArgs as parseErase } from "../bin/erase-person.js";
import { parseArgs as parseExport } from "../bin/export-person.js";

describe("the erase and export commands accept pnpm's bare -- separator", () => {
  it("erase-person", () => {
    const args = parseErase(["--", "fixture-owner", "--vault", "/srv/a-vault", "--apply"]);
    expect(args).toMatchObject({ person: "fixture-owner", apply: true, vaults: ["/srv/a-vault"] });
  });

  it("export-person", () => {
    const args = parseExport(["--", "fixture-owner", "--out", "/var/tmp/an-export"]);
    expect(args).toMatchObject({ person: "fixture-owner" });
  });

  it("still refuses a flag neither command knows", () => {
    expect(() => parseErase(["fixture-owner", "--force"])).toThrow(/unknown flag/);
    expect(() => parseExport(["fixture-owner", "--force"])).toThrow(/unknown flag/);
  });
});
