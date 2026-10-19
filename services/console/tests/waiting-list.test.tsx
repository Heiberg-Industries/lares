// @vitest-environment jsdom
// The Waiting on you page's list and detail: what is shown, which item a Telegram link opens, and
// what the owner sees after pressing a button — including "already decided elsewhere".
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { age, WaitingList } from "../components/WaitingList";
import type { DecideResult, WaitingItem } from "../lib/waiting";

afterEach(cleanup);

const NOW = Date.parse("2026-10-15T12:00:00.000Z");

function item(ref: string, over: Partial<WaitingItem> = {}): WaitingItem {
  return {
    id: `approval:${ref}`,
    kind: "approval",
    agent: "example",
    channel: "Telegram",
    createdAt: "2026-10-15T09:00:00.000Z",
    title: `Send reply ${ref}`,
    body: [
      { format: "text", label: "What the agent asks", text: `Send reply ${ref}` },
      { format: "text", label: "Everything gmail_send would be given", text: `body: ${"every word ".repeat(400)}<script>alert(1)</script>` },
    ],
    actions: [
      { id: "approve", label: "Approve", tone: "primary" },
      { id: "cancel", label: "Cancel", tone: "neutral" },
    ],
    ref,
    ...over,
  };
}

function setup(items: WaitingItem[], onDecide: (i: { id: string; actionId: string }) => Promise<DecideResult>, selectedRef?: string) {
  render(<WaitingList items={items} unreadable={[]} now={NOW} onDecide={onDecide} {...(selectedRef ? { selectedRef } : {})} />);
  return screen.getByRole("article", { name: "Selected item" });
}

it("says how long ago, plainly", () => {
  expect(age("2026-10-15T11:59:40.000Z", NOW)).toBe("just now");
  expect(age("2026-10-15T11:48:00.000Z", NOW)).toBe("12 minutes ago");
  expect(age("2026-10-15T09:00:00.000Z", NOW)).toBe("3 hours ago");
  expect(age("2026-10-12T12:00:00.000Z", NOW)).toBe("3 days ago");
  expect(age(null, NOW)).toBe("time unknown");
});

it("lists each item with kind, agent, channel and age; shows the whole body as text, never markup", () => {
  const detail = setup([item("a"), item("b", { channel: "Slack" })], vi.fn());
  const list = screen.getByRole("region", { name: "Waiting items" });
  expect(within(list).getByText("Approval · example · Telegram · 3 hours ago")).toBeTruthy();
  expect(within(list).getByText("Approval · example · Slack · 3 hours ago")).toBeTruthy();
  expect(detail.textContent).toContain("every word ".repeat(400).trim());
  expect(detail.textContent).toContain("<script>alert(1)</script>");
  expect(document.querySelector("script")).toBeNull();
});

it("a link's ?request= opens that item first", () => {
  const detail = setup([item("a"), item("b")], vi.fn(), "b");
  expect(within(detail).getByRole("heading").textContent).toBe("Send reply b");
});

it("Approve: sends the item's id and the action, then shows the result in place of the buttons", async () => {
  let resolve!: (r: DecideResult) => void;
  const onDecide = vi.fn(() => new Promise<DecideResult>((r) => (resolve = r)));
  const detail = setup([item("a")], onDecide);
  await userEvent.click(within(detail).getByRole("button", { name: "Approve" }));
  expect(onDecide).toHaveBeenCalledWith({ id: "approval:a", actionId: "approve" });
  expect(within(detail).getByText("Sending your answer…")).toBeTruthy();
  expect((within(detail).getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);
  resolve({ ok: true, outcome: "approved", message: "Approved. example is carrying on." });
  await waitFor(() => expect(within(detail).getByRole("status").textContent).toBe("Approved. example is carrying on."));
  expect(within(detail).queryByRole("button", { name: "Approve" })).toBeNull();
});

it("already decided elsewhere: says so, and offers nothing more to press", async () => {
  const onDecide = vi.fn(async (): Promise<DecideResult> => ({ ok: false, reason: "decided-elsewhere", message: "This was already approved elsewhere. Nothing more was sent." }));
  const detail = setup([item("a")], onDecide);
  await userEvent.click(within(detail).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(within(detail).getByRole("status").textContent).toContain("already approved elsewhere"));
  expect(within(detail).queryByRole("button")).toBeNull();
});

it("approved but the action failed: says so as a failure, and offers nothing more to press", async () => {
  const onDecide = vi.fn(async (): Promise<DecideResult> => ({ ok: false, reason: "action-failed", message: "Your approval arrived, but the action did not go through: refused." }));
  const detail = setup([item("a")], onDecide);
  await userEvent.click(within(detail).getByRole("button", { name: "Approve" }));
  await waitFor(() => expect(within(detail).getByRole("status").textContent).toContain("did not go through"));
  expect(within(detail).getByRole("status").className).toBe("lares-form-error");
  expect(within(detail).queryByRole("button")).toBeNull();
});

it("a failure that can be retried keeps the buttons, with the reason beside them", async () => {
  const onDecide = vi.fn(async (): Promise<DecideResult> => ({ ok: false, reason: "unavailable", message: "example did not answer. Nothing was sent; try again in a moment." }));
  const detail = setup([item("a")], onDecide);
  await userEvent.click(within(detail).getByRole("button", { name: "Approve" }));
  await waitFor(() => expect(within(detail).getByRole("alert").textContent).toContain("did not answer"));
  expect((within(detail).getByRole("button", { name: "Approve" }) as HTMLButtonElement).disabled).toBe(false);
});

it("an expired approval shows its note and only the actions it still has", () => {
  const detail = setup([item("a", { note: "This was asked more than 24 hours ago.", actions: [{ id: "cancel", label: "Cancel", tone: "neutral" }] })], vi.fn());
  expect(within(detail).getByText("This was asked more than 24 hours ago.")).toBeTruthy();
  expect(within(detail).queryByRole("button", { name: "Approve" })).toBeNull();
});

it("nothing waiting, and agents that could not be read, are said out loud, grouped by reason", () => {
  render(
    <WaitingList
      items={[]}
      unreadable={[
        { agent: "agent-a", kind: "timeout" },
        { agent: "agent-b", kind: "refused" },
        { agent: "agent-c", kind: "timeout" },
        { agent: "agent-d", kind: "unreachable" },
        { agent: "agent-e", kind: "error" },
      ]}
      now={NOW}
      onDecide={vi.fn()}
    />,
  );
  expect(screen.getByText("Nothing is waiting on you")).toBeTruthy();
  const text = screen.getAllByRole("alert").map((n) => n.textContent ?? "");
  expect(text).toHaveLength(4);
  expect(text[0]).toContain("agent-a, agent-c are waiting on: they did not answer in time");
  expect(text[1]).toContain("agent-b is waiting on: it refused the console's request");
  expect(text[2]).toContain("could not be reached");
  expect(text[3]).toContain("returned an error");
});

it("renders other body formats without interpreting them (the shape later kinds will use)", () => {
  const detail = setup(
    [
      item("a", {
        body: [
          { format: "markdown", markdown: "**Draft** [link](https://example.com)" },
          { format: "attachment", name: "photo.png", mediaType: "image/png", href: "/api/waiting/files/1" },
          { format: "attachment", name: "elsewhere.png", mediaType: "image/png", href: "https://example.com/x.png" },
        ],
      }),
    ],
    vi.fn(),
  );
  expect(detail.textContent).toContain("**Draft** [link](https://example.com)");
  expect(within(detail).getByRole("link", { name: "photo.png" }).getAttribute("href")).toBe("/api/waiting/files/1");
  expect(within(detail).queryByRole("link", { name: "elsewhere.png" })).toBeNull();
});

it("a proposal row is labelled by its own kind label, with no agent or chat named as its source of truth", () => {
  const proposal = (ref: string, kindLabel: string): WaitingItem => ({
    id: `proposal:${ref}`, kind: "proposal", kindLabel, agent: "Shared notes", channel: "Console", createdAt: "2026-10-15T09:00:00.000Z",
    title: "Update to projects/example.md", body: [{ format: "text", label: "Proposed change", text: "- a\n+ b" }],
    actions: [{ id: "approve", label: "Approve", tone: "primary" }, { id: "reject", label: "Reject", tone: "neutral" }], ref,
  });
  const detail = setup([proposal("n", "Shared notes proposal"), proposal("m", "Notion proposal")], vi.fn());
  const list = screen.getByRole("region", { name: "Waiting items" });
  expect(within(list).getByText("Shared notes proposal · Shared notes · Console · 3 hours ago")).toBeTruthy();
  expect(within(list).getByText("Notion proposal · Shared notes · Console · 3 hours ago")).toBeTruthy();
  expect(within(detail).getByRole("button", { name: "Reject" })).toBeTruthy();
  expect(document.body.textContent).not.toMatch(/atlas/i);
});

it("Reject on a proposal sends its id and the reject action", async () => {
  const onDecide = vi.fn(async (): Promise<DecideResult> => ({ ok: true, outcome: "cancelled", message: "Rejected." }));
  const detail = setup([item("p", { id: "proposal:p", kind: "proposal", actions: [{ id: "reject", label: "Reject", tone: "neutral" }] })], onDecide);
  await userEvent.click(within(detail).getByRole("button", { name: "Reject" }));
  expect(onDecide).toHaveBeenCalledWith({ id: "proposal:p", actionId: "reject" });
});
