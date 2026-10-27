import type { ApprovalContext, ApprovalResponseContext } from "eve/tools/approval";
import { afterEach, describe, expect, it } from "vitest";

import { parseDefinition } from "../src/definition.js";
import { coversApproval, registerOutsideConnections, resetOutsideConnectionsForTests, summarizeApproval } from "../src/approval-summary.js";
import { resetTaintForTests, taintTurn } from "../src/origin-taint.js";
import {
  outsideProblems,
  outsideProblemWording,
  outsideRequestPolicy,
  outsideResponsePolicy,
  outsideResultTaint,
  resolveOutsideTools,
  type AcceptedOutsideTool,
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
    registerOutsideConnections(['registry']);
    const title = summarizeApproval("registry__create_note", { company: "Acme", text: "met on Tuesday" })!;
    expect(title).toBe('Ask outside tool registry: create_note — company: "Acme", text: "met on Tuesday"');
    expect(title).not.toContain("{");
  });

  it("truncates long values and counts the arguments it leaves out", () => {
    registerOutsideConnections(['registry']);
    const input: Record<string, unknown> = { a: "x".repeat(300), b: 1, c: 2, d: 3, e: 4, f: 5, g: 6, h: 7 };
    const title = summarizeApproval("registry__create_note", input)!;
    expect(title).toContain("…");
    expect(title).toContain("and 2 more");
    expect(title).toContain("shortened, see the full request below");
    expect(title.length).toBeLessThan(600);
  });

  it("does not claim a shortening when nothing was cut", () => {
    registerOutsideConnections(['registry']);
    expect(summarizeApproval("registry__lookup", { q: "Acme" })).not.toContain("shortened");
  });

  it("a registered connection gets a title but is never 'covered'; anything else keeps the generic card", () => {
    expect(coversApproval("registry__lookup")).toBe(false);
    registerOutsideConnections(['registry']);
    // Never covered: the full input stays on the card S1).
    expect(coversApproval("registry__lookup")).toBe(false);
    expect(coversApproval("other__lookup")).toBe(false);
    expect(summarizeApproval("other__lookup", { q: "x" })).toBe("other__lookup — q: x");
  });

  it("says so when there are no arguments", () => {
    registerOutsideConnections(['registry']);
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

describe('Keeper-proxied ordinary tools',()=>{
 it('exposes accepted allowed schemas and executes an ordinary tool without token or provider settings',async()=>{
  const calls:unknown[]=[];
  const tools=await resolveOutsideTools(def(),{acceptedTools:async():Promise<AcceptedOutsideTool[]>=>[
   {name:'lookup',description:'Accepted description',inputSchema:{type:'object',properties:{company:{type:'string'}}}},
   {name:'not_allowed',inputSchema:{type:'object',properties:{}}}],
   executor:(connectionName,toolName)=>async(input,context)=>{calls.push({connectionName,toolName,input,callId:context.callId});return {content:[]};}});
  expect(Object.keys(tools!)).toEqual(['registry__lookup']);
  const tool=tools!['registry__lookup']!;
  expect(tool.description).toBe('Accepted description');
  expect(tool.inputSchema).toMatchObject({type:'object'});
  expect(tool).not.toHaveProperty('url');expect(tool).not.toHaveProperty('auth');
  expect(await tool.execute({company:'Example'},ctx('registry__lookup') as never)).toEqual({content:[]});
  expect(calls).toEqual([{connectionName:'registry',toolName:'lookup',input:{company:'Example'},callId:'c1'}]);
 });
 it('omits absent or stale accepted catalogs and never falls back to provider discovery',async()=>{
  expect(await resolveOutsideTools(def(),{acceptedTools:async()=>{throw Error('stale');},executor:()=>{throw Error('unreachable');}})).toBeNull();
  expect(await resolveOutsideTools(def({grants:[]}),{acceptedTools:async()=>{throw Error('unreachable');},executor:()=>{throw Error('unreachable');}})).toBeNull();
 });
});
