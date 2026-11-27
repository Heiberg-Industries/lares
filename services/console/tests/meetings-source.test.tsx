// @vitest-environment jsdom
// Meetings, section 1: where your meeting notes come from. Paste a link, the chief of staff looks it
// up in Notion, you choose it, and the same installation setting as before is saved.
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { setMeetingsSource } from "../app/actions/definition";
import { MeetingsSourceControl } from "../components/MeetingsSourceControl";
import type { ClippingRequestView, MeetingsLookupView } from "../lib/clipping";
vi.mock("../app/actions/definition", () => ({ setMeetingsSource: vi.fn() }));
vi.mock("next/link", () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }));
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

const ID = "0123abcd-4567-4ef0-8123-456789abcdef";
const LINK = "https://www.notion.so/example/Meetings-0123abcd45674ef08123456789abcdef?v=1";
const T = "2026-11-27T10:00:00.000Z";
const view = (over: object = {}) => ({ value: null, from: "none" as const, canChange: true, chiefCount: 1, ...over });
const request = (over: Partial<ClippingRequestView> = {}): ClippingRequestView => ({
  id: "r1", kind: "meetings-database", status: "done", outcome: "ok", detail: null, createdAt: T, finishedAt: T,
  result: { databaseId: "db", dataSources: [{ id: ID, name: "Meetings" }] }, ...over,
});
const lookup = (r: ClippingRequestView | null = null): MeetingsLookupView =>
  ({ unavailable: false, request: r, busy: r?.status === "pending" || r?.status === "claimed" });
const show = (over: Partial<React.ComponentProps<typeof MeetingsSourceControl>> = {}) =>
  render(<MeetingsSourceControl view={view()} initialLookup={lookup()} notion="connected" names={{ assistant: "Ada" }} {...over} />);

it("offers the one source there is, says nothing is chosen yet, and links to Integrations for another connection", () => {
  show();
  const text = document.body.textContent ?? "";
  expect(text).toContain("Where your meeting notes come from");
  expect(text).toContain("Notion meetings database");
  expect(text).toContain("Notion is connected.");
  expect(text).toContain("No meetings database is chosen yet");
  expect(screen.getByText("Connect another in Integrations").getAttribute("href")).toBe("/integrations");
  expect(screen.getByLabelText(/Link to your meetings database/)).toBeTruthy();
});

it("when Notion is not connected, points to the Notion page and asks for no key", () => {
  show({ notion: "not-connected" });
  expect(document.body.textContent).toContain("Notion is not connected yet.");
  expect(screen.getByText("Connect Notion in Integrations").getAttribute("href")).toBe("/integrations/notion");
  expect(document.querySelector('input[type="password"]')).toBeNull();
});

it("sends the pasted link for a lookup, follows it while it waits, then offers what was found and saves its id", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(Response.json({ ok: true, view: lookup(request({ status: "pending", outcome: null, result: null, finishedAt: null })) }))
    .mockResolvedValueOnce(Response.json({ ok: true, view: lookup(request()) }));
  vi.stubGlobal("fetch", fetchMock);
  vi.mocked(setMeetingsSource).mockResolvedValue({ ok: true, result: { value: ID, restarted: ["assistant"], waiting: ["second"], stopped: [] } } as never);
  show();
  fireEvent.change(screen.getByLabelText(/Link to your meetings database/), { target: { value: LINK } });
  fireEvent.click(screen.getByRole("button", { name: "Find database" }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
  expect(fetchMock.mock.calls[0]![0]).toBe("/api/meetings/source");
  expect(JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body))).toEqual({ link: LINK });
  await waitFor(() => expect(document.body.textContent).toContain("Looking the database up in Notion."));
  expect(setMeetingsSource).not.toHaveBeenCalled(); // nothing is saved by a lookup
  await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
  await waitFor(() => expect(document.body.textContent).toContain("Found “Meetings” in Notion."));
  fireEvent.click(screen.getByRole("button", { name: "Use this database" }));
  await waitFor(() => expect(setMeetingsSource).toHaveBeenCalledWith({ dataSource: ID }));
  await waitFor(() => expect(document.body.textContent).toContain("Saved."));
  expect(document.body.textContent).toContain("Ada restarted"); // by display name
  expect(document.body.textContent).toContain("second has other changes waiting");
  expect(screen.getByTestId("meetings-source").textContent).toContain("In use: “Meetings” in Notion");
});

it("with more than one table in the database, asks which one holds the meetings", async () => {
  vi.mocked(setMeetingsSource).mockResolvedValue({ ok: true, result: { value: "ds-2", restarted: [], waiting: [], stopped: [] } } as never);
  show({ initialLookup: lookup(request({ result: { databaseId: "db", dataSources: [{ id: "ds-1", name: "Notes" }, { id: "ds-2", name: "Meetings" }] } })) });
  fireEvent.change(screen.getByLabelText(/more than one table/), { target: { value: "ds-2" } });
  fireEvent.click(screen.getByRole("button", { name: "Use this database" }));
  await waitFor(() => expect(setMeetingsSource).toHaveBeenCalledWith({ dataSource: "ds-2" }));
});

it.each([
  ["not-configured", "No agent may use Notion yet"],
  ["not-shared", "three dots, then Connections"],
  ["schema-mismatch", "That link is not a Notion database."],
  ["refused", "Notion refused the key."],
] as const)("a failed lookup (%s) says what to do in plain words", (outcome, words) => {
  show({ initialLookup: lookup(request({ status: "failed", outcome, detail: "engine sentence", result: null })) });
  expect(document.body.textContent).toContain(words);
});

it("a lookup the chief of staff never picked up says so", () => {
  show({ initialLookup: lookup(request({ status: "unavailable", outcome: null, detail: "The chief of staff did not pick this up.", result: null })) });
  expect(document.body.textContent).toContain("The chief of staff did not pick this up.");
});

it("stops reading meeting notes when asked, by saving the setting empty", async () => {
  vi.mocked(setMeetingsSource).mockResolvedValue({ ok: true, result: { value: null, restarted: [], waiting: [], stopped: [] } } as never);
  show({ view: view({ value: ID, from: "console" }) });
  fireEvent.click(screen.getByRole("button", { name: "Stop reading meeting notes" }));
  await waitFor(() => expect(setMeetingsSource).toHaveBeenCalledWith({ dataSource: "" }));
  await waitFor(() => expect(document.body.textContent).toContain("no meetings database is chosen now"));
});

it("keeps Stop reading meeting notes while a lookup found another database that was not chosen", () => {
  show({ view: view({ value: "ds-old", from: "console" }), initialLookup: lookup(request()) });
  expect(screen.getByRole("button", { name: "Use this database" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Stop reading meeting notes" })).toBeTruthy();
});

it("says when no chief of staff answers Notion requests, and links to where that is switched on", () => {
  show({ requestsOff: [{ name: "chief", displayName: "Ada" }] });
  expect(document.body.textContent).toContain("Finding a database needs the Clipping requests schedule, which is switched off for Ada.");
  expect(screen.getByText("Switch it on in Edit agent").getAttribute("href")).toBe("/agents/chief/edit");
});

it("shows the keeper's refusal word for word", async () => {
  const sentence = "Only the installation's owner can change the meetings source.";
  vi.mocked(setMeetingsSource).mockResolvedValue({ ok: false, error: { message: sentence, outcomeMayBeUnknown: false } } as never);
  show({ initialLookup: lookup(request()) });
  fireEvent.click(screen.getByRole("button", { name: "Use this database" }));
  await waitFor(() => expect(screen.getByRole("alert").querySelector(".lares-notice-body")!.textContent).toBe(sentence));
});

it("is read-only for anyone but the owner, and says when the value still comes from the installation file", () => {
  show({ view: view({ canChange: false, value: ID, from: "installation file" }), notion: "unknown" });
  expect(screen.queryByRole("button", { name: "Find database" })).toBeNull();
  expect(screen.queryByLabelText(/Link to your meetings database/)).toBeNull();
  expect(screen.getByTestId("meetings-source").textContent).toContain(ID);
  expect(document.body.textContent).toContain("installation file");
  expect(document.body.textContent).toContain("Only the installation's owner can choose the meetings source.");
});

it("says there is no chief of staff to use it when none exists, and says so when the setting cannot be read", () => {
  show({ view: view({ chiefCount: 0 }) });
  expect(document.body.textContent).toContain("No agent reads it yet");
  cleanup();
  show({ view: null });
  expect(document.body.textContent).toContain("The meetings source could not be read.");
});
