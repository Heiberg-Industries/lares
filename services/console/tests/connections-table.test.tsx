import { describe, it, expect } from "vitest";
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
    usedBy: [],
    accounts: [],
  };
}

describe("ConnectionsTable render path", () => {
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
