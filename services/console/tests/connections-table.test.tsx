import { describe, it, expect, vi } from "vitest";
vi.mock("../lib/connections", () => ({ getConnectionRows: vi.fn() }));
vi.mock("../lib/board", () => ({ getBoardRows: async () => [] }));
vi.mock("../lib/queries", () => ({ getNotionSyncStatus: async () => ({
  lastRunAt: "2026-10-08T10:00:00Z", synced: 7, needsYou: 0, retrying: 0, unmatched: 0,
}) }));
vi.mock("../lib/notion-proposals", () => ({ getNotionProposalsView: async () => ({ proposals: [], frozen: [] }) }));
vi.mock("../lib/crm-status", () => ({ getCrmStatus: async () => ({ at: "", channels: [], unavailable: true }) }));
import { getConnectionRows } from "../lib/connections";
import IntegrationsPage from "../app/integrations/page";
import { renderToStaticMarkup } from "react-dom/server";
import { ConnectionsTable } from "../components/ConnectionsTable";
import type { ConnectionRowDTO } from "../lib/contracts";

// Renders the actual table, not just the vocabulary map, so a reintroduced translation layer
// (the live→done bug this task removed) would show up here even if state-colours.ts stayed
// correct. custody: "host" and accounts: [] keep every row's console-only expando collapsed,
// so AddAccountForm/RemoveAccountButton (both "use client" components) are never reached.
function row(status: ConnectionRowDTO["status"]): ConnectionRowDTO {
  return {
    connectionId: "google",
    instanceId: "zero7",
    label: "google · zero7",
    custody: "host",
    status,
    detail: "detail",
    lastUsed: null,
    accountsUnavailable: false,
    usageUnavailable: false,
    usedBy: [],
    declaredFor: [],
    accounts: [],
  };
}

describe("ConnectionsTable render path", () => {
  it("does not present catalogue consumers as running users of a fresh installation", () => {
    const html = renderToStaticMarkup(<ConnectionsTable rows={[{
      ...row("live"),
      usedBy: ["console-proof"],
      declaredFor: ["email-watcher", "notion-sync"],
    }]} />);
    expect(html).toContain("Agent access: console-proof");
    expect(html).toContain("Built-in consumers in the catalogue: email-watcher, notion-sync");
    expect(html).toContain("This does not confirm they are running here.");
    expect(html).not.toContain("Used by email-watcher");
  });

  it("renders enrollment without claiming provider-tested health", () => {
    const html = renderToStaticMarkup(<ConnectionsTable rows={[{
      ...row("enrolled"), detail: "1 mailbox · 5 scopes · provider health not tested",
    }]} />);
    expect(html).toContain("enrolled");
    expect(html).toContain("provider health not tested");
    expect(html).not.toContain(">live<");
  });

  it("renders the raw 'live' label for a live row, and never the job-vocabulary word 'done'", () => {
    const html = renderToStaticMarkup(<ConnectionsTable rows={[row("live")]} />);
    expect(html).toContain("live");
    expect(html).not.toContain("done");
  });

  it("renders the raw 'partial' label for a partial row, and never 'waiting'", () => {
    const html = renderToStaticMarkup(<ConnectionsTable rows={[row("partial")]} />);
    expect(html).toContain("partial");
    expect(html).not.toContain("waiting");
  });

  it("renders the raw 'missing' label for a missing row, and never 'failed'", () => {
    const html = renderToStaticMarkup(<ConnectionsTable rows={[row("missing")]} />);
    expect(html).toContain("missing");
    expect(html).not.toContain("failed");
  });

  it("renders the raw 'unknown' label via StatePill's grey fallback, end to end", () => {
    const html = renderToStaticMarkup(<ConnectionsTable rows={[row("unknown")]} />);
    expect(html).toContain("unknown");
  });
});


describe("Integrations page partial evidence", () => {
  it("renders unavailable evidence while retaining independently read service sections", async () => {
    vi.mocked(getConnectionRows).mockResolvedValue([{
      ...row("unavailable"), custody: "console", accountsUnavailable: true, usageUnavailable: true,
      detail: "client configured · accounts unavailable", usedBy: ["assistant"],
    }]);
    const html = renderToStaticMarkup(await IntegrationsPage({ searchParams: Promise.resolve({}) }));
    expect(html).toContain("Accounts unavailable");
    expect(html).toContain("Usage unavailable");
    expect(html).toContain("Agent access: assistant");
    expect(html).toContain("Connect a Google account");
    expect(html).toContain("7 synced");
    expect(html).toContain("Agent permissions");
    expect(html).not.toContain("no mailbox");
    expect(html).not.toContain("Last use recorded here: none");
  });
});
