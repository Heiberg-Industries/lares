vi.mock("../lib/auth", () => ({ requireConsolePage: async () => ({ id: "owner-1" }) }));
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { ownerDayIn } from "../lib/proactivity";
import { TEST_CALENDAR, useTestCalendar } from "./helpers/calendar-fixture";
import type { DeadlinesView, DeadlineRowDTO, CandidateRowDTO } from "../lib/deadlines";

useTestCalendar();

// The page's own read is mocked; every pure helper (daysUntil, dueColor, standingDateLabel, the
// statutory mirror) is the real one, so this renders the actual markup an owner sees.
const { getDeadlinesView } = vi.hoisted(() => ({ getDeadlinesView: vi.fn() }));

vi.mock("../lib/db", () => ({ pool: { query: vi.fn(async () => ({ rows: [] })) } }));
vi.mock("../lib/deadlines", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/deadlines")>();
  return { ...actual, getDeadlinesView };
});

/** `YYYY-MM-DD` `offset` owner-clock days from today (Europe/Berlin, an example zone), computed
 *  the same way `daysUntil` will read it back — so the test never hard-codes a date that would go
 *  stale (or flip overdue/future) the day this test suite is run again. */
function ownerDateOffset(offsetDays: number): string {
  const todayIso = ownerDayIn(new Date(), "Europe/Berlin");
  const [y, m, d] = todayIso.split("-").map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d! + offsetDays));
  return dt.toISOString().slice(0, 10);
}

function deadline(partial: Partial<DeadlineRowDTO> & Pick<DeadlineRowDTO, "id" | "entity" | "title" | "dueDate">): DeadlineRowDTO {
  return {
    source: "manual", recurrence: "none", consequence: null, evidenceRule: "owner confirms",
    status: "open", statusReason: null, resolvedAt: null, rung: 0, ruleKey: null, createdBy: "owner@owner.example",
    vendor: null, amount: null, currency: null,
    ...partial,
  };
}

function candidate(partial: Partial<CandidateRowDTO> & Pick<CandidateRowDTO, "threadId" | "subject" | "sender">): CandidateRowDTO {
  return { seenAt: new Date("2026-09-01T09:00:00Z"), surfacedAt: null, ...partial };
}

function view(overrides: Partial<DeadlinesView> = {}): DeadlinesView {
  return {
    owner: "owner-1",
    ladderEnabled: false,
    open: [],
    candidates: [],
    closed: [],
    ...overrides,
  };
}

async function render(v: DeadlinesView): Promise<string> {
  getDeadlinesView.mockResolvedValue(v);
  const { default: DeadlinesPage } = await import("../app/deadlines/page");
  return renderToStaticMarkup(await DeadlinesPage());
}

beforeEach(() => {
  getDeadlinesView.mockReset();
  vi.resetModules();
});

describe("/deadlines", () => {
  it("shows the ladder-off note when the ladder is off", async () => {
    const html = await render(view({ ladderEnabled: false }));
    expect(html).toMatch(/OFF: the brief still lists deadlines; nothing is sent on its own/);
  });

  it("shows the ladder-on description when the ladder is on", async () => {
    const html = await render(view({ ladderEnabled: true }));
    expect(html).not.toMatch(/OFF: the brief still lists/);
    expect(html).toMatch(/escalation ladder is on/i);
  });

  // The switch LABEL states both states: a bare "Escalation ladder" beside an
  // unchecked box reads as a value that failed to render, not as a switch that is off.
  it("the ladder switch says OFF as plainly as it says ON", async () => {
    expect(await render(view({ ladderEnabled: false }))).toContain("Escalation ladder — OFF");
    expect(await render(view({ ladderEnabled: true }))).toContain("Escalation ladder — ON");
  });

  // The mint form greys the terms already behind today: the mint skips them, and a
  // form that offered them as ordinary checkboxes would promise rows it will not create.
  it("the mint form greys the statutory rules already past for the default year and says why", async () => {
    // The clock is PINNED: the default fiscal year is the current one, so which rules are behind
    // today depends on the day the suite runs — on 1 January none of them are.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-09-08T10:00:00Z"));
    try {
      const html = await render(view());
      expect(html).toContain("already past — add by hand if you still want it");
      expect(html).toMatch(/A mint adds only the terms still ahead of today/);
      // Term 3 falls 31 August 2026 — behind 8 September, so its row is greyed and its
      // checkbox disabled. term 4 falls 10 October, still ahead, so its checkbox is live.
      expect(html).toMatch(/VAT return, term 3<span[^>]*> — already past/u);
      expect(html).toMatch(/disabled=""[^>]*aria-label="Include VAT return, term 3"/u);
      expect(html).toMatch(/<input type="checkbox" aria-label="Include VAT return, term 4"/u);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a fiscal year wholly ahead greys nothing — the note is about past dates, not about minting", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-01-01T10:00:00Z"));
    try {
      const html = await render(view());
      expect(html).not.toContain("already past — add by hand if you still want it");
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders an overdue row in the bad colour and a due-soon row in the warn colour", async () => {
    const html = await render(view({
      open: [
        deadline({ id: "overdue", entity: "Example Co", title: "Overdue filing", dueDate: ownerDateOffset(-3) }),
        deadline({ id: "soon", entity: "Example Co", title: "Due tomorrow", dueDate: ownerDateOffset(1) }),
        deadline({ id: "later", entity: "Example Co", title: "Due in a month", dueDate: ownerDateOffset(30) }),
      ],
    }));
    expect(html).toContain("Overdue filing");
    expect(html).toContain("Due tomorrow");
    expect(html).toContain("Due in a month");

    // The overdue row's due-date cell is coloured bad; the due-soon row's is warn; the far-future
    // row carries neither colour on its cells.
    const overdueIdx = html.indexOf("Overdue filing");
    const soonIdx = html.indexOf("Due tomorrow");
    const laterIdx = html.indexOf("Due in a month");
    expect(html.slice(overdueIdx, overdueIdx + 400)).toMatch(/var\(--bad\)/);
    expect(html.slice(soonIdx, soonIdx + 400)).toMatch(/var\(--warn\)/);
    expect(html.slice(laterIdx, laterIdx + 400)).not.toMatch(/var\(--bad\)|var\(--warn\)/);
  });

  it("shows the mint form's confirm line and every statutory rule with a standing date", async () => {
    const html = await render(view());
    expect(html).toMatch(/Confirm each date against the authority before minting — these are the standing dates, not a feed\./);
    expect(html).toContain("Register return");
    expect(html).toContain("31 January");
    expect(html).toContain(TEST_CALENDAR.jurisdiction);
  });

  it("lists unresolved candidates with their surfaced status", async () => {
    const html = await render(view({
      candidates: [
        candidate({ threadId: "t1", subject: "Reminder: contract renewal", sender: "billing@vendor.co" }),
      ],
    }));
    expect(html).toContain("Reminder: contract renewal");
    expect(html).toContain("billing@vendor.co");
    expect(html).toMatch(/not yet surfaced/);
  });

  it("shows the closed table with status and reason", async () => {
    const html = await render(view({
      closed: [
        deadline({
          id: "d1", entity: "Example Co", title: "Filed VAT", dueDate: "2026-08-31",
          status: "done", statusReason: "Filed via Portal A", resolvedAt: new Date("2026-08-30T10:00:00Z"),
        }),
      ],
    }));
    expect(html).toContain("Filed VAT");
    expect(html).toContain("Filed via Portal A");
    expect(html).toContain("2026-08-30");
  });

  it("renders 'Nothing open' when there are no open deadlines", async () => {
    const html = await render(view());
    expect(html).toMatch(/Nothing open/);
  });

  //  — vendor/amount/currency shown in the open-row table.
  it("shows a renewal's vendor and amount in the open table, and — for a row with none", async () => {
    const html = await render(view({
      open: [
        deadline({ id: "renewal", entity: "Example Co", title: "Domain renewal", dueDate: ownerDateOffset(30), source: "renewal", vendor: "Registrar A", amount: 199, currency: "NOK" }),
        deadline({ id: "plain", entity: "Example Co", title: "One-off filing", dueDate: ownerDateOffset(30) }),
      ],
    }));
    expect(html).toContain("Registrar A, 199 NOK");
    const plainIdx = html.indexOf("One-off filing");
    const plainRow = html.slice(plainIdx, plainIdx + 600);
    // Both the Consequence cell and the Vendor/amount cell fall back to "—" for a plain row.
    expect(plainRow.match(/<td[^>]*>—<\/td>/gu)?.length).toBeGreaterThanOrEqual(2);
  });
});
