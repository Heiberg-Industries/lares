// @vitest-environment jsdom
/**
 * The agent's own page, as the owner and as an admin. The owner must get the sharing section even for an
 * agent nobody has adopted yet (that is where "Adopt under my identity" lives), and the agent's own model
 * key. An admin gets neither, and neither the member directory nor the key state is read for them.
 */
import React from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const m = vi.hoisted(() => ({
  person: { id: "owner-1", role: "owner", status: "active", organisationId: "org", automationMode: "draft-and-ask" },
  access: vi.fn(), directory: vi.fn(), keyStatus: vi.fn(),
}));
vi.mock("@lares/agent-kit/member-store", async (original) => ({
  ...(await original<typeof import("@lares/agent-kit/member-store")>()),
  PgMemberStore: class { sessionMember = async () => m.person; listMembers = m.directory; },
}));
vi.mock("../lib/db", () => ({ pool: { query: async () => ({ rows: [{ primary_email: "person@example.test" }] }) } }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => ({ value: "s".repeat(43) }) }) }));
vi.mock("next/navigation", () => ({ redirect: (path: string) => { throw new Error(`redirect:${path}`); }, notFound: () => { throw new Error("not-found"); } }));
vi.mock("../lib/agent-access", () => ({ agentAccess: { agentAccess: m.access } }));
vi.mock("../lib/provider-key", () => ({ providerKeyStatusFor: m.keyStatus }));
vi.mock("../lib/agent-mailbox", () => ({ agentMailboxView: async () => undefined, mailboxUnavailableView: () => undefined }));
vi.mock("../lib/agents", () => ({ listAgents: async () => [{ name: "example", displayName: "Example", role: "creative", skills: [], doors: [], grants: [] }], savedAgentFolder: () => undefined }));
vi.mock("../lib/board", () => ({ getBoardRows: async () => [] }));
vi.mock("../lib/builder", () => ({ builderData: async () => ({ initial: { definition: { name: "example", role: "creative", schedules: {} }, hash: "a".repeat(64), status: "valid" } }) }));
vi.mock("../lib/console-overview", () => ({ getPermissionEvents: async () => ({ available: false }) }));
vi.mock("../lib/agent-detail", () => ({ agentStatus: () => "unknown", getPromptCacheLine: async () => null }));
vi.mock("../lib/outside-tools", () => ({ getOutsideToolEvidence: async () => undefined }));
vi.mock("../lib/outside-connector-view", () => ({ liveDangerTools: async () => [] }));
vi.mock("../lib/delivery-notes", () => ({ fallbackNotes: async () => [] }));
// The page's parts, reduced to what this test asks about.
vi.mock("../components/AgentDetail", () => ({ AgentDetail: (p: { owner: boolean; accessSettings?: React.ReactNode; providerKeySettings?: React.ReactNode }) =>
  <div data-owner={String(p.owner)}><section aria-label="access">{p.accessSettings}</section><section aria-label="key">{p.providerKeySettings}</section></div> }));
vi.mock("../components/AgentAccess", () => ({ AgentAccess: (p: { access: unknown }) => <div>{p.access ? "Sharing for an adopted agent" : "Adopt under my identity"}</div> }));
vi.mock("../components/AgentProviderKey", () => ({ AgentProviderKey: () => <div>Key for this agent</div> }));
vi.mock("../components/AgentMailbox", () => ({ AgentMailbox: () => null }));

import AgentPage from "../app/agents/[name]/page";
const show = async () => render(await AgentPage({ params: Promise.resolve({ name: "example" }) }));
const as = (id: string, role: string) => { m.person = { ...m.person, id, role }; };

beforeEach(() => {
  vi.stubEnv("AGENT_OWNER_USER_ID", "owner-1");
  as("owner-1", "owner");
  m.access.mockReset().mockResolvedValue(undefined);
  m.directory.mockReset().mockResolvedValue([]);
  m.keyStatus.mockReset().mockResolvedValue({ kind: "unavailable" });
});
afterEach(() => { cleanup(); vi.unstubAllEnvs(); });

it("gives the owner the sharing section for an agent nobody has adopted yet, so it can be adopted", async () => {
  await show();
  expect(screen.getByText("Adopt under my identity")).toBeTruthy();
  expect(screen.getByText("Key for this agent")).toBeTruthy();
  expect(m.access).toHaveBeenCalledWith("owner-1", "example");
});
it("gives the owner the sharing section for an adopted agent", async () => {
  m.access.mockResolvedValue({ ownerMemberId: "owner-1", grants: [], revision: 1 });
  await show();
  expect(screen.getByText("Sharing for an adopted agent")).toBeTruthy();
});
it("shows an admin the agent without sharing or the model key, and reads neither the directory nor the key state for them", async () => {
  as("admin-1", "admin");
  await show();
  expect(screen.queryByText("Adopt under my identity")).toBeNull();
  expect(screen.queryByText("Sharing for an adopted agent")).toBeNull();
  expect(screen.queryByText("Key for this agent")).toBeNull();
  expect(screen.getByText("Only the owner decides who may use or edit this agent, and sets the agent's own model key.")).toBeTruthy();
  expect(m.access).not.toHaveBeenCalled(); expect(m.directory).not.toHaveBeenCalled(); expect(m.keyStatus).not.toHaveBeenCalled();
});
it("sends a member away before anything is read", async () => {
  as("member-1", "member");
  await expect(AgentPage({ params: Promise.resolve({ name: "example" }) })).rejects.toThrow("redirect:/your-membership?refused=1");
  expect(m.access).not.toHaveBeenCalled();
});
