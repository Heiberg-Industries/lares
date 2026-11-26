// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
const path = vi.hoisted(() => ({ current: "/" }));
vi.mock("next/navigation", () => ({ usePathname: () => path.current }));
vi.mock("next/link", () => ({ default: ({ href, children, ...p }: React.ComponentProps<"a">) => <a href={href} {...p}>{children}</a> }));
vi.mock("../components/ThemeControl", () => ({ ThemeControl: () => <div role="group" aria-label="Color theme" />, useConsoleTheme: () => ({ theme: "system", onChange: () => {} }) }));
vi.mock("../components/InboxDot", () => ({ InboxDot: () => <span data-testid="unread-dot" /> }));
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ADMIN_MENU, COMING, MEMBER_MENU, Nav, currentHref, OWNER_MENU, OWNER_ONLY_PAGES, MEMBERSHIP } from "../components/Nav";
afterEach(() => { cleanup(); path.current = "/"; });

/** The sidebar as a person reads it: group labels, then each entry as "words -> address", or "words (coming)". */
function menu(root: HTMLElement) {
  return [...root.querySelectorAll("[data-slot=sidebar-group-label], [data-slot=sidebar-menu-button], [role=group]")].map((el) => {
    if (el.matches("[data-slot=sidebar-group-label]")) return `# ${el.textContent}`;
    if (el.matches("[role=group]")) return `Appearance: ${el.getAttribute("aria-label")}`;
    const words = el.querySelector("span")?.textContent;
    if (el.getAttribute("aria-disabled") === "true") return `${words} (coming)`;
    return el.tagName === "A" ? `${words} -> ${el.getAttribute("href")}` : `${words} [button]`;
  });
}
const sidebar = () => document.querySelector("aside[data-slot=sidebar]") as HTMLElement;
const current = () => within(sidebar()).getAllByRole("link").filter((a) => a.getAttribute("aria-current") === "page").map((a) => a.getAttribute("href"));

describe("the owner's menu", () => {
  it("is exactly the agreed list, in order, each address reading like its words", () => {
    render(<Nav level="owner" person="Sam Example" />);
    expect(menu(sidebar())).toEqual([
      "Overview -> /",
      "Reviews -> /reviews",
      "Chat -> /chat",
      "# Agents",
      "Agents -> /agents",
      "Writing style -> /writing-style",
      "Skills (coming)",
      "Profiles (coming)",
      "# Connections",
      "Your accounts -> /your-accounts",
      "Integrations -> /integrations",
      "Outside tools -> /outside-tools",
      "Knowledge sources (coming)",
      "# Tools",
      "Deadlines -> /deadlines",
      "Meeting follow-ups -> /meeting-follow-ups",
      "Saved preferences -> /saved-preferences",
      "# Activity",
      "Permission checks -> /permission-checks",
      "Alerts -> /alerts",
      "# Organisation",
      "Members -> /members",
      "Brands (coming)",
      "# Installation",
      "General -> /general",
      "Quiet hours and delivery -> /quiet-hours-and-delivery",
      "Alert routing -> /alert-routing",
      "Backups -> /backups",
      "# Sam Example",
      "Your membership -> /your-membership",
      "Appearance: Color theme",
      "Sign out [button]",
    ]);
  });

  it("keeps the unread dot on Chat, and signs out by posting to the same address as before", () => {
    render(<Nav level="owner" />);
    const side = within(sidebar());
    expect(within(side.getByRole("link", { name: "Chat" })).getByTestId("unread-dot")).toBeTruthy();
    expect(side.getAllByTestId("unread-dot")).toHaveLength(1);
    const form = side.getByRole("button", { name: "Sign out" }).closest("form")!;
    expect([form.getAttribute("action"), form.getAttribute("method")]).toEqual(["/api/auth/logout", "post"]);
  });

  it("gives every entry an icon of its own", () => {
    const icons = [...OWNER_MENU.flatMap((group) => group.pages), ...COMING, MEMBERSHIP].map((entry) => entry.Icon);
    expect(new Set(icons).size).toBe(icons.length);
  });
});

describe("pages that are coming", () => {
  it("are the four agreed ones, greyed with a Coming tag", () => {
    expect(COMING.map((item) => item.label)).toEqual(["Skills", "Profiles", "Knowledge sources", "Brands"]);
    render(<Nav level="owner" />);
    for (const { label } of COMING) {
      const entry = within(sidebar()).getByText(label).closest("[data-slot=sidebar-menu-button]")!;
      expect(entry.getAttribute("aria-disabled"), label).toBe("true");
      expect(entry.textContent, label).toBe(`${label}Coming`);
    }
  });

  it("are not links or buttons, cannot take focus, and lead nowhere", () => {
    render(<Nav level="owner" />);
    for (const { label } of COMING) {
      const entry = within(sidebar()).getByText(label).closest("[data-slot=sidebar-menu-button]") as HTMLElement;
      expect(entry.tagName, label).toBe("SPAN");
      expect(entry.closest("a, button"), label).toBeNull();
      expect(entry.querySelector("a, button, [href], [tabindex], [onclick]"), label).toBeNull();
      expect(entry.hasAttribute("tabindex") || entry.hasAttribute("href"), label).toBe(false);
      expect(within(sidebar()).queryByRole("link", { name: new RegExp(label) }), label).toBeNull();
    }
  });
});

describe("an admin", () => {
  it("sees exactly the pages an admin may use: the owner's menu without Members, General and Backups", () => {
    path.current = "/";
    render(<Nav level="admin" person="Robin Example" />);
    expect(menu(sidebar())).toEqual([
      "Overview -> /",
      "Reviews -> /reviews",
      "Chat -> /chat",
      "# Agents",
      "Agents -> /agents",
      "Writing style -> /writing-style",
      "# Connections",
      "Your accounts -> /your-accounts",
      "Integrations -> /integrations",
      "Outside tools -> /outside-tools",
      "# Tools",
      "Deadlines -> /deadlines",
      "Meeting follow-ups -> /meeting-follow-ups",
      "Saved preferences -> /saved-preferences",
      "# Activity",
      "Permission checks -> /permission-checks",
      "Alerts -> /alerts",
      "# Installation",
      "Quiet hours and delivery -> /quiet-hours-and-delivery",
      "Alert routing -> /alert-routing",
      "# Robin Example",
      "Your membership -> /your-membership",
      "Appearance: Color theme",
      "Sign out [button]",
    ]);
    for (const label of ["Members", "General", "Backups"]) expect(within(sidebar()).queryByRole("link", { name: new RegExp(`^${label}$`) }), label).toBeNull();
    // The owner's message dot is the owner's: the address behind it refuses an admin.
    expect(within(sidebar()).queryByTestId("unread-dot")).toBeNull();
  });

  it("is offered every page the pages themselves let an admin open, and none they refuse", () => {
    // What each page says (derived from the code into the inventory) against what the menu offers.
    const inventory = JSON.parse(readFileSync(join(__dirname, "actions/action-inventory.json"), "utf8")) as { pages: { id: string; kind: string; see: string }[] };
    const level = new Map(inventory.pages.filter((p) => p.kind === "page").map((p) => [p.id, p.see]));
    const offered = (groups: typeof OWNER_MENU) => [...groups.flatMap((group) => group.pages), MEMBERSHIP].map((page) => page.href);
    for (const href of offered(ADMIN_MENU)) expect(["admin", "member"], `the admin menu offers ${href}`).toContain(level.get(href));
    for (const href of offered(MEMBER_MENU)) expect(level.get(href), `the member menu offers ${href}`).toBe("member");
    expect(OWNER_ONLY_PAGES.slice().sort()).toEqual([...level].filter(([, see]) => see === "owner").map(([id]) => id).sort());
    // Nothing an admin may open from the menu is left out: every owner-menu page that is not owner-only is there.
    expect(offered(ADMIN_MENU)).toEqual(offered(OWNER_MENU).filter((href) => level.get(href) !== "owner"));
    expect(OWNER_MENU.flatMap((group) => group.pages).filter((page) => level.get(page.href) === "owner").map((page) => page.label)).toEqual(["Members", "General", "Backups"]);
  });
});

describe("a member who is not the owner", () => {
  it("sees only Chat, Your accounts and Your membership, with Appearance and Sign out", () => {
    path.current = "/chat";
    render(<Nav level="member" person="Alex Example" />);
    expect(menu(sidebar())).toEqual([
      "Chat -> /chat",
      "# Connections",
      "Your accounts -> /your-accounts",
      "# Alex Example",
      "Your membership -> /your-membership",
      "Appearance: Color theme",
      "Sign out [button]",
    ]);
    expect(within(sidebar()).queryByTestId("unread-dot")).toBeNull();
  });
});

describe("the current page", () => {
  it("is exactly one entry: the one whose address is the longest match", () => {
    for (const [pathname, href] of [
      ["/", "/"],
      ["/reviews", "/reviews"],
      ["/chat/some-agent", "/chat"],
      ["/agents", "/agents"],
      ["/agents/some-agent/edit", "/agents"],
      ["/integrations", "/integrations"],
      ["/integrations/notion", "/integrations"],
      ["/outside-tools", "/outside-tools"],
      ["/outside-tools/new", "/outside-tools"],
      ["/outside-tools/abc", "/outside-tools"],
      ["/alerts", "/alerts"],
      ["/alert-routing", "/alert-routing"],
      ["/alert-routing/catalogue", "/alert-routing"],
      ["/writing-style", "/writing-style"],
      ["/meeting-follow-ups", "/meeting-follow-ups"],
      ["/quiet-hours-and-delivery", "/quiet-hours-and-delivery"],
      ["/backups", "/backups"],
      ["/general", "/general"],
      ["/your-accounts", "/your-accounts"],
      ["/your-membership", "/your-membership"],
    ] as const) {
      path.current = pathname; cleanup(); render(<Nav level="owner" />);
      expect(current(), pathname).toEqual([href]);
      expect([...sidebar().querySelectorAll("[data-active]")].map((el) => el.getAttribute("href")), pathname).toEqual([href]);
    }
  });

  it("is none of them on an address the menu does not have", () => {
    path.current = "/somewhere-else"; render(<Nav level="owner" />);
    expect(current()).toEqual([]);
  });

  it("prefers the longer address when two entries match", () => {
    const pages = [{ href: "/a", label: "A", Icon: () => null }, { href: "/a/b", label: "B", Icon: () => null }, { href: "/", label: "Home", Icon: () => null }];
    expect(currentHref("/a/b/c", pages)).toBe("/a/b");
    expect(currentHref("/a/x", pages)).toBe("/a");
    expect(currentHref("/ab", pages)).toBeNull();
    expect(currentHref("/", pages)).toBe("/");
  });
});

describe("the menu on a phone", () => {
  it("opens as a named sheet from a button that says whether it is open, closes on Escape and hands focus back", async () => {
    const user = userEvent.setup();
    render(<Nav level="owner" />);
    const button = screen.getByRole("button", { name: "Open navigation" });
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("dialog")).toBeNull();
    await user.click(button);
    const sheet = screen.getByRole("dialog", { name: "Console navigation" });
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(within(sheet).getByRole("link", { name: "Reviews" }).getAttribute("href")).toBe("/reviews");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(button);
  });

  it("closes when a page is chosen", async () => {
    const user = userEvent.setup();
    render(<Nav level="owner" />);
    await user.click(screen.getByRole("button", { name: "Open navigation" }));
    const link = within(screen.getByRole("dialog")).getByRole("link", { name: "Deadlines" });
    link.addEventListener("click", (event) => event.preventDefault());
    await user.click(link);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
