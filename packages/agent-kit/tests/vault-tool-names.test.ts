// W5C-s4 — the three personal WRITE tools take the one name, and take an area.
//
// This file is the slice's guard, and it has three jobs, in descending order of how much a
// regression would cost:
//
//   1. NEVER WIDEN, FOR WRITES. A write tool used to be bound to one store at construction
//      (`storeRoot("brain")`), so the filename was the permission. The area is an INPUT now, so
//      the permission has to be somewhere else — and it is in two places at once: the kit's
//      write tools serve the personal area and nothing else (`KIT_WRITE_AREAS`), and on top of
//      that the session's own declaration must grant the area (`areas`, the same injected
//      authority W5C-s3 gave the reads). Both are asserted below against the REAL committed
//      declarations, not fixtures: chief-of-staff is granted `brain` AND `atlas`, so the
//      declaration alone would open the shared area to its `vault_write` — the tool's own
//      constant is what keeps that shut.
//   2. THE APPROVAL GATE CARRIES OVER EXACTLY. Every renamed tool keeps the capability it was
//      registered under, the always-ask category it had, and the ratchet key `(agent,
//      capability, action)` it was gated under. The expected values below are LITERALS, read
//      out of the pre-rename tree with `git show`, so this test cannot drift with the code it
//      is watching. A rename that turned an approved `brain`/`atlas` level into a lookup miss,
//      or a gated tool into an ungated one, is the failure this slice exists to avoid.
//   3. The old names are gone from `packages/` and `services/` — the plan's grep, scoped the
//      way the plan scopes it. Historical prose under `docs/` is NOT rewritten.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { areaOfTool, capabilityOfTool, mustAlwaysAsk, TOOL_CATEGORIES } from "../src/always-ask.js";
import { MODEL_ALIAS_RE } from "../src/definition.js";
import { storeForArea } from "../src/notes-store.js";
import { grantedVaultAreas, parseManifest } from "../src/manifest.js";
import { KIT_WRITE_AREAS, writableAreas } from "../extension/lib/note-write-tools.js";
import vaultWrite from "../extension/tools/vault_write.js";
import vaultFile from "../extension/tools/vault_file.js";
import vaultDrop from "../extension/tools/vault_drop.js";

const MOUNTED = { vault_write: vaultWrite, vault_file: vaultFile, vault_drop: vaultDrop } as const;

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, "..", "..", "..");

/** Built at runtime so this file's own source does not trip the grep it runs. */
const OLD_WRITE_NAMES = new RegExp(String.raw`\bbrain_(write|file|drop)\b`);

const TEXT = /\.(ts|tsx|mts|js|mjs|json|md|txt|py|ya?ml|sql|sh)$/;

/** Every tracked text file under the scopes the plan names. `git ls-files` already excludes
 *  `dist/` and everything else gitignored, so a built artefact can never fail this. */
function trackedFiles(...scopes: string[]): string[] {
  return execFileSync("git", ["ls-files", "-z", ...scopes], { cwd: REPO, encoding: "utf8" })
    .split("\0")
    .filter((p) => p.length > 0 && TEXT.test(p));
}

/** THIS file, and only this file. It carries the old names on purpose — they are the
 *  before-column of the gate table below, which is the whole point of that table: it must not
 *  be rewritable into agreement with the code it is watching. */
const SELF = "packages/agent-kit/tests/vault-tool-names.test.ts";

describe("the old write-tool names are gone from the engine", () => {
  it("registers no brain_write/brain_file/brain_drop anywhere in packages or services", () => {
    const hits = trackedFiles("packages", "services").filter(
      (p) => p !== SELF && OLD_WRITE_NAMES.test(readFileSync(join(REPO, p), "utf8")),
    );
    expect(hits).toEqual([]);
  });

  it("…and this file really is the one exception, not a stale path that excludes nothing", () => {
    expect(trackedFiles("packages")).toContain(SELF);
  });
});

describe("the three vault write tools exist under the one name", () => {
  it("the kit's extension mounts them", () => {
    for (const [name, tool] of Object.entries(MOUNTED)) {
      expect(tool, `${name} must be a tool`).toBeTruthy();
      expect(typeof tool.execute, `${name}.execute`).toBe("function");
    }
  });

  it("keeps the approval on every one of them", () => {
    for (const [name, tool] of Object.entries(MOUNTED)) {
      expect(tool.approval, `${name} must still be gated`).toBeDefined();
    }
  });

  it("each takes a required area", () => {
    for (const [name, tool] of Object.entries(MOUNTED)) {
      const schema = tool.inputSchema as unknown as { parse(v: unknown): { area?: string } };
      expect(() => schema.parse({ title: "t", body: "b", path: "p", destination: "d" }), name).toThrow();
      expect(schema.parse({ area: "private", title: "t", body: "b", path: "p", destination: "d" }), name)
        .toMatchObject({ area: "private" });
    }
  });

  it("a mounted copy has NO area authority, so it writes nothing", async () => {
    // Fail closed: the only thing standing between the model and the owner's notes when nobody
    // has wired an authority up is this refusal. The approver check fires first, so this case
    // asserts the tool never reaches a store root either way.
    await expect(
      vaultWrite.execute({ area: "private", title: "t", body: "b" }, { session: { id: "s", auth: null } } as never),
    ).rejects.toThrow();
  });
});

/**
 * WHAT EACH WRITE TOOL WAS GATED UNDER BEFORE THE RENAME — literals, read out of the tree at
 * `21c5db3` (W5C-s3) with `git show`, never computed from the code this test is watching.
 *
 * `action` is the third column of the ratchet key `(agent, capability, action)`. `actionBefore`
 * is the row each tool USED to resolve — the capability's own default, `action = ''` — and
 * `action` is the row it resolves today: W5C-s8's ruling makes a vault tool's AREA its action, so
 * `(agent, "atlas", "")` became `(agent, "vault", "shared")` and not the merged `(agent, "vault",
 * "")`. None of the four passes `boardApproval`'s `action` option; the key is derived in
 * `boardApproval` itself. `services/box/sql/077_capability_rename.sql` re-keys the old rows the
 * same way. The chief-of-staff three do not reach the board at all: their approval is eve's
 * unconditional `always()`, which is stricter than any board level and is why W5C-s7 has
 * nothing of theirs to migrate.
 *
 * W5C-s5 MOVED ALL FOUR ONTO ONE CAPABILITY, `vault` — so `capability` below is what the board
 * row is keyed on TODAY, and `areaBefore` records the thing that name used to carry on its own:
 * which store the tool touches. That is now `areaOfTool`'s answer, and it is what decides
 * whether a session is offered the tool at all, so it is pinned here beside the capability it
 * was split out of.
 */
const GATE_BEFORE = [
  {
    before: "agent-kit__brain_write", after: "agent-kit__vault_write",
    capability: "vault", area: "private", categories: [] as string[], ask: false, actionBefore: "", action: "private", gate: "always()",
  },
  {
    before: "agent-kit__brain_file", after: "agent-kit__vault_file",
    capability: "vault", area: "private", categories: [] as string[], ask: false, actionBefore: "", action: "private", gate: "always()",
  },
  {
    before: "agent-kit__brain_drop", after: "agent-kit__vault_drop",
    capability: "vault", area: "private", categories: ["delete"], ask: true, actionBefore: "", action: "private", gate: "always()",
  },
  {
    before: "atlas_write", after: "vault_write",
    capability: "vault", area: "shared", categories: [] as string[], ask: false, actionBefore: "", action: "shared", gate: "approvalFor",
  },
] as const;

describe("the approval gate carries over exactly", () => {
  for (const row of GATE_BEFORE) {
    it(`${row.before} → ${row.after} sits under "${row.capability}", area "${row.area}"`, () => {
      expect(capabilityOfTool(row.after)).toBe(row.capability);
      // The area is what the old capability name used to say on its own. Two tools that share
      // one capability but not one area are still offered to different agents.
      expect(areaOfTool(row.after)).toBe(row.area);
    });

    it(`${row.before} → ${row.after} keeps its always-ask category`, () => {
      expect(TOOL_CATEGORIES[row.after]).toEqual(row.categories);
      expect(mustAlwaysAsk(row.after).ask).toBe(row.ask);
    });
  }

  // CHANGED DELIBERATELY BY W7A-s2, and the `gate: "always()"` literals above stay as history.
  // The unconditional gate was stricter than any board level, which is why W5C-s7 had nothing of
  // theirs to migrate — but it also meant a 🚫 on "Private notes" did not refuse a note write and
  // no evidence row was ever recorded. The factory's DEFAULT is still `always()` (the mounted
  // copies have no board to reach); the chief of staff's three now inject the board's own check.
  it("the chief-of-staff three default to always(), and the role injects the board instead", () => {
    const src = readFileSync(join(here, "..", "extension", "lib", "note-write-tools.ts"), "utf8");
    expect(src, "the no-policy default must stay `always()`").toContain("(deps?.approval ?? always()) as never");
    expect(src, "no factory may hard-code the gate again").not.toMatch(/approval:\s*always\(\)/);
    for (const name of ["agent-kit__vault_write", "agent-kit__vault_file", "agent-kit__vault_drop"]) {
      const file = readFileSync(join(REPO, "services", "chief-of-staff", "catalogue", `${name}.ts`), "utf8");
      expect(file, name).toContain(`approvalFor("${name}")`);
      // Same reason creative's passes none: the ratchet action is derived from the tool's area.
      expect(file, name).not.toMatch(/\baction\s*:/);
    }
  });

  it("creative's vault_write still names ITSELF to the board, with no per-action key", () => {
    const src = readFileSync(join(REPO, "services", "creative", "catalogue", "vault_write.ts"), "utf8");
    expect(src).toContain('approvalFor("vault_write")');
    // No `action:` option anywhere in the file — and it needs none. Since W5C-s8 the ratchet row
    // is `(agent, "vault", "shared")`, derived from the tool's own area inside `boardApproval`,
    // which is 1:1 with the `(agent, "atlas", "")` row `approvalFor("atlas_write")` used to read.
    // A tool that named its own action here would be overriding that derivation, not completing it.
    expect(src).not.toMatch(/\baction\s*:/);
  });
});

/** The REAL committed neutral declarations — what each role is actually granted today. */
function template(role: string): unknown {
  return JSON.parse(readFileSync(join(here, "..", "templates", role, "agent.json"), "utf8"));
}

describe("never widen: what each role can WRITE after the rename is what it could write before", () => {
  it("chief-of-staff is granted BOTH note areas, so the declaration alone is not the guard", () => {
    // `brain` AND `atlas` (plus `memory` → facts). Folding the READS was safe because it already
    // had `agent-kit__vault_read` and `atlas_read`; folding the WRITES on this alone would have
    // handed it a shared-store write it has never had.
    expect(grantedVaultAreas(parseManifest(template("chief-of-staff")))).toEqual(["private", "shared", "facts"]);
  });

  it("the kit's write tools serve the personal area and nothing else", () => {
    expect([...KIT_WRITE_AREAS]).toEqual(["private"]);
  });

  it("chief-of-staff's write authority is the personal area alone", () => {
    const granted = grantedVaultAreas(parseManifest(template("chief-of-staff")));
    expect(writableAreas(granted)).toEqual(["private"]);
  });

  it("creative is granted the shared area alone, and its own write tool serves only that", () => {
    expect(grantedVaultAreas(parseManifest(template("creative")))).toEqual(["shared"]);
    // …and the kit's three write tools would open nothing for it even if it mounted them live.
    expect(writableAreas(grantedVaultAreas(parseManifest(template("creative"))))).toEqual([]);
  });

  it("travel is granted no NOTE area at all, before or after", () => {
    expect(grantedVaultAreas(parseManifest(template("travel")))).toEqual(["facts"]);
    expect(writableAreas(grantedVaultAreas(parseManifest(template("travel"))))).toEqual([]);
  });
});

describe("brain survives where it is NOT a capability or a tool", () => {
  it("keeps the model alias purpose", () => {
    expect(MODEL_ALIAS_RE.test("fixture-brain")).toBe(true);
  });

  it("keeps the store name the private area resolves to", () => {
    expect(storeForArea("private")).toBe("brain");
  });
});
