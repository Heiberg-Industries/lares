// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
const { save } = vi.hoisted(() => ({ save: vi.fn() }));
vi.mock("../app/actions/autonomy", () => ({ setAutonomy: save }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: React.ComponentProps<"a">) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));
import { AutonomyControl } from "../components/AutonomyControl";
import { AgentsList } from "../components/AgentsList";
import type { FleetSnapshot } from "../lib/console-overview";
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
describe("permission changes", () => {
  it("prevents competing writes and waits for the server before selecting", async () => {
    let done!: () => void;
    save.mockReturnValue(
      new Promise<void>((r) => {
        done = r;
      }),
    );
    render(
      <AutonomyControl
        agent="sage"
        capability="vault"
        action="private"
        level="gated"
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Allow" }));
    expect(
      (screen.getByRole("button", { name: "Never" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      screen
        .getByRole("button", { name: "Ask first" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(save).toHaveBeenCalledWith({
      agent: "sage",
      capability: "vault",
      action: "private",
      level: "autonomous",
    });
    done();
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: "Allow" })
          .getAttribute("aria-pressed"),
      ).toBe("true"),
    );
  });
  it("requires authoritative reload after an unknown write outcome", async () => {
    save.mockRejectedValue(new Error("connection lost"));
    render(<AutonomyControl agent="sage" capability="mail" level="gated" />);
    await userEvent.click(screen.getByRole("button", { name: "Never" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Reload");
    expect(
      (screen.getByRole("button", { name: "Allow" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
});
describe("agent discovery", () => {
  const snapshot: FleetSnapshot = {
    agents: {
      available: true,
      value: [
        {
          name: "sage",
          displayName: "Sage",
          role: "Chief of Staff",
          grants: Array.from({ length: 23 }, (_, i) => ({
            capability: `capability-${i}`,
            scope: "read" as const,
          })),
          autonomy: {},
          skills: [],
          doors: [],
          tools: null,
          startedAt: "2026-09-25T10:00:00Z",
        },
      ],
    },
    workflows: { available: true, value: [] },
  };
  it("keeps all 23 capabilities available and searches display names and roles", async () => {
    render(<AgentsList snapshot={snapshot} />);
    await userEvent.click(screen.getByText("23 capabilities"));
    expect(screen.getByText("capability-22")).toBeTruthy();
    await userEvent.type(screen.getByRole("searchbox"), "travel");
    expect(screen.getByText("No agents found")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(screen.getByRole("link", { name: "Sage" })).toBeTruthy();
  });
  it("does not offer an empty-fleet explanation for a read failure", () => {
    render(
      <AgentsList
        snapshot={{
          agents: { available: false },
          workflows: { available: false },
        }}
      />,
    );
    expect(screen.getByRole("alert").textContent).toContain("unavailable");
    expect(screen.queryByText("No agents registered yet")).toBeNull();
  });
});
