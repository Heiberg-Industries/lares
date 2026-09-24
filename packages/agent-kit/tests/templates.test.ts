// The role templates themselves, held to the same bar every real agent's declaration is
// (ORB-145 Phase 3). A template is EXTRACTED from a running agent, never invented, so the
// properties below are the ones that could quietly stop holding as one gets extracted from a
// second and a third agent: a role whose grants drift out of the schema, a write that lost its
// gate, an unsealed egress, prose that kept the owner's world, or a README that says what the
// role does without saying what it deliberately refuses to do.
//
// The exact-list assertion grows one entry per extraction task, so the suite is green at every
// commit rather than only at the end of the phase.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { loadManifest, assertDeclarationIntegrity, grantedVaultAreas, grantFor, isGranted, skillToolsFor } from "../src/manifest.js";
import { lintRole, toolNamesIn } from "../src/persona/lint.js";
import { docFor } from "../src/persona/capability-docs.js";

const ROOT = resolve(__dirname, "../templates");
const templates = readdirSync(ROOT, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);

/** The plain-`write` grants each template ships — the ones that write with NO approval card, by
 *  construction rather than by policy (ORB-145 whole-branch review, Important #4).
 *
 *  This list exists because the assertion it replaced was vacuous. `autonomy` bites ONLY on a
 *  tool carrying an approval (`manifest.ts`'s header, `decide.ts:33-39`), and
 *  `assertClassMatchesScope` FAILS THE BUILD on an approval under a plain `write` grant — so
 *  `"travel": "gated"` cannot gate anything: there is nothing gateable under it. Asserting
 *  `gated` over these names therefore proved nothing and read as though it proved a great deal.
 *
 *  What can honestly be enforced is that the set is DELIBERATE: an exact list, so adding a
 *  cardless write to a template is a red test and a decision, never a diff nobody read. Each
 *  README says, under "Writes without a card", who these actually reach. */
const PLAIN_WRITE_GRANTS: Record<string, readonly string[]> = {
  "chief-of-staff": ["digest", "obligation", "outreach"],
  creative: ["studio"],
  travel: ["admin", "persona", "shopping", "travel", "vault"],
};

/** `loadManifest`, deferred to test-run time and memoised (ORB-210 item 5).
 *
 *  This used to be a bare `const m = loadManifest(...)` in each `describe` body, which vitest
 *  evaluates while COLLECTING the file. A template with a malformed `agent.json` therefore threw
 *  before a single test existed: the whole file was reported as a collection error, naming a
 *  parse failure and no test at all, and the eight other assertions in it never ran. Loading
 *  inside the tests means a broken template fails "validates and passes declaration integrity" —
 *  by name — and the rest of the file still reports. */
const manifestCache = new Map<string, ReturnType<typeof loadManifest>>();
function manifestOf(template: string): ReturnType<typeof loadManifest> {
  const cached = manifestCache.get(template);
  if (cached) return cached;
  const m = loadManifest(resolve(ROOT, template, "agent.json"));
  manifestCache.set(template, m);
  return m;
}

const roleOf = (template: string): string => readFileSync(resolve(ROOT, template, "role.md"), "utf8");

describe("role templates", () => {
  it("ships exactly the roles extracted so far — no accountant until the accounting build exists", () => {
    expect(templates.sort()).toEqual(["chief-of-staff", "creative", "travel"]);
  });
  for (const t of templates) {
    describe(t, () => {
      it("validates and passes declaration integrity", () => { expect(() => assertDeclarationIntegrity(manifestOf(t))).not.toThrow(); });
      it("every write-with-confirm grant ships autonomy `gated` — the only scope autonomy bites on", () => {
        // `gated` here is load-bearing: these grants DO carry approvals, and walking one to
        // `autonomous` is what strips the card (`resolveExtensionTool`).
        const m = manifestOf(t);
        for (const g of m.grants) if (g.scope === "write-with-confirm") expect(m.autonomy[g.capability], `${t}:${g.capability}`).toBe("gated");
      });
      it("plain `write` grants are ungated BY CONSTRUCTION — this is the exact list of them", () => {
        // Not a policy this test enforces; a fact about the scope. See PLAIN_WRITE_GRANTS above
        // for why an autonomy assertion over these names would be theatre. The list is the
        // enforcement: a new cardless write in a template goes red here and gets read.
        const m = manifestOf(t);
        const plain = m.grants.filter((g) => g.scope === "write").map((g) => g.capability).sort();
        expect(plain, `${t}: plain-write grants changed — update PLAIN_WRITE_GRANTS and the README's "Writes without a card"`).toEqual(PLAIN_WRITE_GRANTS[t]);
        // The declared level stays at the safe baseline anyway, so that a grant later widened to
        // write-with-confirm inherits a gate rather than silently inheriting nothing.
        for (const name of plain) expect(m.autonomy[name], `${t}:${name}`).toBe("gated");
      });
      it("declares sealed egress", () => { expect(manifestOf(t).egress.sealed).toBe(true); });
      it("role.md passes the genericness lint", () => { expect(lintRole(roleOf(t))).toEqual([]); });
      it("names no tool the template's OWN grants cannot serve", () => {
        // ORB-210 item 3, one layer earlier than the assemble-time check. That one compares the
        // role text against a real agent's shipped tool FILES; this one compares it against the
        // template's own declaration, so a role.md and an agent.json that disagree are caught in
        // this package rather than in whichever service copies them next.
        const m = manifestOf(t);
        const served = new Set([
          ...m.grants.filter((g) => g.scope !== "none").flatMap((g) => docFor(g.capability).tools),
          ...m.skills.flatMap((s) => skillToolsFor(s.name)),
          ...m.framework_tools,
        ]);
        expect(toolNamesIn(roleOf(t)).filter((n) => !served.has(n)), t).toEqual([]);
      });
      it("README says what it is for, what it deliberately cannot do, and what writes with no card", () => {
        const r = readFileSync(resolve(ROOT, t, "README.md"), "utf8");
        expect(r).toMatch(/## What it is for/); expect(r).toMatch(/## What it deliberately cannot do/);
        // Important #4: the cardless writes have to be READABLE somewhere, since no assertion
        // can gate them. Every plain-write grant is named in the README, and so is who it reaches.
        expect(r).toMatch(/## Writes without a card/);
        for (const g of manifestOf(t).grants) if (g.scope === "write") expect(r, `${t}: README never names the cardless write \`${g.capability}\``).toContain(`\`${g.capability}\``);
      });
    });
  }
  it("travel is granted no note area — standing facts and nothing else", () => {
    // The role this was extracted from has never had a knowledge vault, and its own role text
    // says so ("I have no knowledge vault or second brain of any kind"). Before W5C-s6 that was
    // checked as the ABSENCE of a `brain` grant; one `vault` capability makes the same check
    // finer and states it positively — the grant names `facts` and neither note area, so
    // `grantedToolNames` offers this role no note tool at all, whatever the pool holds.
    expect(grantedVaultAreas(manifestOf("travel"))).toEqual(["facts"]);
    expect(grantFor(manifestOf("travel"), "vault", "private")).toBeUndefined();
    expect(grantFor(manifestOf("travel"), "vault", "shared")).toBeUndefined();
  });

  // W5C-s6 — the per-file values, held as one table so a drifting grant is one red line.
  it("grants vault, with exactly the areas each role needs", () => {
    expect(grantFor(manifestOf("chief-of-staff"), "vault"))
      .toMatchObject({ scope: "write-with-confirm", areas: ["private", "shared", "facts"] });
    expect(grantFor(manifestOf("creative"), "vault"))
      .toMatchObject({ scope: "write-with-confirm", areas: ["shared"] });
    expect(grantFor(manifestOf("travel"), "vault"))
      .toMatchObject({ scope: "write", areas: ["facts"] });
  });

  it("keeps least privilege: creative still cannot read the private area", () => {
    expect(grantFor(manifestOf("creative"), "vault", "private")).toBeUndefined();
    expect(grantFor(manifestOf("creative"), "vault", "facts")).toBeUndefined();
  });

  it("grants no old name anywhere, and every autonomy key still matches a grant", () => {
    for (const t of templates) {
      for (const gone of ["brain", "atlas", "memory"]) {
        expect(isGranted(manifestOf(t), gone), `${t}: ${gone}`).toBe(false);
        expect(Object.keys(manifestOf(t).autonomy), `${t}: ${gone}`).not.toContain(gone);
      }
      expect(() => assertDeclarationIntegrity(manifestOf(t)), t).not.toThrow();
    }
  });
});
