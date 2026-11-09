// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
const m = vi.hoisted(() => ({ member: vi.fn(), owner: vi.fn(), list: vi.fn(), uses: vi.fn(), remove: vi.fn(), refresh: vi.fn() }));
vi.mock("../lib/auth", () => ({ requireMember: m.member, isConsoleOwner: m.owner }));
vi.mock("../lib/db", () => ({ pool: {} }));
vi.mock("@lares/agent-kit/account-store", () => ({ PgAccountStore: class { list = m.list; } }));
vi.mock("../lib/agent-mailbox", async () => ({ listAgentUses: m.uses, accountStatusLabel: (await vi.importActual<typeof import("../lib/agent-mailbox")>("../lib/agent-mailbox")).accountStatusLabel }));
vi.mock("../app/actions/accounts", () => ({ removeAccount: m.remove }));
vi.mock("../app/actions/members", () => ({ signOutEverywhere: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: m.refresh }) }));
vi.mock("next/link", () => ({ default: ({ href, children }: React.ComponentProps<"a">) => <a href={href}>{children}</a> }));
import AccountsPage from "../app/accounts/page";
import MembershipPage from "../app/membership/page";

const google = { id: "stable-account", connectorId: "google", providerAccount: { label: "owner@example.com" }, generation: 7, status: "ok" };
const microsoft = { id: "ms-account", connectorId: "microsoft", providerAccount: { label: "work@example.com" }, generation: 2, status: "ok" };
const show = async (params = {}) => render(await AccountsPage({ searchParams: Promise.resolve(params) }));
const row = (name: string) => screen.getByText(name, { selector: ".lares-service-name" }).closest(".lares-service-row") as HTMLElement;
beforeEach(() => {
  vi.clearAllMocks();
  m.member.mockResolvedValue({ id: "member-a", role: "member" }); m.owner.mockReturnValue(false);
  m.uses.mockResolvedValue([{ agent: "writer", accountId: "stable-account" }, { agent: "other", accountId: "elsewhere" }]);
  m.list.mockResolvedValue([]); m.remove.mockResolvedValue(undefined);
});
afterEach(cleanup);

it("shows both services with Connect when nothing is connected, and reads only the member's own accounts", async () => {
  await show();
  expect(m.list).toHaveBeenCalledWith("member-a");
  expect(screen.getByRole("heading", { name: "Your accounts" })).toBeTruthy();
  expect(within(row("Google")).getByText("Gmail and Calendar")).toBeTruthy();
  expect(within(row("Microsoft")).getByText("Work mailbox and calendar")).toBeTruthy();
  expect(screen.getAllByRole("button", { name: /^Connect/ })).toHaveLength(2);
  expect(screen.queryByText("Connected")).toBeNull();
  expect(document.body.textContent).toContain("More services come later.");
  expect(screen.queryByRole("link", { name: "Integrations" })).toBeNull();
});

it("links to Integrations only for the owner", async () => {
  m.owner.mockReturnValue(true);
  await show();
  expect(screen.getByRole("link", { name: "Integrations" }).getAttribute("href")).toBe("/integrations");
});

it("opens a form that posts a new Google connection with the email and the permission choice", async () => {
  await show();
  await userEvent.click(within(row("Google")).getByRole("button", { name: /Connect/ }));
  const form = (await screen.findByRole("dialog")).querySelector("form")!;
  expect(form.getAttribute("action")).toBe("/api/accounts/google/start");
  expect(form.querySelector('input[name="intent"]')!.getAttribute("value")).toBe("new");
  expect(form.querySelector('input[name="email"]')).toBeTruthy();
  expect((form.querySelector('select[name="power"]') as HTMLSelectElement).value).toBe("read");
});

it("posts a new Microsoft connection without asking for an address", async () => {
  await show();
  await userEvent.click(within(row("Microsoft")).getByRole("button", { name: /Connect/ }));
  const form = (await screen.findByRole("dialog")).querySelector("form")!;
  expect(form.getAttribute("action")).toBe("/api/accounts/microsoft/start");
  expect(form.querySelector('input[name="email"]')).toBeNull();
});

it("shows Connected with a menu, and who uses the account, for the member's own account only", async () => {
  m.list.mockResolvedValue([google]);
  await show({ added: "x" });
  expect(document.body.textContent).toContain("Used by: writer");
  expect(document.body.textContent).not.toContain("other");
  expect(screen.getByRole("status").textContent).toBe("Account connected.");
  await userEvent.click(screen.getByRole("button", { name: /Connected/ }));
  const menu = await screen.findByRole("menu");
  expect(within(menu).getByRole("menuitem", { name: "owner@example.com" })).toBeTruthy();
  for (const name of ["Connect another Google account", "Reconnect", "Disconnect"]) expect(within(menu).getByRole("menuitem", { name })).toBeTruthy();
});

it("reconnects by stable account id and generation", async () => {
  m.list.mockResolvedValue([google]);
  await show();
  await userEvent.click(screen.getByRole("button", { name: /Connected/ }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Reconnect" }));
  const form = (await screen.findByRole("dialog")).querySelector("form")!;
  expect(form.getAttribute("action")).toBe("/api/accounts/google/start");
  expect(form.querySelector('input[name="intent"]')!.getAttribute("value")).toBe("reconnect");
  expect(form.querySelector('input[name="accountId"]')!.getAttribute("value")).toBe("stable-account");
  expect(form.querySelector('input[name="generation"]')!.getAttribute("value")).toBe("7");
  expect(form.querySelector('input[name="email"]')).toBeNull();
});

it("disconnects through the existing action with the account id and generation", async () => {
  m.list.mockResolvedValue([google]);
  await show();
  await userEvent.click(screen.getByRole("button", { name: /Connected/ }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Disconnect" }));
  await waitFor(() => expect(m.remove).toHaveBeenCalledWith({ accountId: "stable-account", generation: 7 }));
  expect(m.refresh).toHaveBeenCalled();
});

it("says a disconnected account needs attention instead of Connected, in the one plain sentence", async () => {
  m.list.mockResolvedValue([{ ...google, status: "revoked" }, microsoft]);
  await show();
  expect(within(row("Google")).getByRole("button", { name: /Needs attention/ })).toBeTruthy();
  expect(within(row("Google")).queryByText("Connected")).toBeNull();
  expect(row("Google").textContent).toContain("owner@example.com was disconnected or needs your permission again");
  expect(within(row("Microsoft")).getByRole("button", { name: /Connected/ })).toBeTruthy();
});

it("keeps technical words and raw errors off the page", async () => {
  m.list.mockResolvedValue([google]);
  await show({ error: "PRIVATE PROVIDER RESPONSE" });
  expect(screen.getByRole("alert").textContent).toBe("The account could not be connected. Try again.");
  const text = document.body.textContent!;
  for (const word of ["PRIVATE", "partial", "credentials", "consumers", "catalogue", "scope"]) expect(text).not.toContain(word);
});

it("says so when the accounts cannot be read, instead of an empty list", async () => {
  m.list.mockRejectedValue(new Error("PRIVATE DATABASE ERROR"));
  await show();
  expect(document.body.textContent).toContain("Your accounts are unavailable");
  expect(document.body.textContent).not.toContain("PRIVATE");
  expect(screen.queryByRole("button", { name: /Connect/ })).toBeNull();
});

it("moves the personal accounts off the membership page, leaving a link", async () => {
  render(await MembershipPage());
  expect(m.list).not.toHaveBeenCalled();
  expect(screen.getByRole("link", { name: "Your accounts" }).getAttribute("href")).toBe("/accounts");
  expect(document.body.textContent).toContain("Private chat is available");
  expect(document.body.textContent).not.toContain("Your personal accounts");
});
