// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setAgentLimit } from "../app/actions/definition";
import { AgentLimitControl } from "../components/AgentLimitControl";
vi.mock("../app/actions/definition", () => ({ setAgentLimit: vi.fn() }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const GIB = 1024 ** 3;
const cap = (over: object = {}) => ({ ceiling: 2, activeCount: 1, approved: true, creationAvailable: true, serverMemoryBytes: 8 * GIB, suggestedMax: 2, canChange: true, ...over });

it("shows the current number and labels the memory figures as estimates", () => {
  render(<AgentLimitControl capacity={cap()} />);
  const text = document.body.textContent ?? "";
  expect(text).toContain("up to 2 agents");
  expect(text).toContain("8 GiB");
  expect(text).toContain("1.5 GiB");
  expect(text).toContain("estimates");
  expect(screen.getByLabelText(/New limit/)).toHaveProperty("value", "2");
});

it("warns above the suggested maximum but still lets the administrator save", async () => {
  vi.mocked(setAgentLimit).mockResolvedValue({ ok: true, result: cap({ ceiling: 5 }) } as any);
  render(<AgentLimitControl capacity={cap()} />);
  expect(screen.queryByRole("alert")).toBeNull();
  const input = screen.getByLabelText(/New limit/);
  await userEvent.clear(input);
  await userEvent.type(input, "5");
  expect(screen.getByRole("alert").textContent).toContain("more than the estimate");
  const save = screen.getByRole("button", { name: "Save" });
  expect((save as HTMLButtonElement).disabled).toBe(false);
  await userEvent.click(save);
  await waitFor(() => expect(setAgentLimit).toHaveBeenCalledWith({ ceiling: 5 }));
  await waitFor(() => expect(document.body.textContent).toContain("Saved. The limit is now 5."));
});

it("is read-only when the viewer cannot change it", () => {
  render(<AgentLimitControl capacity={cap({ canChange: false })} />);
  expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  expect(screen.queryByLabelText(/New limit/)).toBeNull();
  expect(screen.getByTestId("agent-limit").textContent).toBe("2");
});

it("is read-only with no memory line when an older keeper sends no new fields", () => {
  render(<AgentLimitControl capacity={{ ceiling: 3, activeCount: 1, approved: true, creationAvailable: true }} />);
  expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  expect(screen.getByTestId("agent-limit").textContent).toBe("3");
  expect(document.body.textContent).not.toContain("GiB");
});

it("shows the keeper's refusal word for word", async () => {
  const sentence = "You have 2 agents. Retire one before lowering the limit below 2.";
  vi.mocked(setAgentLimit).mockResolvedValue({ ok: false, error: { message: sentence, outcomeMayBeUnknown: false } } as any);
  render(<AgentLimitControl capacity={cap({ ceiling: 3, activeCount: 2 })} />);
  const input = screen.getByLabelText(/New limit/);
  await userEvent.clear(input);
  await userEvent.type(input, "1");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(sentence));
});
