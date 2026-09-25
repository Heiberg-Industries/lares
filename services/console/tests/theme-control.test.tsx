// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeControl, useConsoleTheme } from "../components/ThemeControl";
function Fixture() {
  const theme = useConsoleTheme();
  return (
    <>
      <ThemeControl {...theme} />
      <ThemeControl {...theme} />
    </>
  );
}
afterEach(() => {
  cleanup();
  localStorage.clear();
  document.documentElement.className = "";
  vi.unstubAllGlobals();
});
it("shares persisted state across desktop and mobile theme controls", async () => {
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  localStorage.setItem("lares-console-theme", "dark");
  render(<Fixture />);
  await waitFor(() =>
    expect(document.documentElement.classList.contains("dark")).toBe(true),
  );
  expect(
    screen
      .getAllByRole("button", { name: "dark theme" })
      .every((b) => b.getAttribute("aria-pressed") === "true"),
  ).toBe(true);
  await userEvent.click(
    screen.getAllByRole("button", { name: "light theme" })[1],
  );
  expect(document.documentElement.classList.contains("dark")).toBe(false);
  expect(
    screen
      .getAllByRole("button", { name: "light theme" })
      .every((b) => b.getAttribute("aria-pressed") === "true"),
  ).toBe(true);
  expect(localStorage.getItem("lares-console-theme")).toBe("light");
});
