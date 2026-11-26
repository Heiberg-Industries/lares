// @vitest-environment jsdom
/**
 * What each person is shown: the role picker on Members, the line on Your membership that says why someone
 * landed there, and the owner's buttons that an admin does not get on pages an admin may open. What is shown
 * is never the gate (tests/console-levels.test.tsx proves the actions refuse); this proves the pages are honest.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";

const m = vi.hoisted(() => ({
  person: { id: "owner-1", role: "owner", status: "active", organisationId: "org", automationMode: "draft-and-ask" } as { id: string; role: string; status: string; organisationId: string; automationMode: string },
  directory: vi.fn(), doorStatus: vi.fn(), testBriefStatus: vi.fn(), claimCode: vi.fn(), sendTestBrief: vi.fn(),
}));
// The real lib/auth.ts decides; only the session lookup and the database behind it are stand-ins.
vi.mock("@lares/agent-kit/member-store", async (original) => ({
  ...(await original<typeof import("@lares/agent-kit/member-store")>()),
  PgMemberStore: class { sessionMember = async () => m.person; listMembers = m.directory; listInvitations = async () => []; },
}));
vi.mock("../lib/db", () => ({ pool: { query: async () => ({ rows: [{ primary_email: "person@example.test" }] }) } }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => ({ value: "s".repeat(43) }) }) }));
vi.mock("next/navigation", () => ({ redirect: (path: string) => { throw new Error(`redirect:${path}`); }, useRouter: () => ({ push() {}, refresh() {} }) }));
vi.mock("next/link", () => ({ default: ({ href, children, ...p }: React.ComponentProps<"a">) => <a href={href} {...p}>{children}</a> }));
vi.mock("../lib/initial-member-budget", () => ({ listInitialMemberBudgetStatus: async () => ({ available: true, members: [] }) }));
vi.mock("../components/InitialMemberBudgetSetup", () => ({ InitialMemberBudgetSetup: () => null }));
vi.mock("../components/InviteMember", () => ({ InviteMember: () => null }));
vi.mock("../components/OutsideDiscoverySection", () => ({ OutsideDiscoverySection: () => null }));
vi.mock("../components/PrivateMetadataDeviceSection", () => ({ PrivateMetadataDeviceSection: () => null }));
vi.mock("../app/actions/members", () => ({ removeMember: vi.fn(), revokeInvitation: vi.fn(), signOutMember: vi.fn(), signOutEverywhere: vi.fn(), setMemberRole: vi.fn(async () => ({})) }));
vi.mock("../app/actions/definition", () => ({
  doorStatus: m.doorStatus, claimCode: m.claimCode, connectDoor: vi.fn(), verifyDoor: vi.fn(), setDoorEnabled: vi.fn(), applyConnections: vi.fn(), registerTelegram: vi.fn(),
  listConversations: vi.fn(async () => ({ ok: true, result: [] })), startFreshConversation: vi.fn(),
}));
vi.mock("../app/actions/delivery", () => ({ sendTestBrief: m.sendTestBrief, testBriefStatus: m.testBriefStatus }));
vi.mock("../app/actions/outside-connectors", () => ({ checkConnector: vi.fn(), removeConnector: vi.fn(), renameConnector: vi.fn() }));

import MembersPage from "../app/members/page";
import MembershipPage from "../app/your-membership/page";
import { WaitingList } from "../components/WaitingList";
import { ConnectorActions } from "../components/ConnectorActions";
import { ConversationControl } from "../components/ConversationControl";
import { DoorSetup, OWNER_LAST_STEP } from "../components/DoorSetup";
import { PICKER_ROLES, ROLE_CHOICES, ROLE_WORDS } from "../lib/member-roles";

const person = (id: string, role: string, status = "active") => ({ id, role, status, organisationId: "org", automationMode: "draft-and-ask" });
const entry = (id: string, role: string, displayName: string, status = "active") => ({ member: person(id, role, status), displayName, email: `${id}@example.test` });
const row = (name: string) => screen.getByText(name).closest("li") as HTMLElement;

beforeEach(() => {
  vi.stubEnv("AGENT_OWNER_USER_ID", "owner-1");
  m.person = person("owner-1", "owner");
  m.directory.mockReset().mockResolvedValue([
    entry("owner-1", "owner", "Sam Owner"), entry("m-1", "member", "Alex Member"), entry("a-1", "admin", "Robin Admin"),
    entry("r-1", "restricted", "Kim Limited"), entry("o-2", "owner", "Jo Second"), entry("x-1", "member", "Pat Removed", "removed"), entry("i-1", "member", "Lee Invited", "invited"),
  ]);
  m.doorStatus.mockReset().mockResolvedValue({ ok: true, result: [{ kind: "slack", enabled: true, configured: true, claimed: false, pending: false, applied: true }] });
  m.testBriefStatus.mockReset().mockResolvedValue({ view: null, dnd: false });
});
afterEach(() => { cleanup(); vi.unstubAllEnvs(); });

describe("Members: the owner picks Admin or Member per person", () => {
  it("offers Admin and Member, one line each, with the person's current role chosen", async () => {
    render(await MembersPage());
    for (const [name, current] of [["Alex Member", "member"], ["Robin Admin", "admin"], ["Lee Invited", "member"]] as const) {
      const group = within(row(name)).getByRole("group", { name: `Role for ${name}` });
      const radios = within(group).getAllByRole("radio") as HTMLInputElement[];
      expect(radios.map(r => r.value)).toEqual(["member", "admin"]);
      expect(radios.find(r => r.checked)?.value, name).toBe(current);
      for (const role of PICKER_ROLES) expect(group.textContent).toContain(`${ROLE_WORDS[role]!.name}. ${ROLE_WORDS[role]!.meaning}`);
      expect((row(name).querySelector('input[name="memberId"][type="hidden"]') as HTMLInputElement).value).toBeTruthy();
      expect(within(row(name)).getByRole("button", { name: "Save role" })).toBeTruthy();
    }
  });
  it("offers no choice for the owner's own row, another owner, a limited member or a removed person, and says the owner's own role stays", async () => {
    render(await MembersPage());
    for (const name of ["Sam Owner", "Jo Second", "Kim Limited", "Pat Removed"]) {
      expect(within(row(name)).queryByRole("radio"), name).toBeNull();
      expect(within(row(name)).queryByRole("button", { name: "Save role" }), name).toBeNull();
    }
    expect(row("Sam Owner").textContent).toContain("Your own role cannot be changed here.");
    expect(row("Kim Limited").textContent).toContain("Limited member.");
  });
  it("puts the picker under the person's name, not among the row's buttons", async () => {
    render(await MembersPage());
    const picker = within(row("Alex Member")).getByRole("group", { name: "Role for Alex Member" });
    expect(picker.closest(".lares-row-main")).not.toBeNull();
    expect(picker.closest(".lares-row-control")).toBeNull();
  });
  it("is not rendered for an admin or a member: they are sent away and the directory is never read", async () => {
    for (const who of [person("a-1", "admin"), person("m-1", "member"), person("odd", "superuser")]) {
      m.person = who; m.directory.mockClear();
      await expect(MembersPage()).rejects.toThrow("redirect:/your-membership?refused=1");
      expect(m.directory).not.toHaveBeenCalled();
    }
  });
  it("uses one list of roles for the picker and the invitation form, and has words for every stored role", () => {
    expect([...ROLE_CHOICES].sort()).toEqual(["admin", "member", "owner", "restricted"]);
    expect(PICKER_ROLES).toEqual(["member", "admin"]);
    for (const role of ROLE_CHOICES) { expect(ROLE_WORDS[role]!.name.length).toBeGreaterThan(3); expect(ROLE_WORDS[role]!.meaning.length).toBeGreaterThan(30); }
    expect(ROLE_WORDS.admin!.meaning).toContain("Cannot change members and roles, backups or the general settings");
  });
});

describe("Your membership says why someone was brought there", () => {
  const show = async (search: Record<string, string>) => render(await MembershipPage({ searchParams: Promise.resolve(search) }));
  it("says nothing extra on an ordinary visit", async () => {
    m.person = person("m-1", "member");
    await show({});
    expect(screen.queryByText(/not allowed for your role/)).toBeNull();
    expect(screen.getByText(/You are a member\./)).toBeTruthy();
  });
  it("tells a member the page was not allowed, and who it is for", async () => {
    m.person = person("m-1", "member");
    await show({ refused: "1" });
    expect(screen.getByText(/You were brought here because the page you opened is not allowed for your role\. It is for the owner of this installation, or a person the owner made an admin\./)).toBeTruthy();
    expect(screen.queryByRole("link", { name: /Open the/ })).toBeNull();
  });
  it("tells an admin which pages stay with the owner, and offers the console they may use", async () => {
    m.person = person("a-1", "admin");
    await show({ refused: "1" });
    expect(screen.getByText(/not allowed for your role\. Members and roles, backups and the general settings are for the owner of this installation\./)).toBeTruthy();
    expect(screen.getByText(/You are an admin\./)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open the console" }).getAttribute("href")).toBe("/");
    expect(screen.queryByRole("link", { name: "Open the owner console" })).toBeNull();
  });
  it("offers the owner the owner console as before", async () => {
    await show({});
    expect(screen.getByRole("link", { name: "Open the owner console" }).getAttribute("href")).toBe("/");
  });
});

describe("what an admin is shown in place of the owner's buttons", () => {
  it("Reviews: an empty list says approvals are answered by each agent's owner", () => {
    render(<WaitingList items={[]} unreadable={[]} now={0} onDecide={vi.fn()} emptyNote="Approvals are answered by each agent's owner, so there is nothing here for you to decide." />);
    expect(screen.getByText("Approvals are answered by each agent's owner, so there is nothing here for you to decide.")).toBeTruthy();
    cleanup();
    render(<WaitingList items={[]} unreadable={[]} now={0} onDecide={vi.fn()} />);
    expect(screen.getByText(/When an agent asks for your approval/)).toBeTruthy();
  });
  it("Outside tools: no Remove button, and a line saying who can", () => {
    render(<ConnectorActions id="c" displayName="Registry" canRemove={false} />);
    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
    expect(screen.getByText("Only the owner can remove a connector.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Rename" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Check it works" })).toBeTruthy();
    cleanup();
    render(<ConnectorActions id="c" displayName="Registry" canRemove={true} />);
    expect(screen.getByRole("button", { name: "Remove" })).toBeTruthy();
  });
  it("Agents: an admin can see recent conversations and is told only the owner can end one", () => {
    render(<ConversationControl name="example" owner={false} />);
    expect(screen.getByText("Only the owner can end a conversation. You can see the recent ones here.")).toBeTruthy();
  });
  it("Chat doors: the door is shown set up, with one sentence that the owner does the last step; no code and no test brief", async () => {
    m.doorStatus.mockResolvedValue({ ok: true, result: [{ kind: "slack", enabled: true, configured: true, claimed: false, pending: false, applied: true }, { kind: "telegram", enabled: true, configured: true, claimed: true, pending: false, applied: true }] });
    render(<DoorSetup owner={false} name="example" display="Example" role="chief-of-staff" origin="https://doors.example.test" hash={"a".repeat(64)} />);
    await waitFor(() => expect(screen.getByText(OWNER_LAST_STEP)).toBeTruthy());
    expect(OWNER_LAST_STEP).toBe("The door is set up. The owner does the last step, connecting themselves, from this page.");
    expect(screen.queryByRole("button", { name: /one-time code|tap-to-connect/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Send a test brief/ })).toBeNull();
    // What an admin may do is still there.
    expect(screen.getAllByRole("button", { name: /Disable door/ }).length).toBe(2);
    expect(m.claimCode).not.toHaveBeenCalled();
    expect(m.sendTestBrief).not.toHaveBeenCalled();
  });
  it("Chat doors: the owner still gets the one-time code and the test brief", async () => {
    m.doorStatus.mockResolvedValue({ ok: true, result: [{ kind: "slack", enabled: true, configured: true, claimed: false, pending: false, applied: true }, { kind: "telegram", enabled: true, configured: true, claimed: true, pending: false, applied: true }] });
    render(<DoorSetup owner={true} name="example" display="Example" role="chief-of-staff" origin="https://doors.example.test" hash={"a".repeat(64)} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Show the one-time code" })).toBeTruthy());
    expect(screen.queryByText(OWNER_LAST_STEP)).toBeNull();
    expect(screen.getByRole("button", { name: "Send a test brief to Telegram" })).toBeTruthy();
  });
});
