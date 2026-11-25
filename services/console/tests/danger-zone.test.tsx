// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";

const mocks = vi.hoisted(() => ({ refresh: vi.fn(), setDanger: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: mocks.refresh }) }));
vi.mock("../app/actions/outside-connect", () => ({ connectSetDanger: mocks.setDanger }));
import { DangerZone } from "../components/DangerZone";
import { DANGER_BADGE, DANGER_CHANGED_WORDS, dangerCount, whereToolsWork } from "../lib/outside-tools-words";

afterEach(() => { cleanup(); vi.clearAllMocks(); });
const use = (tools: Array<{ name: string; kind: "read" | "change"; free?: boolean; danger?: "on" | "changed" | null }>, agent = "ada") =>
  ({ agent, displayName: agent === "ada" ? "Ada" : "Ben", needsKey: true, tools: tools.map(t => ({ free: false, ...t })) });

describe("the danger zone section", () => {
  it("lists only the tools that change something, each with its own typed-name field", () => {
    render(<DangerZone slug="rates" isOwner uses={[use([{ name: "find_rate", kind: "read", free: true }, { name: "set_rate", kind: "change" }, { name: "drop_rate", kind: "change" }])]} />);
    expect(screen.getByRole("heading", { name: "Danger zone" })).toBeTruthy();
    expect(screen.queryByLabelText(/find_rate/)).toBeNull();
    expect(screen.getByLabelText("Type set_rate to confirm")).toBeTruthy();
    expect(screen.getByLabelText("Type drop_rate to confirm")).toBeTruthy();
  });
  it("keeps the switch disabled until the exact name is typed, then sends it with the typed name", async () => {
    mocks.setDanger.mockResolvedValue({ ok: true, value: { on: true } });
    render(<DangerZone slug="rates" isOwner uses={[use([{ name: "set_rate", kind: "change" }])]} />);
    const button = screen.getByRole("button", { name: /Let Ada run set_rate without asking/ }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    const field = screen.getByLabelText("Type set_rate to confirm");
    fireEvent.change(field, { target: { value: "set_rat" } }); expect(button.disabled).toBe(true);
    fireEvent.change(field, { target: { value: "Set_rate" } }); expect(button.disabled).toBe(true);
    fireEvent.change(field, { target: { value: "set_rate" } }); expect(button.disabled).toBe(false);
    fireEvent.click(button);
    await vi.waitFor(() => expect(mocks.setDanger).toHaveBeenCalledWith({ agent: "ada", name: "rates", tool: "set_rate", on: true, typedName: "set_rate" }));
    await vi.waitFor(() => expect(mocks.refresh).toHaveBeenCalled());
  });
  it("shows the keeper's refusal in its own words", async () => {
    mocks.setDanger.mockResolvedValue({ ok: false, message: "keeper: Only the installation's owner can use the danger zone.", retryable: true });
    render(<DangerZone slug="rates" isOwner uses={[use([{ name: "set_rate", kind: "change" }])]} />);
    fireEvent.change(screen.getByLabelText("Type set_rate to confirm"), { target: { value: "set_rate" } });
    fireEvent.click(screen.getByRole("button", { name: /without asking/ }));
    await screen.findByText(/Only the installation's owner/);
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
  it("shows a tool that is on with the red badge and a Switch off that needs no typing", async () => {
    mocks.setDanger.mockResolvedValue({ ok: true, value: { on: false } });
    render(<DangerZone slug="rates" isOwner uses={[use([{ name: "set_rate", kind: "change", danger: "on" }])]} />);
    expect(screen.getByText(DANGER_BADGE)).toBeTruthy();
    expect(screen.queryByLabelText(/Type set_rate/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Switch off" }));
    await vi.waitFor(() => expect(mocks.setDanger).toHaveBeenCalledWith({ agent: "ada", name: "rates", tool: "set_rate", on: false, typedName: "" }));
  });
  it("says so when a changed description switched it off, and lets it be switched on again", () => {
    render(<DangerZone slug="rates" isOwner uses={[use([{ name: "set_rate", kind: "change", danger: "changed" }])]} />);
    expect(screen.getByText(DANGER_CHANGED_WORDS)).toBeTruthy();
    expect(screen.queryByText(DANGER_BADGE)).toBeNull();
    expect(screen.getByLabelText("Type set_rate to confirm")).toBeTruthy();
  });
  it("gives anyone who is not the owner no switch at all", () => {
    render(<DangerZone slug="rates" isOwner={false} uses={[use([{ name: "set_rate", kind: "change" }])]} />);
    expect(screen.getByText(/Only the owner of this installation/)).toBeTruthy();
    expect(screen.queryByLabelText(/Type set_rate/)).toBeNull();
    expect(screen.queryByRole("button", { name: /without asking/ })).toBeNull();
  });
  it("is one tool at a time: two agents with the same tool get two separate controls, and there is no blanket switch", () => {
    render(<DangerZone slug="rates" isOwner uses={[use([{ name: "set_rate", kind: "change" }]), use([{ name: "set_rate", kind: "change" }], "ben")]} />);
    expect(screen.getAllByLabelText("Type set_rate to confirm")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: /all|every/i })).toBeNull();
  });
  it("says there is nothing to switch when no tool changes anything", () => {
    const html = renderToStaticMarkup(<DangerZone slug="rates" isOwner uses={[use([{ name: "find_rate", kind: "read" }])]} />);
    expect(html).toContain("No agent has a tool here that changes something.");
  });
});

describe("the count and the summary words", () => {
  it("counts a tool that runs without asking and changes something separately from lookups, and not one that was switched off", () => {
    const uses = [use([{ name: "find_rate", kind: "read", free: true }, { name: "set_rate", kind: "change", danger: "on" }, { name: "drop_rate", kind: "change", danger: "changed" }])];
    expect(dangerCount(uses)).toBe(1);
    expect(whereToolsWork(3, 1, 1)).toBe("Where these tools work: web chat: all 3. Slack and Telegram private chats: only tools that run without asking (2 of 3, 1 of them change something).");
    expect(whereToolsWork(3, 1)).toBe("Where these tools work: web chat: all 3. Slack and Telegram private chats: only tools that run without asking (1 of 3).");
  });
});
