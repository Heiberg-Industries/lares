import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
vi.mock("../lib/db", () => ({ pool: { query: vi.fn() } }));
vi.mock("../lib/agents", () => ({ listAgents: vi.fn() }));
vi.mock("@lares/agent-box/lib/oauth-tokens.js", () => ({ listTokens: vi.fn() }));
import { pool } from "../lib/db";
import { listAgents } from "../lib/agents";
import { listTokens } from "@lares/agent-box/lib/oauth-tokens.js";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { ConnectionsTable } from "../components/ConnectionsTable";
import { getConnectionRows, buildConnectionRows, lastUsedByConnection, lastUsedByInstance, isEvidenceOfUse } from "../lib/connections";
import { connectionsByCapability } from "@lares/agent-kit/connections";

const agents = [
  { name: "saga", displayName: "Saga", role: "Chief of Staff", autonomy: {}, skills: [], doors: [], tools: null, startedAt: "2026-08-01T00:00:00Z", grants: [
    { capability: "gmail", scope: "write-with-confirm" as const },
    { capability: "twenty", scope: "write-with-confirm" as const },
  ] },
];

describe("lastUsedByConnection", () => {
  it("maps an audit action's capability prefix onto that capability's connections", () => {
    const m = lastUsedByConnection(
      [{ capability: "twenty", argsSummary: null, at: new Date("2026-08-06T10:00:00Z") }],
      connectionsByCapability,
    );
    expect(m.get("twenty")).toEqual(new Date("2026-08-06T10:00:00Z"));
  });

  it("keeps the most recent use when two capabilities share one connection", () => {
    const m = lastUsedByConnection(
      [
        { capability: "twenty", argsSummary: null, at: new Date("2026-08-01T10:00:00Z") },
        { capability: "commercial", argsSummary: null, at: new Date("2026-08-06T10:00:00Z") },
      ],
      connectionsByCapability,
    );
    expect(m.get("twenty")).toEqual(new Date("2026-08-06T10:00:00Z"));
  });

  it("ignores an audit action for a capability that is not registered", () => {
    const m = lastUsedByConnection(
      [{ capability: "workflow", argsSummary: null, at: new Date() }],
      connectionsByCapability,
    );
    expect(m.size).toBe(0);
  });

  // Important 2 (final review): the Twenty API key expires, every call throws a 401, and each
  // throw still writes an audit row under twenty.<action> — that must NOT read as a fresh,
  // healthy use just because a row exists.
  it("does not let a run of DENIED/failed audit rows read as a healthy, freshly-used connection", () => {
    const m = lastUsedByConnection(
      [
        { capability: "twenty", argsSummary: "DENIED by scope", at: new Date("2026-08-06T09:00:00Z") },
        { capability: "twenty", argsSummary: "failed: 401 Unauthorized", at: new Date("2026-08-06T10:00:00Z") },
        { capability: "twenty", argsSummary: "proposed: log a note", at: new Date("2026-08-06T11:00:00Z") },
      ],
      connectionsByCapability,
    );
    expect(m.has("twenty")).toBe(false);
  });

  it("falls through a newer failure to an older genuine success still inside the window", () => {
    const m = lastUsedByConnection(
      [
        { capability: "twenty", argsSummary: "Looked up a company", at: new Date("2026-08-01T10:00:00Z") },
        { capability: "twenty", argsSummary: "failed: 401 Unauthorized", at: new Date("2026-08-06T10:00:00Z") },
      ],
      connectionsByCapability,
    );
    expect(m.get("twenty")).toEqual(new Date("2026-08-01T10:00:00Z"));
  });
});

describe("lastUsedByInstance", () => {
  it("attributes evidence only to the instance an audit capability's ref names explicitly", () => {
    // studio declares connections: ["gateway:shared"] — a qualified ref.
    const m = lastUsedByInstance(
      [{ capability: "studio", argsSummary: null, at: new Date("2026-08-06T10:00:00Z") }],
      connectionsByCapability,
    );
    expect(m.get("gateway:shared")).toEqual(new Date("2026-08-06T10:00:00Z"));
    expect(m.has("gateway:nora")).toBe(false);
  });

  it("contributes no evidence for an unqualified ref — it cannot say which instance served the call", () => {
    // twenty declares connections: ["twenty"] — no instance qualifier.
    const m = lastUsedByInstance([{ capability: "twenty", argsSummary: null, at: new Date() }], connectionsByCapability);
    expect(m.size).toBe(0);
  });
});

describe("isEvidenceOfUse", () => {
  it("does not count a scope denial, a pending proposal, or a failure as evidence of use", () => {
    expect(isEvidenceOfUse("DENIED by scope")).toBe(false);
    expect(isEvidenceOfUse("proposed: draft a reply")).toBe(false);
    expect(isEvidenceOfUse("failed: 401 Unauthorized")).toBe(false);
    expect(isEvidenceOfUse("failed after confirm: 401 Unauthorized")).toBe(false);
  });

  it("counts a plain summary, an autonomous run, and a post-confirm execution as evidence", () => {
    expect(isEvidenceOfUse("Set a reminder for 5pm")).toBe(true);
    expect(isEvidenceOfUse("autonomous: sent the digest")).toBe(true);
    expect(isEvidenceOfUse("executed after confirm")).toBe(true);
    expect(isEvidenceOfUse(null)).toBe(true);
  });
});

describe("buildConnectionRows", () => {
  const base = {
    agents, accounts: [], accountsUnavailable: false, usageUnavailable: false, configuredOrgs: ["heiberg", "zero7"],
    lastUsed: new Map(), instanceLastUsed: new Map(), connectionsByCapability,
  };

  it("reports a Google org with an enrolled mailbox without claiming tested health", () => {
    const rows = buildConnectionRows({
      ...base,
      accounts: [{ principal: "U_bendik", email: "owner@project.example", org: "zero7", scopeCount: 4, connectedAt: "2026-08-06" }],
    });
    const zero7 = rows.find((r) => r.connectionId === "google" && r.instanceId === "zero7")!;
    expect(zero7.status).toBe("enrolled");
    expect(zero7.detail).toBe("1 mailbox · 4 scopes · provider health not tested");
    expect(zero7.accounts.map((a) => a.email)).toEqual(["owner@project.example"]);
  });

  it("reports a configured Google client with no mailbox as partial, not missing", () => {
    const rows = buildConnectionRows(base);
    expect(rows.find((r) => r.instanceId === "heiberg")!.status).toBe("partial");
  });

  it("keeps the blank Google row visible when account evidence is unavailable", () => {
    const rows = buildConnectionRows({ ...base, configuredOrgs: [], accountsUnavailable: true });
    expect(rows.find((r) => r.connectionId === "google")).toMatchObject({
      status: "unavailable", detail: "no client configured · accounts unavailable",
    });
  });

  it("omits catalogue-only workspaces that do not exist on this installation", () => {
    const rows = buildConnectionRows({ ...base, configuredOrgs: ["heiberg"] });
    expect(rows.find((r) => r.connectionId === "google" && r.instanceId === "zero7")).toBeUndefined();
    expect(rows.find((r) => r.connectionId === "google")!.label).toContain("heiberg");
  });

  it("shows one honest missing Google connection before any client is configured", () => {
    const rows = buildConnectionRows({ ...base, configuredOrgs: [] });
    const google = rows.filter((r) => r.connectionId === "google");
    expect(google).toHaveLength(1);
    expect(google[0]).toMatchObject({ instanceId: "unconfigured", status: "missing", detail: "no client" });
    expect(google[0].label).not.toContain("Workspace");
  });

  // Minor B (final review): the accounts.length > 0 branch used to fire before the configured
  // check, so an org whose client secrets are gone (rotated out, or never matched) but which
  // still has an old mailbox token on file read as "live" — nobody can refresh that token.
  it("reports partial, not live, when a mailbox is enrolled but the org has no configured client", () => {
    const rows = buildConnectionRows({
      ...base,
      configuredOrgs: ["heiberg"], // zero7's client secrets are gone
      accounts: [{ principal: "U_bendik", email: "a@project.example", org: "zero7", scopeCount: 4, connectedAt: "2026-08-06" }],
    });
    expect(rows.find((r) => r.connectionId === "google" && r.instanceId === "zero7")!.status).toBe("partial");
  });

  // Minor A (final review): Math.max over scope counts hid the under-scoped mailbox — a
  // 4-scope and a 3-scope mailbox is 3 scopes of GUARANTEED coverage, not 4.
  it("summarises mailbox scope coverage by the minimum across mailboxes, not the maximum", () => {
    const rows = buildConnectionRows({
      ...base,
      accounts: [
        { principal: "U_bendik", email: "a@project.example", org: "zero7", scopeCount: 4, connectedAt: "2026-08-06" },
        { principal: "U_bendik", email: "b@project.example", org: "zero7", scopeCount: 3, connectedAt: "2026-08-06" },
      ],
    });
    const zero7 = rows.find((r) => r.connectionId === "google" && r.instanceId === "zero7")!;
    expect(zero7.detail).toBe("2 mailboxes · 3 scopes · provider health not tested");
  });

  // Important 3 (final review): an org can exist only because someone set
  // GOOGLE_CLIENT_ID_ACME/_SECRET_ACME and connected a mailbox — the catalogue never declared
  // it. Without a row it's invisible and (Remove only renders inside a row) unremovable.
  it("shows a row for an org discovered only from a configured client and a stored mailbox — not just the catalogue", () => {
    const rows = buildConnectionRows({
      ...base,
      configuredOrgs: [...base.configuredOrgs, "acme"],
      accounts: [{ principal: "U_bendik", email: "x@acme.com", org: "acme", scopeCount: 4, connectedAt: "2026-08-06" }],
    });
    const acme = rows.find((r) => r.connectionId === "google" && r.instanceId === "acme");
    expect(acme).toBeDefined();
    expect(acme!.status).toBe("enrolled");
    expect(acme!.accounts.map((a) => a.email)).toEqual(["x@acme.com"]);
  });

  it("never claims a host-custody credential is missing — it cannot see the file", () => {
    const notion = buildConnectionRows(base).find((r) => r.connectionId === "notion")!;
    expect(notion.custody).toBe("host");
    expect(notion.status).toBe("unknown");
    expect(notion.detail).toBe("no recorded use");
  });

  it("calls a host-custody credential live once the audit log proves a use", () => {
    const rows = buildConnectionRows({ ...base, lastUsed: new Map([["twenty", new Date("2026-08-06T10:00:00Z")]]) });
    const twenty = rows.find((r) => r.connectionId === "twenty")!;
    expect(twenty.status).toBe("live");
    expect(twenty.lastUsed).toBe("2026-08-06T10:00:00.000Z");
  });

  it("does not broadcast one instance's evidence onto its siblings on a multi-instance host-custody connection", () => {
    // One "studio" audit row is evidence for gateway:shared ONLY (studio's own declared ref,
    // `connectionsByCapability.studio`). gateway:marcel was never touched and must stay
    // unknown, not live — the whole point of per-instance status.
    const uses = [{ capability: "studio", argsSummary: null, at: new Date("2026-08-06T10:00:00Z") }];
    const rows = buildConnectionRows({
      ...base,
      lastUsed: lastUsedByConnection(uses, connectionsByCapability),
      instanceLastUsed: lastUsedByInstance(uses, connectionsByCapability),
    });
    const gateway = (id: string) => rows.find((r) => r.connectionId === "gateway" && r.instanceId === id)!;
    expect(gateway("shared").status).toBe("live");
    expect(gateway("marcel").status).toBe("unknown");
  });

  it("withholds lastUsed on a multi-instance connection — audit cannot say which client served it", () => {
    const rows = buildConnectionRows({ ...base, lastUsed: new Map([["google", new Date()]]) });
    expect(rows.find((r) => r.connectionId === "google")!.lastUsed).toBeNull();
  });

  it("separates actual agent grants from catalogue service declarations", () => {
    const twenty = buildConnectionRows(base).find((r) => r.connectionId === "twenty")!;
    expect(twenty.usedBy).toContain("saga");
    expect(twenty.usedBy).not.toContain("notion-sync");
    expect(twenty.declaredFor).toContain("notion-sync");
  });

  it("attributes a declared instance-specific consumer to that instance only", () => {
    // `marcel` declares `gateway:marcel` (declaredConsumers in agent-runtime's connections.ts),
    // an instance-qualified ref — so it must appear on that instance and NOT on its sibling.
    const rows = buildConnectionRows(base);
    expect(rows.find((r) => r.connectionId === "gateway" && r.instanceId === "marcel")!.declaredFor)
      .toContain("marcel");
    expect(rows.find((r) => r.connectionId === "gateway" && r.instanceId === "shared")!.declaredFor)
      .not.toContain("marcel");
  });
});

describe("connection read failures through the rendered table", () => {
  beforeEach(() => {
    vi.mocked(listAgents).mockResolvedValue(agents.map((agent) => ({
      ...agent, name: "assistant", displayName: "Assistant",
    })));
    vi.mocked(listTokens).mockResolvedValue([]);
    vi.mocked(pool.query).mockResolvedValue({ rows: [] } as never);
    vi.stubEnv("GOOGLE_CLIENT_ID_ACME", "client");
    vi.stubEnv("GOOGLE_CLIENT_SECRET_ACME", "secret");
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

  const googleRow = (rows: Awaited<ReturnType<typeof getConnectionRows>>) =>
    rows.find((r) => r.connectionId === "google" && r.instanceId === "acme")!;
  const storedAccount = {
    id: "token", principal: "owner", provider: "google", orgId: "acme",
    emailAddress: "owner@acme.example", scopes: ["read"],
    createdAt: new Date("2026-10-08T10:00:00Z"), updatedAt: new Date("2026-10-08T10:00:00Z"),
  };

  it("keeps successful empty reads unconfigured and offers setup", async () => {
    const rows = await getConnectionRows();
    expect(googleRow(rows)).toMatchObject({
      status: "partial", detail: "client configured, no mailbox",
      accountsUnavailable: false, usageUnavailable: false,
    });
    const html = renderToStaticMarkup(createElement(ConnectionsTable, { rows }));
    expect(html).toContain("client configured, no mailbox");
    expect(html).toContain("Connect a Google account");
    expect(html).not.toContain("unavailable");
  });

  it("keeps client, grant and successful usage facts when account reads fail", async () => {
    vi.mocked(listTokens).mockRejectedValue(new Error("private credential token SQL"));
    vi.mocked(pool.query).mockResolvedValue({ rows: [
      { capability: "twenty", argsSummary: "looked up a contact", at: new Date("2026-10-08T10:00:00Z") },
    ] } as never);
    const rows = await getConnectionRows();
    expect(googleRow(rows)).toMatchObject({
      status: "unavailable", detail: "client configured · accounts unavailable",
      accountsUnavailable: true, usageUnavailable: false, usedBy: ["assistant"],
    });
    expect(rows.find((r) => r.connectionId === "twenty")).toMatchObject({
      status: "live", lastUsed: "2026-10-08T10:00:00.000Z", usedBy: ["assistant"],
    });
    const html = renderToStaticMarkup(createElement(ConnectionsTable, { rows }));
    expect(html).toContain("Accounts unavailable");
    expect(html).toContain("client configured");
    expect(html).not.toContain("no mailbox");
    expect(html).not.toContain("private credential token SQL");
  });

  it("preserves enrollment, removal controls and grants when usage reads fail", async () => {
    vi.mocked(listTokens).mockResolvedValue([storedAccount]);
    vi.mocked(pool.query).mockRejectedValue(new Error("private audit SQL"));
    const rows = await getConnectionRows();
    expect(googleRow(rows)).toMatchObject({
      status: "enrolled", accountsUnavailable: false, usageUnavailable: true,
      accounts: [expect.objectContaining({ email: "owner@acme.example" })], usedBy: ["assistant"],
    });
    expect(rows.find((r) => r.connectionId === "twenty")).toMatchObject({
      status: "unavailable", detail: "usage unavailable", lastUsed: null, usedBy: ["assistant"],
    });
    const html = renderToStaticMarkup(createElement(ConnectionsTable, { rows }));
    expect(html).toContain("Usage unavailable");
    expect(html).toContain("owner@acme.example");
    expect(html).toContain("Remove");
    expect(html).toContain("provider health not tested");
    expect(html).not.toContain("no recorded use");
    expect(html).not.toContain("Last use recorded here: none");
    expect(html).not.toContain("private audit SQL");
  });

  it("shows both unavailable sections without claiming accounts are missing", async () => {
    vi.mocked(listTokens).mockRejectedValue(new Error("private account error"));
    vi.mocked(pool.query).mockRejectedValue(new Error("private usage error"));
    const rows = await getConnectionRows();
    const html = renderToStaticMarkup(createElement(ConnectionsTable, { rows }));
    expect(html).toContain("Accounts unavailable");
    expect(html).toContain("Usage unavailable");
    expect(html).toContain("Agent access: assistant");
    expect(html).not.toContain("no mailbox");
    expect(html).not.toContain("no recorded use");
    expect(html).not.toContain("private account error");
    expect(html).not.toContain("private usage error");
  });
});
