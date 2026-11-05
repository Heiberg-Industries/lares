// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { acceptNotionSyncPreview, runNotionSyncPreview, setNotionSync } from "../app/actions/definition";
import { NotionSyncControl } from "../components/NotionSyncControl";
import type { NotionSyncView } from "../lib/notion-sync";
vi.mock("../app/actions/definition", () => ({ setNotionSync: vi.fn(), runNotionSyncPreview: vi.fn(), acceptNotionSyncPreview: vi.fn() }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const HASH = "a".repeat(64);
const counts = { create: 1, adoptPatch: 2, skip: 3, conflict: 4 };
const view = (over: Partial<NotionSyncView> = {}): NotionSyncView => ({
  canChange: true, enabled: false, meetingsDataSource: null, peopleDataSource: null, passes: [], problems: [], keyApplied: true, hash: null,
  preview: null, accepted: false, running: "not-created", lastRun: null, phase: "off", ...over,
});
const on = (over: Partial<NotionSyncView> = {}) => view({ enabled: true, passes: ["attendees", "people"], hash: HASH, phase: "needs-preview", ...over });

it("says it is off, that nothing runs before a preview is accepted, and when it last ran", () => {
  render(<NotionSyncControl initial={view()} />);
  expect(screen.getByTestId("sync-status").textContent).toBe("Off.");
  expect(screen.getByTestId("sync-last-run").textContent).toContain("never");
  expect(document.body.textContent).toContain("accept a preview");
  expect(screen.getByRole("button", { name: "Switch on" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Accept and start" })).toBeNull();
});

it("switching on sends the people database as typed and then offers a preview, not a start", async () => {
  vi.mocked(setNotionSync).mockResolvedValue({ ok: true, result: on({ peopleDataSource: "p1" }) } as any);
  render(<NotionSyncControl initial={view()} />);
  await userEvent.type(screen.getByLabelText(/People database id/), "p1");
  await userEvent.click(screen.getByRole("button", { name: "Switch on" }));
  await waitFor(() => expect(setNotionSync).toHaveBeenCalledWith({ enabled: true, peopleDataSource: "p1" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Run preview" })).toBeTruthy());
  expect(screen.queryByRole("button", { name: "Accept and start" })).toBeNull();
});

it("shows what the preview would do in plain words, and only then offers to accept that exact preview", async () => {
  vi.mocked(runNotionSyncPreview).mockResolvedValue({ ok: true, result: on({ phase: "ready-to-accept", preview: { at: "2026-01-02T03:04:05Z", current: true, passes: { attendees: counts, people: { ...counts, create: 0 } } } }) } as any);
  vi.mocked(acceptNotionSyncPreview).mockResolvedValue({ ok: true, result: on({ phase: "on", accepted: true, running: "running" }) } as any);
  render(<NotionSyncControl initial={on()} />);
  await userEvent.click(screen.getByRole("button", { name: "Run preview" }));
  await waitFor(() => expect(screen.getByTestId("sync-preview")).toBeTruthy());
  expect(screen.getByTestId("sync-preview").textContent).toContain("Meeting attendees: 1 new, 2 to update, 3 left alone, 4 that need a look");
  expect(screen.getByTestId("sync-preview").textContent).toContain("People records: 0 new");
  await userEvent.click(screen.getByRole("button", { name: "Accept and start" }));
  await waitFor(() => expect(acceptNotionSyncPreview).toHaveBeenCalledWith({ hash: HASH }));
  await waitFor(() => expect(screen.getByTestId("sync-status").textContent).toContain("On. It runs once an hour."));
});

it("marks a preview made for older settings as out of date and does not offer to accept it", () => {
  render(<NotionSyncControl initial={on({ preview: { at: "2026-01-02T03:04:05Z", current: false, passes: { attendees: counts } } })} />);
  expect(screen.getByTestId("sync-preview").textContent).toContain("Out-of-date preview");
  expect(screen.queryByRole("button", { name: "Accept and start" })).toBeNull();
});

it("lists, in plain words, what is missing, and says to connect the key first", () => {
  render(<NotionSyncControl initial={view({ enabled: true, phase: "needs-setup", problems: ["Choose the Notion meetings database first (under Notion, above)."] })} />);
  expect(screen.getByTestId("sync-problems").textContent).toContain("meetings database");
  cleanup();
  render(<NotionSyncControl initial={on({ phase: "needs-key", keyApplied: false })} />);
  expect(screen.getByTestId("sync-status").textContent).toContain("Connect the Notion key first");
  expect(screen.queryByRole("button", { name: "Run preview" })).toBeNull();
});

it("shows the keeper's refusal word for word, and is read-only for anyone but the owner", async () => {
  const refusal = "The preview did not finish. Check the Notion key and the connections, then try again.";
  vi.mocked(runNotionSyncPreview).mockResolvedValue({ ok: false, error: { message: refusal, outcomeMayBeUnknown: false } } as any);
  render(<NotionSyncControl initial={on()} />);
  await userEvent.click(screen.getByRole("button", { name: "Run preview" }));
  await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(refusal));
  cleanup();
  render(<NotionSyncControl initial={on({ canChange: false })} />);
  expect(screen.queryByRole("button")).toBeNull();
  expect(screen.queryByLabelText(/People database id/)).toBeNull();
});
