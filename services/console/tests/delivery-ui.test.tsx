// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, act } from "@testing-library/react";

const mocks = vi.hoisted(() => ({ save: vi.fn(), markRead: vi.fn() }));
vi.mock("../app/actions/delivery", () => ({ saveDelivery: mocks.save }));
vi.mock("../app/actions/inbox", () => ({ markRead: mocks.markRead }));

import { DeliveryGrid } from "../components/DeliveryGrid";
import { InboxPanel } from "../components/InboxPanel";
import { InboxDot } from "../components/InboxDot";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.save.mockResolvedValue({ ok: true });
  mocks.markRead.mockResolvedValue({ ok: true });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

const select = (label: string) => screen.getByLabelText(label) as HTMLSelectElement;

describe("DeliveryGrid", () => {
  const props = { agent: "chief", connected: { slack: false, telegram: true } };

  it("is pre-filled with today's behaviour when nothing is saved, and says so", () => {
    render(<DeliveryGrid {...props} delivery={undefined} />);
    expect(select("Morning brief via Telegram").value).toBe("1");
    expect(select("Morning brief via Slack").value).toBe("0");
    expect(select("Email triage via Slack").value).toBe("1");
    expect(screen.getAllByText(/· today/).length).toBe(12);
    expect(screen.getByText("Slack (not connected)")).toBeTruthy();
    expect(screen.queryByText("Telegram (not connected)")).toBeNull();
  });

  it("shows saved choices as they are saved", () => {
    render(<DeliveryGrid {...props} delivery={Object.fromEntries(["morning-brief", "evening-brief", "weekly-summary", "reping", "deadlines", "proposals-watch", "email-triage", "meeting-followup", "outreach-reply-watch", "crm-routing", "digest", "reminders"].map((k) => [k, ["web", "telegram"]]))} />);
    expect(select("Morning brief via web chat").value).toBe("1");
    expect(select("Morning brief via Telegram").value).toBe("2");
    expect(screen.queryByText(/· today/)).toBeNull();
  });

  it("saves every row, in the order numbered", async () => {
    render(<DeliveryGrid {...props} delivery={undefined} />);
    fireEvent.change(select("Morning brief via web chat"), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1));
    const { name, delivery } = mocks.save.mock.calls[0]![0];
    expect(name).toBe("chief");
    expect(delivery["morning-brief"]).toEqual(["telegram", "web"]);
    expect(delivery["email-triage"]).toEqual(["slack"]);
    expect(Object.keys(delivery)).toHaveLength(12);
    await screen.findByText(/Saved\./);
  });

  it("will not save a row with no first door, and says which", () => {
    render(<DeliveryGrid {...props} delivery={undefined} />);
    fireEvent.change(select("Digest via Slack"), { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(mocks.save).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toBe("Digest: pick a first door.");
  });

  it("shows the refusal sentence from the save", async () => {
    mocks.save.mockResolvedValue({ ok: false, message: "Morning brief is set for 06:00, but it goes to Telegram and ..." });
    render(<DeliveryGrid {...props} delivery={undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText(/Morning brief is set for 06:00/);
  });

  it("shows the note when a kind's last message went somewhere else", () => {
    render(<DeliveryGrid {...props} delivery={undefined} notes={{ "morning-brief": "Morning brief went to web chat: Telegram is not connected" }} />);
    expect(screen.getByText("Morning brief went to web chat: Telegram is not connected")).toBeTruthy();
  });
});

const message = (id: number, over: Record<string, unknown> = {}) => ({
  id, agent: "chief", kind: "morning-brief", title: "Morning brief", body: `Body ${id}`, context: null,
  createdAt: "2026-10-17T06:00:00.000Z", read: false, ...over,
});

describe("InboxPanel", () => {
  it("lists unread messages with a Reply that opens a chat on that message", () => {
    render(<InboxPanel agent="chief" initial={[message(7)]} />);
    expect(screen.getByText("1 message for you")).toBeTruthy();
    expect(screen.getByText("Body 7")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Reply" }).getAttribute("href")).toBe("/chat/chief?reply=7");
  });

  it("renders nothing when there is nothing to show", () => {
    const { container } = render(<InboxPanel agent="chief" initial={[]} />);
    expect(container.innerHTML).toBe("");
  });

  it("marks one message read and looks again", async () => {
    const fetchMock = vi.fn(async () => Response.json({ unread: 0, messages: [] }));
    vi.stubGlobal("fetch", fetchMock);
    render(<InboxPanel agent="chief" initial={[message(7)]} />);
    fireEvent.click(screen.getByRole("button", { name: "Mark as read" }));
    await waitFor(() => expect(mocks.markRead).toHaveBeenCalledWith({ agent: "chief", id: 7 }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/inbox?agent=chief", { cache: "no-store" }));
  });

  it("looks again every half minute while the page is visible, and not while hidden", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => Response.json({ unread: 1, messages: [message(8)] }));
    vi.stubGlobal("fetch", fetchMock);
    render(<InboxPanel agent="chief" initial={[message(7)]} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Body 8")).toBeTruthy();

    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  });
});

describe("InboxDot", () => {
  it("shows a dot only when something is unread", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ unread: 2 })));
    render(<InboxDot />);
    await screen.findByRole("status");
    expect(screen.getByRole("status").getAttribute("aria-label")).toBe("2 unread messages in web chat");
  });

  it("shows nothing for zero, and nothing when the answer cannot be had", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ unread: 0 })));
    const { container, unmount } = render(<InboxDot />);
    await act(async () => {});
    expect(container.innerHTML).toBe("");
    unmount();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    const second = render(<InboxDot />);
    await act(async () => {});
    expect(second.container.innerHTML).toBe("");
  });
});
