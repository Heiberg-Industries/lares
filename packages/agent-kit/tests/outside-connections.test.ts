import type { ApprovalContext, ApprovalResponseContext } from "eve/tools/approval";
import { afterEach, describe, expect, it } from "vitest";

import { parseDefinition } from "../src/definition.js";
import { coversApproval, resetOutsideConnectionsForTests, summarizeApproval } from "../src/approval-summary.js";
import { resetTaintForTests, taintTurn } from "../src/origin-taint.js";
import {
  outsideConnection,
  outsideProblems,
  outsideProblemWording,
  outsideRequestPolicy,
  outsideResponsePolicy,
  outsideResultTaint,
  outsideTokenPath,
  resolveOutsideConnections,
} from "../src/outside-connections.js";

const entry = (over: Record<string, unknown> = {}) => ({
  name: "registry", url: "https://tools.example.org/mcp", description: "Looks up companies by name.",
  token: true, tools: { allow: ["lookup", "create_note"], read: ["lookup"] }, ...over,
});
const def = (over: Record<string, unknown> = {}) =>
  parseDefinition({
    name: "bookkeeper", display: "Bookkeeper", model: "lares-utility", persona: "agent/instructions.md", role: "chief-of-staff",
    grants: [{ capability: "outside", scope: "write-with-confirm" }],
    autonomy: { outside: "gated" },
    outsideTools: [entry()],
    ...over,
  });
const allowAll = { isAllowedApprover: () => true };
const ctx = (toolName: string, turn = "t1"): ApprovalContext =>
  ({ abortSignal: new AbortController().signal, approvedTools: new Set(), callId: "c1", toolName, session: { id: "s1", turn: { id: turn, sequence: 0 } } }) as unknown as ApprovalContext;

afterEach(() => { resetTaintForTests(); resetOutsideConnectionsForTests(); });

describe("resolveOutsideConnections", () => {
  it("returns null when there are no entries, no grant, or autonomy is never", () => {
    expect(resolveOutsideConnections(def({ outsideTools: undefined }), allowAll)).toBeNull();
    expect(resolveOutsideConnections(def({ grants: [] , autonomy: {} }), allowAll)).toBeNull();
    expect(resolveOutsideConnections(def({ autonomy: { outside: "never" } }), allowAll)).toBeNull();
  });

  it("builds one connection per entry with the agent-scoped instance key and the allow list", () => {
    const hosts: string[][] = [];
    const out = resolveOutsideConnections(def(), { ...allowAll, addHosts: (h) => hosts.push(h) })!;
    expect(Object.keys(out)).toEqual(["registry"]);
    expect(out["registry"]).toMatchObject({
      url: "https://tools.example.org/mcp",
      description: "Looks up companies by name.",
      instanceKey: "outside:bookkeeper:registry",
      tools: { allow: ["lookup", "create_note"] },
    });
    expect(hosts).toEqual([["tools.example.org"]]);
  });

  it("is idempotent: a second resolve gives the same answer", () => {
    const a = resolveOutsideConnections(def(), { ...allowAll, addHosts: () => {} })!;
    const b = resolveOutsideConnections(def(), { ...allowAll, addHosts: () => {} })!;
    expect(Object.keys(a)).toEqual(Object.keys(b));
    expect(a["registry"]!.instanceKey).toBe(b["registry"]!.instanceKey);
  });

  it("registers the connection name so the approval card knows it", () => {
    resolveOutsideConnections(def(), { ...allowAll, addHosts: () => {} });
    expect(summarizeApproval("registry__create_note", { a: 1 })).toMatch(/^Ask outside tool registry/);
    expect(coversApproval("registry__create_note")).toBe(false);
  });

  it("opens no host for a compose-internal http service", () => {
    const hosts: string[][] = [];
    resolveOutsideConnections(def({ outsideTools: [entry({ url: "http://registry-mcp:3000/mcp" })] }), { ...allowAll, addHosts: (h) => hosts.push(h) });
    expect(hosts).toEqual([]);
  });

  it("reads the token from the keeper-mounted file, trimmed, at call time", async () => {
    const paths: string[] = [];
    const c = outsideConnection("bookkeeper", def().outsideTools![0]!, { ...allowAll, readTokenFile: async (p) => { paths.push(p); return " s3cret\n"; } });
    const auth = c.auth as { credentialOwner: string; getToken: () => Promise<{ token: string }> };
    expect(auth.credentialOwner).toBe("app");
    expect(await auth.getToken()).toEqual({ token: "s3cret" });
    expect(paths).toEqual(["/run/secrets/outside-registry"]);
    expect(outsideTokenPath("registry")).toBe("/run/secrets/outside-registry");
  });

  it("has no auth when the entry needs no token", () => {
    const c = outsideConnection("bookkeeper", def({ outsideTools: [entry({ token: false })] }).outsideTools![0]!, allowAll);
    expect(c.auth).toBeUndefined();
  });

  it("names the file, never the contents, when the token cannot be read", async () => {
    const c = outsideConnection("bookkeeper", def().outsideTools![0]!, { ...allowAll, readTokenFile: async () => { throw new Error("EACCES"); } });
    await expect((c.auth as { getToken: () => Promise<unknown> }).getToken()).rejects.toThrow(/\/run\/secrets\/outside-registry/);
    const empty = outsideConnection("bookkeeper", def().outsideTools![0]!, { ...allowAll, readTokenFile: async () => "  \n" });
    await expect((empty.auth as { getToken: () => Promise<unknown> }).getToken()).rejects.toThrow(/empty/);
  });
});

describe("the request policy", () => {
  const untrusted = def().outsideTools![0]!;
  const trusted = def({ outsideTools: [entry({ trusted: true })] }).outsideTools![0]!;

  it("untrusted (the default): every call asks, reads included, even on a clean turn", async () => {
    const p = outsideRequestPolicy(untrusted);
    expect(await p(ctx("registry__lookup"))).toBe("user-approval");
    expect(await p(ctx("registry__create_note"))).toBe("user-approval");
  });

  it("trusted: a read runs on a clean turn", async () => {
    expect(await outsideRequestPolicy(trusted)(ctx("registry__lookup"))).toBe("not-applicable");
  });

  it("trusted: a read asks once the turn has read somebody else's words", async () => {
    taintTurn({ sessionId: "s1", turnId: "t1" }, "third_party");
    expect(await outsideRequestPolicy(trusted)(ctx("registry__lookup"))).toBe("user-approval");
    expect(await outsideRequestPolicy(trusted)(ctx("registry__lookup", "t2"))).toBe("not-applicable");
  });

  it("trusted: every tool that is not a listed read asks, clean turn or not", async () => {
    expect(await outsideRequestPolicy(trusted)(ctx("registry__create_note"))).toBe("user-approval");
  });

  it("trusted in a role that cannot taint (taintAware false): every call asks, even a read on a clean turn", async () => {
    const p = outsideRequestPolicy(trusted, { taintAware: false });
    expect(await p(ctx("registry__lookup"))).toBe("user-approval");
    const conn = resolveOutsideConnections(def({ outsideTools: [entry({ trusted: true })] }), { ...allowAll, addHosts: () => {}, taintAware: false })!;
    const request = (conn["registry"]!.approval as { request: (c: ApprovalContext) => Promise<unknown> }).request;
    expect(await request(ctx("registry__lookup"))).toBe("user-approval");
  });

  it("asks when it cannot tell which turn it is in", async () => {
    expect(await outsideRequestPolicy(trusted)({ toolName: "registry__lookup" } as unknown as ApprovalContext)).toBe("user-approval");
  });
});

describe("the response policy (approver re-check)", () => {
  const rctx = (responder: unknown) => ({ responder }) as unknown as ApprovalResponseContext;

  it("allows a responder the allowlist accepts and rejects every other", () => {
    const policy = outsideResponsePolicy((r) => (r as { principalId?: string }).principalId === "owner");
    expect(policy(rctx({ principalId: "owner" }))).toEqual({ status: "allowed" });
    expect(policy(rctx({ principalId: "someone-else" }))).toMatchObject({ status: "rejected" });
  });

  it("fails closed when the check itself throws", () => {
    const policy = outsideResponsePolicy(() => { throw new Error("boom"); });
    expect(policy(rctx({}))).toMatchObject({ status: "rejected" });
  });

  it("is wired into every connection", () => {
    const c = outsideConnection("bookkeeper", def().outsideTools![0]!, { isAllowedApprover: () => false });
    const approval = c.approval as { request: unknown; response: (c: ApprovalResponseContext) => unknown };
    expect(typeof approval.request).toBe("function");
    expect(approval.response(rctx({}))).toMatchObject({ status: "rejected" });
  });
});

describe("the taint rule", () => {
  it("taints results of an untrusted connection's tools by prefix", () => {
    expect(outsideResultTaint("registry__lookup", def())).toBe("third_party");
    expect(outsideResultTaint("registry__create_note", def())).toBe("third_party");
  });

  it("does not taint a trusted connection, other tools, or look-alike prefixes", () => {
    const trusted = def({ outsideTools: [entry({ trusted: true })] });
    expect(outsideResultTaint("registry__lookup", trusted)).toBeUndefined();
    expect(outsideResultTaint("gmail_read", def())).toBeUndefined();
    expect(outsideResultTaint("registry2__lookup", def())).toBeUndefined();
    expect(outsideResultTaint("registry_lookup", def())).toBeUndefined();
  });

  it("treats connection_search output as outside text only while an untrusted connection is present", () => {
    expect(outsideResultTaint("connection_search", def())).toBe("third_party");
    expect(outsideResultTaint("connection_search", def({ outsideTools: [entry({ trusted: true })] }))).toBeUndefined();
    expect(outsideResultTaint("connection_search", def({ outsideTools: undefined }))).toBeUndefined();
  });

  it("taints nothing when the connections are switched off", () => {
    expect(outsideResultTaint("registry__lookup", def({ autonomy: { outside: "never" } }))).toBeUndefined();
  });
});

describe("the approval card", () => {
  it("names the connection, the tool and the arguments, not raw JSON", () => {
    resolveOutsideConnections(def(), { ...allowAll, addHosts: () => {} });
    const title = summarizeApproval("registry__create_note", { company: "Acme", text: "met on Tuesday" })!;
    expect(title).toBe('Ask outside tool registry: create_note — company: "Acme", text: "met on Tuesday"');
    expect(title).not.toContain("{");
  });

  it("truncates long values and counts the arguments it leaves out", () => {
    resolveOutsideConnections(def(), { ...allowAll, addHosts: () => {} });
    const input: Record<string, unknown> = { a: "x".repeat(300), b: 1, c: 2, d: 3, e: 4, f: 5, g: 6, h: 7 };
    const title = summarizeApproval("registry__create_note", input)!;
    expect(title).toContain("…");
    expect(title).toContain("and 2 more");
    expect(title).toContain("shortened, see the full request below");
    expect(title.length).toBeLessThan(600);
  });

  it("does not claim a shortening when nothing was cut", () => {
    resolveOutsideConnections(def(), { ...allowAll, addHosts: () => {} });
    expect(summarizeApproval("registry__lookup", { q: "Acme" })).not.toContain("shortened");
  });

  it("a registered connection gets a title but is never 'covered'; anything else keeps the generic card", () => {
    expect(coversApproval("registry__lookup")).toBe(false);
    resolveOutsideConnections(def(), { ...allowAll, addHosts: () => {} });
    // Never covered: the full input stays on the card S1).
    expect(coversApproval("registry__lookup")).toBe(false);
    expect(coversApproval("other__lookup")).toBe(false);
    expect(summarizeApproval("other__lookup", { q: "x" })).toBe("other__lookup — q: x");
  });

  it("says so when there are no arguments", () => {
    resolveOutsideConnections(def(), { ...allowAll, addHosts: () => {} });
    expect(summarizeApproval("registry__lookup", {})).toBe("Ask outside tool registry: lookup — no arguments");
  });
});

describe("outsideProblems", () => {
  it("reads eve's real connection_search error shape", () => {
    const out = [
      { connection: "registry", description: "x", error: "Failed to load tools for registry: connect ECONNREFUSED" },
      { connection: "other", description: "x", error: "Failed to load tools for other" },
    ];
    expect(outsideProblems({ toolName: "connection_search", output: out }, "completed", def())).toEqual([{ connection: "registry", kind: "unreachable" }]);
    const auth = [{ connection: "registry", description: "x", error: "Authorization failed for registry: token file is empty" }];
    expect(outsideProblems({ toolName: "connection_search", output: auth }, "completed", def())).toEqual([{ connection: "registry", kind: "key-refused" }]);
  });

  it("reports a refused key from connection_search, once per connection", () => {
    const out = [{ connection: "registry", description: "x", needsAuthorization: true }, { connection: "registry", needsAuthorization: true }, { connection: "ghost", needsAuthorization: true }];
    expect(outsideProblems({ toolName: "connection_search", output: out }, "completed", def())).toEqual([{ connection: "registry", kind: "key-refused" }]);
  });

  it("finds it inside a JSON string or a wrapped output", () => {
    const json = JSON.stringify([{ connection: "registry", needsAuthorization: true }]);
    expect(outsideProblems({ toolName: "connection_search", output: json }, "completed", def())).toHaveLength(1);
    expect(outsideProblems({ toolName: "connection_search", output: { type: "json", value: JSON.parse(json) } }, "completed", def())).toHaveLength(1);
  });

  it("reports nothing for a healthy search", () => {
    expect(outsideProblems({ toolName: "connection_search", output: [{ connection: "registry", tools: [] }] }, "completed", def())).toEqual([]);
  });

  it("reports an unreachable server when its tool call failed, not when it ran and said no", () => {
    expect(outsideProblems({ toolName: "registry__lookup", output: "" }, "failed", def())).toEqual([{ connection: "registry", kind: "unreachable" }]);
    expect(outsideProblems({ toolName: "registry__lookup", output: "" }, "completed", def())).toEqual([]);
    expect(outsideProblems({ toolName: "gmail_read", output: "" }, "failed", def())).toEqual([]);
  });

  it("says nothing when outside tools are off", () => {
    expect(outsideProblems({ toolName: "registry__lookup" }, "failed", def({ autonomy: { outside: "never" } }))).toEqual([]);
  });

  it("words it for a person and never mentions a secret", () => {
    const w = outsideProblemWording("bookkeeper", { connection: "registry", kind: "key-refused" });
    expect(w.summary).toBe("bookkeeper: the key for outside tool registry was refused");
    expect(w.detail).toContain("console");
    expect(outsideProblemWording("bookkeeper", { connection: "registry", kind: "unreachable" }).summary).toContain("did not answer");
  });
});
