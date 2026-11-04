// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setMeetingsSource } from "../app/actions/definition";
import { MeetingsSourceControl } from "../components/MeetingsSourceControl";
vi.mock("../app/actions/definition", () => ({ setMeetingsSource: vi.fn() }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const ID = "0123abcd-4567-4ef0-8123-456789abcdef";
const view = (over: object = {}) => ({ value: null, from: "none" as const, canChange: true, chiefCount: 1, ...over });

it("explains what the field is for and that saving restarts the agent", () => {
  render(<MeetingsSourceControl view={view()} />);
  const text = document.body.textContent ?? "";
  expect(text).toContain("Meetings database");
  expect(text).toContain("restarts");
  expect(text).toContain("Not set");
  expect(screen.getByLabelText(/Notion data source id/)).toHaveProperty("value", "");
});

it("saves the pasted id and says which agents were restarted and which are waiting", async () => {
  vi.mocked(setMeetingsSource).mockResolvedValue({ ok: true, result: { value: ID, restarted: ["assistant"], waiting: ["second"], stopped: [] } } as any);
  render(<MeetingsSourceControl view={view()} />);
  await userEvent.type(screen.getByLabelText(/Notion data source id/), ID.replaceAll("-", ""));
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(setMeetingsSource).toHaveBeenCalledWith({ dataSource: ID.replaceAll("-", "") }));
  await waitFor(() => expect(document.body.textContent).toContain("Saved."));
  expect(document.body.textContent).toContain("assistant restarted");
  expect(document.body.textContent).toContain("second has other changes waiting");
  expect(screen.getByLabelText(/Notion data source id/)).toHaveProperty("value", ID);
});

it("clears the source when the field is emptied", async () => {
  vi.mocked(setMeetingsSource).mockResolvedValue({ ok: true, result: { value: null, restarted: [], waiting: [], stopped: [] } } as any);
  render(<MeetingsSourceControl view={view({ value: ID, from: "console" })} />);
  await userEvent.clear(screen.getByLabelText(/Notion data source id/));
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(setMeetingsSource).toHaveBeenCalledWith({ dataSource: "" }));
  await waitFor(() => expect(document.body.textContent).toContain("cleared"));
});

it("shows the keeper's refusal word for word", async () => {
  const sentence = "That is not a Notion data source id. It is 32 letters and digits, with or without dashes.";
  vi.mocked(setMeetingsSource).mockResolvedValue({ ok: false, error: { message: sentence, outcomeMayBeUnknown: false } } as any);
  render(<MeetingsSourceControl view={view()} />);
  await userEvent.type(screen.getByLabelText(/Notion data source id/), "nonsense");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(sentence));
});

it("is read-only for anyone but the owner, and says when the value still comes from the installation file", () => {
  render(<MeetingsSourceControl view={view({ canChange: false, value: ID, from: "installation file" })} />);
  expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  expect(screen.queryByLabelText(/Notion data source id/)).toBeNull();
  expect(screen.getByTestId("meetings-source").textContent).toBe(ID);
  expect(document.body.textContent).toContain("installation file");
});

it("says there is no chief of staff to use it when none exists", () => {
  render(<MeetingsSourceControl view={view({ chiefCount: 0 })} />);
  expect(document.body.textContent).toContain("No agent reads this yet");
});
