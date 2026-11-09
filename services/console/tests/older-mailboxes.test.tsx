// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
const m = vi.hoisted(() => ({ member: vi.fn(), owner: vi.fn(), list: vi.fn(), older: vi.fn() }));
vi.mock("../lib/auth", () => ({ requireMember: m.member, isConsoleOwner: m.owner }));
vi.mock("../lib/db", () => ({ pool: {} }));
vi.mock("../lib/accounts", () => ({ listGoogleAccounts: m.older }));
vi.mock("@lares/agent-kit/account-store", () => ({ PgAccountStore: class { list = m.list; } }));
vi.mock("../lib/agent-mailbox", () => ({ listAgentUses: async () => [], accountStatusLabel: () => "" }));
vi.mock("../app/actions/accounts", () => ({ removeAccount: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("next/link", () => ({ default: ({ href, children }: React.ComponentProps<"a">) => <a href={href}>{children}</a> }));
import AccountsPage from "../app/accounts/page";

const show = async () => render(await AccountsPage({ searchParams: Promise.resolve({}) }));
const old = { email: "old@example.com", org: "example", scopeCount: 3, connectedAt: "2026-09-01" };
beforeEach(() => {
  vi.clearAllMocks();
  m.member.mockResolvedValue({ id: "member-a", role: "owner" }); m.owner.mockReturnValue(true); m.list.mockResolvedValue([]);
  m.older.mockResolvedValue({ accounts: [old], unavailable: false });
});
afterEach(cleanup);

it("lets the owner remove each older mailbox connection", async () => {
  await show();
  expect(screen.getByRole("heading", { name: "Older mailbox connections" })).toBeTruthy();
  expect(document.body.textContent).toContain("These came from an older way of connecting mail. Nothing uses them any more. You can remove them.");
  expect(screen.getByText("old@example.com")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Remove" })).toBeTruthy();
});

it("shows nothing when there are none, when the read is unavailable, or to a member who is not the owner", async () => {
  m.older.mockResolvedValue({ accounts: [], unavailable: false });
  await show(); expect(screen.queryByText("Older mailbox connections")).toBeNull(); cleanup();
  m.older.mockResolvedValue({ accounts: [old], unavailable: true });
  await show(); expect(screen.queryByText("Older mailbox connections")).toBeNull();
  expect(document.body.textContent).not.toContain("unavailable. Older"); cleanup();
  m.older.mockResolvedValue({ accounts: [old], unavailable: false }); m.owner.mockReturnValue(false);
  await show(); expect(screen.queryByText("Older mailbox connections")).toBeNull();
  expect(m.older).toHaveBeenCalledTimes(2);
});
