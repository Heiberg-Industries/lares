// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setAgentSetting } from "../app/actions/definition";
import { AgentSettingsSections } from "../components/AgentSettingsControl";
import type { AgentSettingView } from "../lib/agent-settings";
vi.mock("../app/actions/definition", () => ({ setAgentSetting: vi.fn() }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const row = (over: Partial<AgentSettingView> = {}): AgentSettingView => ({
  key: "TELEGRAM_BOT_USERNAME", section: "Telegram", label: "Telegram bot username", description: "The bot the agent answers as.",
  value: null, from: "none", agentCount: 1, ...over,
});

it("shows one block per section with the label, help text and where the value comes from", () => {
  render(<AgentSettingsSections canChange settings={[
    row(),
    row({ key: "LARES_ARTICLE_AREA", section: "Digest", label: "Where saved articles are filed", value: "shared", from: "installation file" }),
    row({ key: "DIGEST_SLACK_TARGET", section: "Digest", label: "Slack target for the digest", value: "U0123ABCD", from: "console" }),
  ]} />);
  expect(screen.getAllByRole("heading").map(h => h.textContent)).toEqual(["Telegram", "Digest"]);
  const text = document.body.textContent ?? "";
  expect(text).toContain("The bot the agent answers as.");
  expect(text).toContain("Not set.");
  expect(text).toContain("Still comes from the installation file");
  expect(text).toContain("Saved in the console.");
  expect(text).toContain("restarts");
  expect(screen.getByLabelText(/Where saved articles are filed/)).toHaveProperty("value", "shared");
});

it("saves the typed value under its key and says which agents were restarted and which are waiting", async () => {
  vi.mocked(setAgentSetting).mockResolvedValue({ ok: true, result: { key: "TELEGRAM_BOT_USERNAME", value: "example_bot", restarted: ["assistant"], waiting: ["second"], stopped: [] } } as any);
  render(<AgentSettingsSections canChange settings={[row()]} />);
  await userEvent.type(screen.getByLabelText(/Telegram bot username/), "example_bot");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(setAgentSetting).toHaveBeenCalledWith({ key: "TELEGRAM_BOT_USERNAME", value: "example_bot" }));
  await waitFor(() => expect(document.body.textContent).toContain("Saved."));
  expect(document.body.textContent).toContain("assistant restarted");
  expect(document.body.textContent).toContain("second has other changes waiting");
  expect(document.body.textContent).toContain("Saved in the console.");
});

it("clears the setting when the field is emptied", async () => {
  vi.mocked(setAgentSetting).mockResolvedValue({ ok: true, result: { key: "TELEGRAM_BOT_USERNAME", value: null, restarted: [], waiting: [], stopped: [] } } as any);
  render(<AgentSettingsSections canChange settings={[row({ value: "example_bot", from: "console" })]} />);
  await userEvent.clear(screen.getByLabelText(/Telegram bot username/));
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(setAgentSetting).toHaveBeenCalledWith({ key: "TELEGRAM_BOT_USERNAME", value: "" }));
  await waitFor(() => expect(document.body.textContent).toContain("cleared"));
});

it("shows the keeper's refusal word for word", async () => {
  const sentence = "Telegram bot username: That is not a bot username.";
  vi.mocked(setAgentSetting).mockResolvedValue({ ok: false, error: { message: sentence, outcomeMayBeUnknown: false } } as any);
  render(<AgentSettingsSections canChange settings={[row()]} />);
  await userEvent.type(screen.getByLabelText(/Telegram bot username/), "x");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(sentence));
});

it("is read-only for anyone but the owner", () => {
  render(<AgentSettingsSections canChange={false} settings={[row({ value: "example_bot", from: "console" })]} />);
  expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  expect(screen.queryByLabelText(/Telegram bot username/)).toBeNull();
  expect(screen.getByTestId("setting-TELEGRAM_BOT_USERNAME").textContent).toBe("example_bot");
  expect(document.body.textContent).toContain("Ask the installation owner");
});

it("says so when no agent reads the setting yet", () => {
  render(<AgentSettingsSections canChange settings={[row({ agentCount: 0 })]} />);
  expect(document.body.textContent).toContain("No agent reads this yet");
});
