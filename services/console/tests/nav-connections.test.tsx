// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
const path = vi.hoisted(() => ({ current: "/" }));
vi.mock("next/navigation", () => ({ usePathname: () => path.current }));
vi.mock("next/link", () => ({ default: ({ href, children, ...p }: React.ComponentProps<"a">) => <a href={href} {...p}>{children}</a> }));
vi.mock("../components/ThemeControl", () => ({ ThemeControl: () => null, useConsoleTheme: () => ({ theme: "system", onChange: () => {} }) }));
vi.mock("../components/InboxDot", () => ({ InboxDot: () => null }));
import { Nav } from "../components/Nav";
afterEach(cleanup);
const current = () => screen.getAllByRole("link").filter(a => a.getAttribute("aria-current") === "page").map(a => a.textContent);

it("shows the owner a Connections group with both pages between Activity and Members", () => {
  render(<Nav owner={true} />);
  const side = screen.getAllByRole("navigation")[0];
  const text = [...side.querySelectorAll("a, p")].map(e => e.textContent);
  expect(text.slice(text.indexOf("Activity"), text.indexOf("Members") + 1)).toEqual(["Activity", "Connections", "Your accounts", "Integrations", "Members"]);
  expect(side.querySelector('a[href="/accounts"]')).toBeTruthy();
  expect(side.querySelector('a[href="/integrations"]')).toBeTruthy();
});

it("shows a member who is not the owner Your accounts and Membership, and no Integrations", () => {
  render(<Nav owner={false} />);
  expect(screen.getAllByRole("link", { name: "Your accounts" }).length).toBeGreaterThan(0);
  expect(screen.getAllByRole("link", { name: "Membership" }).length).toBeGreaterThan(0);
  expect(screen.queryByRole("link", { name: "Integrations" })).toBeNull();
});

it("marks the right page current, including an integration page and the pages that sit under Integrations", () => {
  for (const [pathname, label] of [["/accounts", "Your accounts"], ["/integrations", "Integrations"], ["/integrations/notion", "Integrations"], ["/voice", "Integrations"], ["/meetings", "Integrations"]]) {
    path.current = pathname; cleanup(); render(<Nav owner={true} />);
    expect([...new Set(current())], pathname).toEqual([label]);
  }
});
