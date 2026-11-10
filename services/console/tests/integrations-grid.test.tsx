// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderToStaticMarkup } from "react-dom/server";
const m = vi.hoisted(() => ({ rows: vi.fn(), credential: vi.fn(), outside: vi.fn(), guard: vi.fn(), gateway: vi.fn() }));
vi.mock("../lib/auth", () => ({ requireConsolePage: m.guard }));
vi.mock("../lib/connections", () => ({ getConnectionRows: m.rows }));
vi.mock("../lib/credentials", () => ({ getCredentialView: m.credential }));
vi.mock("../lib/outside-tools", () => ({ anyOutsideToolsInUse: m.outside }));
vi.mock("../lib/gateway-status", () => ({ getGatewayStatusView: m.gateway }));
vi.mock("next/link", () => ({ default: ({ href, children, ...p }: React.ComponentProps<"a">) => <a href={href} {...p}>{children}</a> }));
import IntegrationsPage from "../app/integrations/page";
import { buildIntegrationCards } from "../lib/integrations-grid";
import type { ConnectionRowDTO } from "../lib/contracts";
import type { GatewayStatusView } from "../lib/gateway-status";

const setUp = (reachability: "reachable" | "not-configured" = "reachable", usage: Record<string, string[]> | null = {}): GatewayStatusView => ({
  kind: "status", usage,
  status: { mode: "managed", endpoint: null, checkedAt: "2026-11-10T10:00:00.000Z", reachability, details: { state: "not-managed" }, purposes: [], providerTested: false },
});

const row = (connectionId: string, over: Partial<ConnectionRowDTO> = {}): ConnectionRowDTO => ({
  connectionId, instanceId: "shared", label: connectionId, custody: "host", status: "unknown", detail: "no recorded use",
  accountsUnavailable: false, usageUnavailable: false, lastUsed: null, usedBy: [], declaredFor: [], accounts: [], ...over,
});
const catalogue = ["microsoft", "google", "twenty", "readability", "gateway", "notion", "slack", "telegram", "karakeep", "signals"];
const rows = (live: string[] = []) => catalogue.map(id => row(id, live.includes(id) ? { status: "live", detail: "in use" } : {}));
beforeEach(() => {
  vi.clearAllMocks(); m.guard.mockResolvedValue(undefined);
  m.rows.mockResolvedValue(rows(["gateway", "telegram"])); m.credential.mockResolvedValue({ kind: "unavailable" }); m.outside.mockResolvedValue(false); m.gateway.mockResolvedValue(setUp());
});
afterEach(cleanup);

it("makes one card per shared service, none for the personal accounts, with statuses from the connection data", () => {
  const cards = buildIntegrationCards({ rows: rows(["gateway", "telegram"]), credential: { kind: "unavailable" }, outsideToolsInUse: false, gateway: setUp("not-configured") });
  expect(cards.map(c => c.name)).toEqual(["Notion", "Twenty CRM", "Slack (bot)", "Telegram (bot)", "Karakeep", "Readability worker", "Model gateway", "Signal spine", "Outside tools (MCP)"]);
  expect(cards.filter(c => c.status === "enabled").map(c => c.id)).toEqual(["telegram"]);
  expect(cards.find(c => c.id === "twenty")!.href).toBe("/integrations/twenty");
});

it("counts an applied Notion key, agent access and outside tools in use as enabled, and an unreadable status as unavailable", () => {
  const applied = { kind: "status", status: { state: "applied" } } as never;
  const base = rows();
  base.find(r => r.connectionId === "slack")!.usedBy = ["assistant"];
  base.find(r => r.connectionId === "karakeep")!.status = "unavailable";
  const cards = buildIntegrationCards({ rows: base, credential: applied, outsideToolsInUse: true, gateway: setUp("not-configured") });
  const status = (id: string) => cards.find(c => c.id === id)!.status;
  expect([status("notion"), status("slack"), status("outside"), status("karakeep"), status("twenty")]).toEqual(["enabled", "enabled", "enabled", "unavailable", "available"]);
});

it("puts the writing-style and meetings buttons in the page header", async () => {
  render(await IntegrationsPage());
  expect(screen.getByRole("link", { name: "Email writing style" }).getAttribute("href")).toBe("/voice");
  expect(screen.getByRole("link", { name: "Meetings" }).getAttribute("href")).toBe("/meetings");
});

it("renders the header, Enabled before Available, and each card's own status word", async () => {
  render(await IntegrationsPage());
  expect(screen.getByRole("heading", { name: "Integrations" })).toBeTruthy();
  expect(document.body.textContent).toContain("Services shared by the whole installation. Only the owner turns them on or changes them.");
  const enabled = screen.getByRole("region", { name: "Enabled" }), available = screen.getByRole("region", { name: "Available" });
  expect(within(enabled).getAllByRole("link").map(a => a.textContent)).toEqual([
    expect.stringContaining("Telegram (bot)"), expect.stringContaining("Model gateway")]);
  expect([...enabled.querySelectorAll(".lares-card-status")].map(e => e.textContent)).toEqual(["Enabled", "Enabled"]);
  expect(within(available).getAllByText("Connect")).toHaveLength(7);
  expect(within(available).getByRole("link", { name: /Outside tools/ }).getAttribute("href")).toBe("/integrations/outside");
});

it("filters the cards by name as you type, and says when nothing matches", async () => {
  render(await IntegrationsPage());
  const search = screen.getByRole("searchbox", { name: "Search integrations" });
  await userEvent.type(search, "tele");
  expect([...document.querySelectorAll(".lares-card-link")].map(a => a.textContent)).toEqual([expect.stringContaining("Telegram (bot)")]);
  expect(screen.queryByRole("region", { name: "Available" })).toBeNull();
  await userEvent.clear(search); await userEvent.type(search, "zzz");
  expect(screen.getByRole("status").textContent).toContain("No integration matches");
});

it("still shows every card when the page is rendered without scripts", async () => {
  const html = renderToStaticMarkup(await IntegrationsPage());
  for (const name of ["Notion", "Twenty CRM", "Slack (bot)", "Telegram (bot)", "Karakeep", "Readability worker", "Model gateway", "Signal spine", "Outside tools (MCP)"]) expect(html).toContain(name);
});

it("shows the gateway card from the gateway itself: set up, used by an agent, not set up, or unreadable", () => {
  const status = (gateway: GatewayStatusView) =>
    buildIntegrationCards({ rows: rows(), credential: { kind: "unavailable" }, outsideToolsInUse: false, gateway }).find(c => c.id === "gateway")!.status;
  expect(status(setUp("reachable"))).toBe("enabled");
  expect(status(setUp("not-configured", { "model-a": ["assistant"] }))).toBe("enabled");
  expect(status(setUp("not-configured", null))).toBe("available");
  for (const kind of ["keeper-unavailable", "refused", "invalid", "sign-in-required"] as const) expect(status({ kind })).toBe("unavailable");
});

it("renders the gateway as Enabled on the grid page even with no connection use recorded", async () => {
  m.rows.mockResolvedValue(rows());
  render(await IntegrationsPage());
  expect(within(screen.getByRole("region", { name: "Enabled" })).getAllByRole("link").map(a => a.textContent)).toEqual([expect.stringContaining("Model gateway")]);
});
