// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
vi.mock("next/link", () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }));
vi.mock("../app/actions/definition", () => ({ acceptOutsideDescriptions: vi.fn() }));
vi.mock("../app/actions/autonomy", () => ({ setAutonomy: vi.fn() }));
vi.mock("../app/actions/delivery", () => ({ saveDelivery: vi.fn() }));
import { AgentDetail } from "../components/AgentDetail";
import type { AgentFolder } from "../lib/agents";

afterEach(cleanup);
const agent = { name: "helper", displayName: "Helper", role: "assistant", skills: [], doors: [], grants: [], startedAt: "2026-10-01T06:00:00Z" } as unknown as AgentFolder;

describe("agent page", () => {
  it("keeps who may use the agent on the Access tab, not under every tab", async () => {
    render(<AgentDetail agent={agent} board={{ available: true, value: [] }} events={{ available: false }} schedules={{ available: true, value: [] }} accessSettings={<section>Sharing settings</section>} />);
    expect(screen.queryByText("Sharing settings")).toBeNull();
    await userEvent.click(screen.getByRole("tab", { name: "Access" }));
    expect(screen.getByText("Sharing settings")).toBeTruthy();
    await userEvent.click(screen.getByRole("tab", { name: "Schedules" }));
    expect(screen.queryByText("Sharing settings")).toBeNull();
  });
});
