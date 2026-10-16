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
import { Nav } from "../components/Nav";
afterEach(cleanup);

describe("sidebar sign out", () => {
  it("is a POST form button, not a link", () => {
    render(<Nav />);
    const button = screen.getAllByRole("button", { name: "Sign out" })[0];
    const form = button.closest("form")!;
    expect(form.getAttribute("method")).toBe("post");
    expect(form.getAttribute("action")).toBe("/api/auth/logout");
    expect(screen.queryByRole("link", { name: "Sign out" })).toBeNull();
  });
});
