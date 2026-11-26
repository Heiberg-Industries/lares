// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
vi.mock("next/navigation", () => ({ usePathname: () => "/" }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: React.ComponentProps<"a">) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));
vi.mock("../components/ThemeControl", () => ({
  ThemeControl: () => null,
  useConsoleTheme: () => ({ theme: "system", onChange: () => {} }),
}));
const inbox=vi.hoisted(()=>({mounted:vi.fn()}));
vi.mock('../components/InboxDot',()=>({InboxDot:()=>{inbox.mounted();return null;}}));
import { Nav } from "../components/Nav";
afterEach(cleanup);

describe("sidebar sign out", () => {
  it("is a POST form button, not a link", () => {
    render(<Nav owner={true} />);
    const button = screen.getAllByRole("button", { name: "Sign out" })[0];
    const form = button.closest("form")!;
    expect(form.getAttribute("method")).toBe("post");
    expect(form.getAttribute("action")).toBe("/api/auth/logout");
    expect(screen.queryByRole("link", { name: "Sign out" })).toBeNull();
  });
});

it('shows only private chat, your accounts and your membership to another member and never mounts owner inbox polling',()=>{
  inbox.mounted.mockClear();render(<Nav owner={false} />);
  expect(screen.getAllByRole('link',{name:'Chat'}).length).toBeGreaterThan(0);
  expect(screen.getAllByRole('link',{name:'Your membership'}).length).toBeGreaterThan(0);
  expect(screen.getAllByRole('link',{name:'Your accounts'}).length).toBeGreaterThan(0);
  expect(screen.getAllByRole('link').map(a=>a.getAttribute('href')).sort()).toEqual(['/chat','/chat','/chat','/your-accounts','/your-membership']);
  for(const name of ['Overview','Reviews','Agents','Writing style','Integrations','Outside tools','Deadlines','Meeting follow-ups','Saved preferences','Permission checks','Alerts','Members','General','Quiet hours and delivery','Alert routing','Backups'])expect(screen.queryByRole('link',{name})).toBeNull();
  expect(inbox.mounted).not.toHaveBeenCalled();
});
