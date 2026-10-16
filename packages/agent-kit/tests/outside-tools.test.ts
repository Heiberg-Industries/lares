import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { hashOf, parseDefinition } from "../src/definition.js";
import { validateDefinition } from "../src/definition-validate.js";
import { checkOutsideUrl, outsideHttpsHosts, outsideSecretName, outsideToolsInEffect } from "../src/outside-tools.js";
import { assemblePersona } from "../src/persona/index.js";

const ROLE = "I keep the books.\n";
const entry = (over: Record<string, unknown> = {}) => ({
  name: "registry", url: "https://tools.example.org/mcp", description: "Looks up companies by name.",
  token: false, tools: { allow: ["lookup", "create_note"], read: ["lookup"] }, ...over,
});
const base = (over: Record<string, unknown> = {}) =>
  parseDefinition({
    name: "bookkeeper", display: "Bookkeeper", model: "lares-utility", persona: "agent/instructions.md",
    role: "chief-of-staff",
    grants: [{ capability: "gmail", scope: "write-with-confirm" }, { capability: "outside", scope: "write-with-confirm" }],
    autonomy: { gmail: "gated", outside: "gated" },
    outsideTools: [entry()],
    ...over,
  });
const check = (over: Record<string, unknown> = {}, secretExists: (n: string) => boolean = () => true) =>
  validateDefinition({ definition: base(over), roleMd: ROLE, deployedTools: [], secretExists });
const messages = (f: { check: string; message: string }[]) => f.filter((x) => x.check === "outside-tools").map((x) => x.message).join(" | ");

describe("outsideTools in the definition", () => {
  it("is optional with no default, so existing definitions keep their hash", () => {
    const raw = { name: "bookkeeper", display: "Bookkeeper", model: "lares-utility", persona: "agent/instructions.md", role: "chief-of-staff", grants: [{ capability: "gmail", scope: "write-with-confirm" }], autonomy: { gmail: "gated" } };
    const d = parseDefinition(raw);
    expect(Object.hasOwn(d, "outsideTools")).toBe(false);
    // Computed on the code BEFORE this field existed; it must never move.
    expect(hashOf({ definition: d, dutiesMd: "d", voiceMd: "v" })).toBe("46c1f7fa96bb3ddea5641436201565d85c66b9e5a80913023e435a9a25d0e9ea");
  });

  it("keeps every service's neutral agent.json free of outsideTools", () => {
    for (const service of ["chief-of-staff", "creative"]) {
      const path = join(__dirname, "..", "..", "..", "services", service, "agent.json");
      if (!existsSync(path)) continue;
      const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      expect(Object.hasOwn(raw, "outsideTools")).toBe(false);
      expect(Object.hasOwn(parseDefinition(raw), "outsideTools")).toBe(false);
    }
  });

  it("applies the defaults and refuses unknown keys, bad names and an empty allow list", () => {
    const d = base();
    expect(d.outsideTools?.[0]).toMatchObject({ token: false, trusted: false });
    expect(() => base({ outsideTools: [entry({ extra: 1 })] })).toThrow();
    expect(() => base({ outsideTools: [entry({ name: "Bad_Name" })] })).toThrow();
    expect(() => base({ outsideTools: [entry({ name: "9x" })] })).toThrow();
    expect(() => base({ outsideTools: [entry({ tools: { allow: [], read: [] } })] })).toThrow();
    expect(() => base({ outsideTools: [entry({ description: "x".repeat(501) })] })).toThrow();
    expect(() => base({ outsideTools: [entry({ description: "" })] })).toThrow();
  });
});

describe("validateDefinition: outside tools", () => {
  it("passes a well-formed entry", () => {
    expect(check()).toEqual([]);
  });

  it("passes a definition with no outside tools and no grant", () => {
    expect(check({ outsideTools: undefined, grants: [{ capability: "gmail", scope: "read" }], autonomy: { gmail: "gated" } })).toEqual([]);
  });

  it("refuses duplicate names", () => {
    expect(messages(check({ outsideTools: [entry(), entry()] }))).toMatch(/listed twice/);
  });

  it("refuses a read list that is not a subset of allow", () => {
    expect(messages(check({ outsideTools: [entry({ tools: { allow: ["lookup"], read: ["lookup", "other"] } })] }))).toMatch(/not in allow/);
  });

  it("requires a grant of the outside capability", () => {
    const f = check({ grants: [{ capability: "gmail", scope: "write-with-confirm" }], autonomy: { gmail: "gated" } });
    expect(messages(f)).toMatch(/holds no "outside" grant/);
    const none = check({ grants: [{ capability: "outside", scope: "none" }], autonomy: {} });
    expect(messages(none)).toMatch(/holds no "outside" grant/);
  });

  it("under a read grant, every allowed tool must be marked read", () => {
    const grants = [{ capability: "outside", scope: "read" }];
    expect(messages(check({ grants, autonomy: { outside: "gated" } }))).toMatch(/create_note/);
    const ok = check({ grants, autonomy: { outside: "gated" }, outsideTools: [entry({ tools: { allow: ["lookup"], read: ["lookup"] } })] });
    expect(ok).toEqual([]);
  });

  it("refuses an ungated write grant", () => {
    expect(messages(check({ grants: [{ capability: "outside", scope: "write" }], autonomy: { outside: "gated" } }))).toMatch(/no confirmation/);
  });

  it("autonomy never is not an error but resolves nothing", () => {
    const d = base({ autonomy: { gmail: "gated", outside: "never" } });
    expect(check({ autonomy: { gmail: "gated", outside: "never" } })).toEqual([]);
    expect(outsideToolsInEffect(d)).toEqual([]);
    expect(outsideToolsInEffect(base())).toHaveLength(1);
    expect(outsideToolsInEffect(base({ grants: [{ capability: "outside", scope: "none" }], autonomy: {} }))).toEqual([]);
  });

  it("refuses unsafe URLs", () => {
    for (const url of [
      "http://tools.example.org/mcp", "https://10.0.0.5/mcp", "https://[::1]/mcp", "https://user:pw@tools.example.org/mcp",
      "https://tools.example.org:8443/mcp", "https://tools.example.org/mcp#frag", "ftp://tools.example.org", "https://localhost/mcp",
      "https://tools.internal/mcp", "https://registry/mcp", "not a url", "http://10.0.0.5:3000/mcp", "http://tools.example.org:3000/mcp",
    ]) {
      expect(messages(check({ outsideTools: [entry({ url })] })), url).not.toBe("");
    }
  });

  it("accepts https on a public hostname and http on a single-word service name", () => {
    expect(check({ outsideTools: [entry({ url: "https://tools.example.org:443/mcp" })] })).toEqual([]);
    expect(check({ outsideTools: [entry({ url: "http://registry-svc:3000/mcp" })] })).toEqual([]);
  });

  it("token: true requires the secret file, named after the agent and the entry", () => {
    const seen: string[] = [];
    const f = check({ outsideTools: [entry({ token: true })] }, (n) => { seen.push(n); return false; });
    expect(seen).toContain("bookkeeper-outside-registry-token");
    expect(messages(f)).toMatch(/bookkeeper-outside-registry-token/);
    expect(check({ outsideTools: [entry({ token: true })] }, () => true)).toEqual([]);
    expect(outsideSecretName("a", "b")).toBe("a-outside-b-token");
    // No token wanted: the file is never asked for.
    const asked: string[] = [];
    check({}, (n) => { asked.push(n); return true; });
    expect(asked.filter((n) => n.includes("outside"))).toEqual([]);
  });
});

describe("checkOutsideUrl and hosts", () => {
  it("returns the host and kind", () => {
    expect(checkOutsideUrl("https://Tools.Example.org/x")).toEqual({ ok: true, scheme: "https", host: "tools.example.org" });
    expect(checkOutsideUrl("http://registry:80/x")).toEqual({ ok: true, scheme: "http", host: "registry" });
  });
  it("lists only https hosts, sorted and unique", () => {
    expect(outsideHttpsHosts([{ url: "https://b.example.org/a" }, { url: "http://svc:3000/" }, { url: "https://a.example.org/" }, { url: "https://b.example.org/c" }, { url: "garbage" }]))
      .toEqual(["a.example.org", "b.example.org"]);
  });
});

describe("persona", () => {
  const input = (d: ReturnType<typeof base>) => ({
    manifest: d, roleMd: ROLE, voiceMd: "Plain.", displayName: "Bookkeeper", outsideTools: outsideToolsInEffect(d),
  });
  it("names each outside tool and the owner's description", () => {
    const text = assemblePersona(input(base()));
    expect(text).toContain("**registry**");
    expect(text).toContain("Looks up companies by name.");
    expect(text).toContain("<name>__<tool>");
  });
  it("is unchanged when there are none", () => {
    const d = base({ outsideTools: undefined, grants: [{ capability: "gmail", scope: "read" }], autonomy: { gmail: "gated" } });
    const withField = assemblePersona(input(d));
    const without = assemblePersona({ manifest: d, roleMd: ROLE, voiceMd: "Plain.", displayName: "Bookkeeper" });
    expect(withField).toBe(without);
    expect(without).not.toMatch(/outside/i);
  });
  it("lists nothing when autonomy is never", () => {
    const d = base({ autonomy: { gmail: "gated", outside: "never" } });
    expect(assemblePersona(input(d))).not.toContain("registry");
  });
  it("is stable: same input, same bytes", () => {
    expect(assemblePersona(input(base()))).toBe(assemblePersona(input(base())));
  });
});
