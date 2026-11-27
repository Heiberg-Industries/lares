import React from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
const m = vi.hoisted(() => ({
  guard: vi.fn(), rows: vi.fn(), board: vi.fn(), credential: vi.fn(), clipping: vi.fn(), sync: vi.fn(), proposals: vi.fn(), meetings: vi.fn(), people: vi.fn(),
  inUse: vi.fn(), evidence: vi.fn(), gateway: vi.fn(), agents: vi.fn(),
}));
vi.mock("../lib/auth", () => ({ requirePage: m.guard, mayUse: (member: unknown, _level: string) => !!member }));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("NEXT_NOT_FOUND"); } }));
vi.mock("../lib/connections", () => ({ getConnectionRows: m.rows }));
vi.mock("../lib/board", () => ({ getBoardRows: m.board }));
vi.mock("../lib/credentials", () => ({ getCredentialView: m.credential }));
vi.mock("../lib/gateway-status", () => ({ getGatewayStatusView: m.gateway }));
vi.mock("../lib/agents", () => ({ listAgents: m.agents }));
vi.mock("../lib/clipping", () => ({ getClippingView: m.clipping }));
vi.mock("../lib/queries", () => ({ getNotionSyncStatus: m.sync }));
vi.mock("../lib/notion-proposals", () => ({ getNotionProposalsView: m.proposals }));
vi.mock("../lib/meetings-source", () => ({ getMeetingsSourceView: m.meetings }));
vi.mock("../lib/notion-sync", () => ({ getNotionSyncView: m.people }));
vi.mock("../components/MeetingsSourceControl", () => ({ MeetingsSourceControl: () => <section>MEETINGS-DATABASE</section> }));
vi.mock("../components/NotionSyncControl", () => ({ NotionSyncControl: () => <section>PEOPLE-SYNC</section> }));
vi.mock("../lib/outside-tools", () => ({ anyOutsideToolsInUse: m.inUse }));
vi.mock("../components/AutonomyControl", () => ({ AutonomyControl: ({ capability }: { capability: string }) => <span>dial:{capability}</span> }));
vi.mock("../components/NotionCredential", () => ({ NotionCredential: () => <section>NOTION-CREDENTIAL</section> }));
vi.mock("../components/NotionProposalsCard", () => ({ NotionProposalsCard: () => <section>NOTION-PROPOSALS</section> }));
vi.mock("../components/ClippingCard", () => ({ ClippingCard: () => <section>CLIPPING-CARD</section> }));
vi.mock("next/link", () => ({ default: ({ href, children, ...p }: React.ComponentProps<"a">) => <a href={href} {...p}>{children}</a> }));
import IntegrationPage from "../app/integrations/[id]/page";
import type { BoardRowDTO, ConnectionRowDTO } from "../lib/contracts";

const row = (connectionId: string, over: Partial<ConnectionRowDTO> = {}): ConnectionRowDTO => ({
  connectionId, instanceId: "shared", label: connectionId, custody: "host", status: "unknown", detail: "no recorded use",
  accountsUnavailable: false, usageUnavailable: false, lastUsed: null, usedBy: [], declaredFor: [], accounts: [], ...over,
});
const catalogue = ["microsoft", "google", "twenty", "readability", "gateway", "notion", "slack", "telegram", "karakeep", "signals"];
const board = (capability: string, over: Partial<BoardRowDTO> = {}): BoardRowDTO => ({
  agent: "assistant", displayName: "Assistant", capability, action: "", actionLabel: null, scope: "write-with-confirm", level: "gated",
  source: { kind: "definition" }, controllable: true, lockedTools: [],
  evidence: { asked: 3, autonomous: 1, denied: 0, locked: 0, failedClosed: 0, lastAt: null },
  answers: { approved: 0, cancelled: 0, neverAnswered: 0, rate: null }, couldGraduate: false, ...over,
});
const show = async (id: string) => renderToStaticMarkup(await IntegrationPage({ params: Promise.resolve({ id }) }));
let rows: ConnectionRowDTO[];
beforeEach(() => {
  vi.clearAllMocks(); m.guard.mockResolvedValue({ id: "owner-1" });
  rows = catalogue.map(id => row(id));
  m.rows.mockImplementation(async () => rows);
  m.board.mockResolvedValue([board("twenty"), board("vault", { action: "private", actionLabel: "Private notes" }), board("gmail"), board("deadline", { scope: "read", controllable: false })]);
  m.gateway.mockResolvedValue({ kind: "keeper-unavailable" }); m.agents.mockResolvedValue([{ name: "assistant", displayName: "Assistant" }]);
  m.credential.mockResolvedValue({ kind: "unavailable" }); m.inUse.mockResolvedValue(false);
  m.clipping.mockResolvedValue({ kind: "unavailable" });
  m.sync.mockResolvedValue({ lastRunAt: "2026-10-08T10:00:00Z", synced: 7, needsYou: 0, retrying: 0, unmatched: 0 });
  m.proposals.mockResolvedValue({ proposals: [], frozen: [] });
  m.meetings.mockResolvedValue({ value: null, from: "none", canChange: true, chiefCount: 1 }); m.people.mockResolvedValue({ phase: "off" });
});

it("refuses a non-owner the way the grid does, and finds no page for an unknown or personal id", async () => {
  m.guard.mockRejectedValue(new Error("NEXT_REDIRECT"));
  await expect(show("twenty")).rejects.toThrow("NEXT_REDIRECT");
  m.guard.mockResolvedValue({ id: "owner-1" });
  for (const id of ["nope", "google", "microsoft", "details"]) await expect(show(id), id).rejects.toThrow("NEXT_NOT_FOUND");
  rows = rows.filter(r => r.connectionId !== "karakeep");
  await expect(show("karakeep")).rejects.toThrow("NEXT_NOT_FOUND");
});

it("shows the header with the list's name, line and status word", async () => {
  rows.find(r => r.connectionId === "twenty")!.usedBy = ["assistant"];
  const html = await show("twenty");
  expect(html).toContain("Twenty CRM");
  expect(html).toContain("Keep people and conversations in your CRM.");
  expect(html).toContain('href="/integrations"');
  expect(html).toContain("Enabled");
  expect(await show("karakeep")).toContain("Not in use");
});

it("lists the agents, last use, and where the key is kept for each custody", async () => {
  rows.find(r => r.connectionId === "twenty")!.usedBy = ["assistant", "writer"];
  rows.find(r => r.connectionId === "twenty")!.lastUsed = new Date(Date.now() - 3 * 86400000).toISOString();
  let html = await show("twenty");
  expect(html).toContain("Assistant, writer");
  expect(html).toContain("3d ago");
  expect(html).toContain("Kept on the server. The console cannot see it; it shows only what agents report using.");
  html = await show("slack");
  expect(html).toContain("No agent has access yet.");
  expect(html).toContain("Not used yet");
  rows.find(r => r.connectionId === "slack")!.usageUnavailable = true;
  html = await show("slack");
  expect(html).toContain("Could not be read");
  expect(html).toContain("Usage unavailable. Recorded connection activity could not be read.");
  expect(html).not.toContain("Not used yet");
  rows.find(r => r.connectionId === "signals")!.custody = "console";
  expect(await show("signals")).toContain("Kept by the console on this server.");
  rows.find(r => r.connectionId === "signals")!.custody = "foreign";
  expect(await show("signals")).toContain("Kept by the other service.");
  for (const word of ["custody", "credential", "consumer", "catalogue", "partial", "scope"]) expect((await show("twenty")).toLowerCase()).not.toContain(word);
});

it("names what Lares is built in for only when there is something to name", async () => {
  rows.find(r => r.connectionId === "telegram")!.declaredFor = ["Telegram door"];
  const html = await show("telegram");
  expect(html).toContain("Built in for");
  expect(html).toContain("Telegram door");
  expect(html).toContain("This lists what Lares can use it for, not what runs here.");
  expect(await show("twenty")).not.toContain("Built in for");
});

it("shows only the permission rows tied to this service", async () => {
  const html = await show("twenty");
  expect(html).toContain("dial:twenty");
  expect(html).toContain("Assistant");
  expect(html).not.toContain("dial:vault");
  expect(html).not.toContain("dial:gmail");
  expect(html).not.toContain("deadline");
  expect(await show("karakeep")).not.toContain("What agents may do with it");
});

it("says so when the permission rows could not be read", async () => {
  m.board.mockRejectedValue(new Error("down"));
  expect(await show("twenty")).toContain("could not be read. Reload the page to try again.");
});

it("shows one block per instance of the gateway, each with its label", async () => {
  rows = rows.filter(r => r.connectionId !== "gateway");
  rows.push(row("gateway", { instanceId: "shared", label: "Model gateway · shared", usedBy: ["assistant"] }), row("gateway", { instanceId: "own", label: "Model gateway · own" }));
  m.board.mockResolvedValue([board("studio")]);
  const html = await show("gateway");
  expect(html).toContain("Model gateway · shared");
  expect(html).toContain("Model gateway · own");
  expect(html.match(/Which agents use it/g)).toHaveLength(2);
  expect(html).toContain("dial:studio");
});

it("holds every Notion setting on the Notion page, in order: key, meetings database, people sync, clipping, proposals", async () => {
  const html = await show("notion");
  const order = ["NOTION-CREDENTIAL", "MEETINGS-DATABASE", "PEOPLE-SYNC", "CLIPPING-CARD", "7 synced", "NOTION-PROPOSALS"].map(mark => html.indexOf(mark));
  expect(order.every(at => at >= 0)).toBe(true);
  expect(order).toEqual([...order].sort((a, b) => a - b));
  expect(html).not.toContain('href="/meeting-follow-ups"');
  expect(html).not.toContain("<details");
  expect(html).not.toContain("lares-operational");
  for (const mark of ["NOTION-CREDENTIAL", "MEETINGS-DATABASE", "PEOPLE-SYNC", "NOTION-PROPOSALS"]) expect(await show("twenty")).not.toContain(mark);
});

it("says so in words when a Notion setting or status cannot be read, and hides the people sync an installation does not offer", async () => {
  m.meetings.mockResolvedValue(null); m.people.mockResolvedValue(null);
  m.sync.mockResolvedValue({ lastRunAt: null, synced: 0, needsYou: 0, retrying: 0, unmatched: 0, unavailable: true });
  m.proposals.mockResolvedValue({ proposals: [], frozen: [], unavailable: true });
  const html = await show("notion");
  expect(html).toContain("The meetings database setting could not be loaded.");
  expect(html).not.toContain("PEOPLE-SYNC");
  expect(html).toContain("The status of the document sync could not be read.");
  expect(html).toContain("The changes waiting for you could not be read.");
  expect(html).not.toContain("NOTION-PROPOSALS");
  m.sync.mockResolvedValue({ lastRunAt: null, synced: 0, needsYou: 0, retrying: 0, unmatched: 0 });
  expect(await show("notion")).toContain("No document sync run is recorded.");
  m.sync.mockResolvedValue({ lastRunAt: "2026-10-08T10:00:00Z", synced: 7, needsYou: 2, retrying: 1, unmatched: 3 });
  expect(await show("notion")).toContain("Document sync last ran 2026-10-08 10:00 UTC: 7 synced, 2 need you, 1 retrying, 3 unmatched.");
});

it("holds the clipping card on the Notion page, and points there from the Readability page", async () => {
  expect(await show("notion")).toContain("CLIPPING-CARD");
  const readability = await show("readability");
  expect(readability).not.toContain("CLIPPING-CARD");
  expect(readability).toContain('href="/integrations/notion"');
  expect(await show("twenty")).not.toContain("CLIPPING-CARD");
  expect(await show("twenty")).not.toContain('href="/integrations/notion"');
});

it("keeps clipping reachable on the Readability page when the installation has no Notion page", async () => {
  rows = rows.filter(r => r.connectionId !== "notion");
  const html = await show("readability");
  expect(html).toContain("CLIPPING-CARD");
  expect(html).not.toContain('href="/integrations/notion"');
});

it("shows the gateway status the grid shows, and which agents use it by display name", async () => {
  const setUp = (usage: Record<string, string[]> | null) => ({ kind: "status", usage, status: { reachability: "reachable" } });
  expect(await show("gateway")).toContain("Status unavailable");
  m.gateway.mockResolvedValue(setUp({ "model-a": ["assistant", "writer"] }));
  const html = await show("gateway");
  expect(html).toContain("Enabled");
  expect(html).toContain("Assistant, writer");
});

it("names the built-in services plainly and leaves an unknown id as it is", async () => {
  rows.find(r => r.connectionId === "telegram")!.declaredFor = ["notion-sync", "other-service"];
  const html = await show("telegram");
  expect(html).toContain("Notion sync, other-service");
  expect(html).not.toContain("notion-sync");
});
