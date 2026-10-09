/**
 * The article area setting and the grant check that goes with it (LAR articles child 1b).
 *
 * Three rules, from the owner's rulings:
 *   - `shared` (the default) + a shared area the filing agent may write -> articles go shared.
 *   - `shared` + an area it may not write (no grant, or the folder is not usable) -> private, and
 *     the pass says so (a real misconfiguration).
 *   - `private` -> private, and nothing is said.
 * The installation decides which agent is the shared agent by what that agent's own definition
 * grants on the shared area; the digest never widens a grant.
 */
import { describe, it, expect } from "vitest";

import { parseManifest } from "@lares/agent-kit/manifest";

import { articleTargets, readArticleAreaSetting } from "../lib/digest/article-area.js";

/** The literal name, on purpose: the settings scan in vault-format reads the code for it too. */
const ARTICLE_AREA_ENV = "LARES_ARTICLE_AREA";

const decl = (grants: unknown[], autonomy: Record<string, string> = {}) =>
  parseManifest({ name: "x", model: "m", persona: "p.md", channels: [], egress: { sealed: true }, grants, autonomy });

const writesShared = decl([{ capability: "vault", scope: "write-with-confirm", areas: ["private", "shared"] }]);
const readsShared = decl([{ capability: "vault", scope: "read", areas: ["private", "shared"] }]);
const privateOnly = decl([{ capability: "vault", scope: "write-with-confirm", areas: ["private"] }]);

describe("readArticleAreaSetting", () => {
  it("is shared when nothing is set (the engine default)", () => {
    expect(readArticleAreaSetting({})).toEqual({ area: "shared" });
    expect(readArticleAreaSetting({ [ARTICLE_AREA_ENV]: "" })).toEqual({ area: "shared" });
    expect(readArticleAreaSetting({ [ARTICLE_AREA_ENV]: "  " })).toEqual({ area: "shared" });
  });

  it("reads shared and private, ignoring case and surrounding spaces", () => {
    expect(readArticleAreaSetting({ [ARTICLE_AREA_ENV]: "shared" })).toEqual({ area: "shared" });
    expect(readArticleAreaSetting({ [ARTICLE_AREA_ENV]: "private" })).toEqual({ area: "private" });
    expect(readArticleAreaSetting({ [ARTICLE_AREA_ENV]: " Private " })).toEqual({ area: "private" });
  });

  it("fails closed on a value it does not know: private, with the value reported", () => {
    expect(readArticleAreaSetting({ [ARTICLE_AREA_ENV]: "everyone" })).toEqual({ area: "private", unrecognised: "everyone" });
  });
});

describe("articleTargets: where articles go, and the shared root the filer may use", () => {
  const log: string[] = [];
  const deps = (over: Partial<Parameters<typeof articleTargets>[0]> = {}): Parameters<typeof articleTargets>[0] => ({
    env: {},
    readDefinition: async () => writesShared,
    resolveShared: () => "/shared/root",
    log: (m) => { log.push(m); },
    ...over,
  });

  it("shared setting + a write grant on the shared area -> the shared root is offered", async () => {
    expect(await articleTargets(deps())).toEqual({ articleArea: "shared", sharedRoot: "/shared/root" });
  });

  it("shared setting + only a read grant on the shared area -> no shared root (never widened)", async () => {
    const out = await articleTargets(deps({ readDefinition: async () => readsShared }));
    expect(out).toEqual({ articleArea: "shared", sharedRoot: undefined });
  });

  it("shared setting + a grant that does not name the shared area -> no shared root", async () => {
    const out = await articleTargets(deps({ readDefinition: async () => privateOnly }));
    expect(out).toEqual({ articleArea: "shared", sharedRoot: undefined });
  });

  it("a vault autonomy of never closes the door even with a write grant", async () => {
    const never = decl([{ capability: "vault", scope: "write", areas: ["shared"] }], { vault: "never" });
    const out = await articleTargets(deps({ readDefinition: async () => never }));
    expect(out.sharedRoot).toBeUndefined();
  });

  it("a definition that cannot be read is not an open door: no shared root, and the reason is logged", async () => {
    log.length = 0;
    const out = await articleTargets(deps({ readDefinition: async () => { throw new Error("no definition"); } }));
    expect(out).toEqual({ articleArea: "shared", sharedRoot: undefined });
    expect(log.join("\n")).toContain("no definition");
  });

  it("shared setting + a grant but a shared area that is not connected -> no shared root", async () => {
    const out = await articleTargets(deps({ resolveShared: () => undefined }));
    expect(out).toEqual({ articleArea: "shared", sharedRoot: undefined });
  });

  it("private setting -> private, no shared root, and the definition is not even read", async () => {
    let read = false;
    const out = await articleTargets(deps({
      env: { [ARTICLE_AREA_ENV]: "private" },
      readDefinition: async () => { read = true; return writesShared; },
    }));
    expect(out).toEqual({ articleArea: "private", sharedRoot: undefined });
    expect(read).toBe(false);
  });

  it("an unknown value is private and logged", async () => {
    log.length = 0;
    const out = await articleTargets(deps({ env: { [ARTICLE_AREA_ENV]: "everyone" } }));
    expect(out).toEqual({ articleArea: "private", sharedRoot: undefined });
    expect(log.join("\n")).toContain("everyone");
  });

  it("logs why when the setting says shared but the agent may not write there", async () => {
    log.length = 0;
    await articleTargets(deps({ readDefinition: async () => readsShared }));
    expect(log.join("\n")).toMatch(/no write grant on the shared area/);
  });
});
