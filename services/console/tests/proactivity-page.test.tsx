import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { effectiveSettings } from "../lib/proactivity";
import type { ProactivityView, SettingsRowDTO } from "../lib/proactivity";

// The page's own read is mocked; every pure helper (labels, the fold, the clock, the effective-value
// re-validation) is the real one, so this renders the actual markup an owner sees — the check that
// the ledger's REASONS reach the page (a suppression nobody can see is indistinguishable from an
// agent that broke) and that a stored value the engine overrides is never shown as truth.
// `vi.hoisted`, because the `vi.mock` factory below is hoisted above this file's imports.
const { getProactivityView, briefLanguageState, scheduleHoursState } = vi.hoisted(() => ({
  getProactivityView: vi.fn(),
  // Controls what the real `lib/brief-settings.ts` (not mocked — it's the module under test for
  // the notice/current-value cases below) reads back through the mocked pool.
  briefLanguageState: { row: undefined as { language: string } | undefined, fail: false },
  // Same shape, for `lib/schedule-settings.ts` (also not mocked — LAR-17-s5).
  scheduleHoursState: { rows: [] as Array<{ schedule: string; hours: number[] }>, fail: false },
}));

vi.mock("../lib/db", () => ({
  pool: {
    query: vi.fn(async (sql: string) => {
      if (/FROM brief_settings/i.test(sql)) {
        if (briefLanguageState.fail) throw new Error('relation "brief_settings" does not exist');
        return { rows: briefLanguageState.row ? [briefLanguageState.row] : [] };
      }
      if (/FROM schedule_settings/i.test(sql)) {
        if (scheduleHoursState.fail) throw new Error('relation "schedule_settings" does not exist');
        return { rows: scheduleHoursState.rows };
      }
      return { rows: [] };
    }),
  },
}));
vi.mock("../lib/proactivity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/proactivity")>();
  return { ...actual, getProactivityView };
});

const UPDATED = { updatedBy: "owner@owner.example", updatedAt: new Date("2026-09-08T10:00:00Z") };

/** A settings row with its `effective` block computed exactly as `readSettings` computes it — so a
 *  test can never assert against an effective value the real read would not have produced. */
function row(
  partial: Pick<SettingsRowDTO, "agent" | "door"> & Partial<Omit<SettingsRowDTO, "effective">>,
): SettingsRowDTO {
  const stored = {
    quietStart: partial.quietStart ?? null,
    quietEnd: partial.quietEnd ?? null,
    eventPerDoorPerDay: partial.eventPerDoorPerDay ?? null,
    escalationPerDoorPerDay: partial.escalationPerDoorPerDay ?? null,
    perOwnerPerDay: partial.perOwnerPerDay ?? null,
  };
  return {
    agent: partial.agent,
    door: partial.door,
    ...stored,
    dnd: partial.dnd === true,
    ...UPDATED,
    effective: effectiveSettings(stored),
  };
}

function view(settings: SettingsRowDTO[]): ProactivityView {
  return {
    owner: "bendik",
    clock: { tz: "America/New_York", source: "slack-profile", detail: "Slack profile, observed 2h ago", tripVisible: false },
    homeTz: "Europe/Oslo",
    settings,
    doors: ["*", "telegram:123456", "slack:U0ABC"],
    today: [
      { door: "telegram:123456", status: "sent", reason: null, count: 2 },
      { door: "telegram:123456", status: "suppressed", reason: "quiet-hours", count: 1 },
      { door: "telegram:123456", status: "deferred", reason: "door-ceiling", count: 3 },
    ],
    todayDay: "2026-09-08",
    recent: [
      {
        id: "9", decidedAt: new Date("2026-09-08T19:05:00Z"), sentAt: null, agent: "saga",
        door: "telegram:123456", cls: "event", itemKey: "email/abc", status: "deferred",
        reason: "quiet-hours", untilAt: new Date("2026-09-09T05:00:00Z"),
      },
    ],
    errors: [],
  };
}

async function render(settings: SettingsRowDTO[]): Promise<string> {
  getProactivityView.mockResolvedValue(view(settings));
  const { default: ProactivityPage } = await import("../app/proactivity/page");
  return renderToStaticMarkup(await ProactivityPage());
}

beforeEach(() => {
  getProactivityView.mockReset();
  briefLanguageState.row = undefined;
  briefLanguageState.fail = false;
  scheduleHoursState.rows = [];
  scheduleHoursState.fail = false;
  vi.resetModules();
});

describe("/proactivity", () => {
  it("renders the four sections, the owner clock, and the reasons behind today's numbers", async () => {
    const html = await render([
      row({
        agent: "*", door: "*", quietStart: "22:00", quietEnd: "08:00",
        eventPerDoorPerDay: 4, escalationPerDoorPerDay: 1, perOwnerPerDay: 9,
      }),
      row({ agent: "marcel", door: "*", dnd: true }),
    ]);

    // The knobs, in the brief's order.
    expect(html).toContain("Do not disturb");
    expect(html).toContain("Quiet hours");
    expect(html).toContain("Ceilings");
    expect(html).toContain("Today");
    expect(html).toContain("Last 50 decisions");
    expect(html).toContain("(1 recorded)");

    // The owner clock, its source, and the honest note about the trip source.
    expect(html).toContain("America/New_York");
    expect(html).toContain("slack-profile");
    expect(html).toMatch(/visible on the box/);
    expect(html).toContain("OWNER_HOME_TZ");

    // Stored values are the shown values; the engine maxima are printed beside the ceilings.
    expect(html).toContain('value="22:00"');
    expect(html).toContain('value="4"');
    expect(html).toContain("engine max 20");
    expect(html).toContain("engine max 3");
    expect(html).toContain("engine max 30");
    // Nothing disagrees with the engine, so nothing is annotated.
    expect(html).not.toContain("the engine uses");

    // Per-agent DND: Marcel's row is on.
    expect(html).toMatch(/marcel — ON/);

    // Doors are offered by their real ids (the gate matches the door id exactly).
    expect(html).toContain("Telegram · 123456");
    expect(html).toContain("Slack · U0ABC");

    // Today, with reasons in words — and the ledger row's time on the OWNER's clock (15:05 in
    // New York, not 21:05 in Oslo and not 19:05 UTC).
    expect(html).toContain("inside quiet hours");
    expect(html).toContain("this door&#x27;s daily ceiling was full");
    expect(html).toContain("2026-09-08 15:05");
    expect(html).toContain("email/abc");
  });

  it("a hand-written ceiling above the engine max renders the EFFECTIVE number and names the stored one", async () => {
    // The console refuses 50 on write, but the runbook's own escape hatch is hand SQL — and the kit
    // clamps 50 to 20 on every read. A page printing 50 would be the most confident liar here.
    const html = await render([
      row({ agent: "*", door: "*", eventPerDoorPerDay: 50, escalationPerDoorPerDay: 3, perOwnerPerDay: 15 }),
    ]);

    expect(html).toContain('value="20"');
    expect(html).not.toContain('value="50"');
    expect(html).toContain("stored 50 — the engine uses 20");
  });

  it("renders a space between OWNER_HOME_TZ and 'on the box' (Bendik's reported leftover)", async () => {
    // Reported as rendering "OWNER_HOME_TZon the box" with no space. Asserted directly on the
    // rendered markup rather than the JSX source, because a JSX whitespace bug is exactly the kind
    // of thing that looks fine in the editor and wrong in the browser.
    const html = await render([]);
    expect(html).toContain("OWNER_HOME_TZ</span> on the box");
  });

  it("a hand-written quiet window under the floor renders the ENGINE window and names the stored one", async () => {
    const html = await render([
      row({ agent: "*", door: "telegram:123456", quietStart: "05:00", quietEnd: "06:00" }),
    ]);

    expect(html).toContain('value="21:00"');
    expect(html).toContain('value="07:00"');
    expect(html).not.toContain('value="05:00"');
    expect(html).not.toContain('value="06:00"');
    expect(html).toContain("stored 05:00–06:00 is 1.0 h — the engine uses 21:00–07:00");
  });
});

// LAR-16-s3 — the brief language control, next to the home-timezone line.
describe("/proactivity — brief language control", () => {
  it("shows the current value and offers all five languages", async () => {
    briefLanguageState.row = { language: "sv" };
    const html = await render([]);

    expect(html).toContain("Brief language");
    // All five codes offered, in the mirror's order.
    expect(html).toContain('<option value="en">English — default</option>');
    expect(html).toContain('<option value="nb">Norsk bokmål</option>');
    expect(html).toContain('Svenska</option>');
    expect(html).toContain('<option value="da">Dansk</option>');
    expect(html).toContain('<option value="fi">Suomi</option>');
    // The stored value ("sv") is the one actually selected.
    expect(html).toMatch(/<option value="sv"[^>]*selected/);

    // The plain-language "takes effect from the next brief" sentence.
    expect(html).toMatch(/next brief/);
  });

  it("defaults to English when no row exists", async () => {
    const html = await render([]);
    expect(html).toMatch(/<option value="en"[^>]*selected/);
  });

  it("shows the missing-table notice instead of the control when brief_settings cannot be read", async () => {
    briefLanguageState.fail = true;
    const html = await render([]);

    expect(html).toContain("sql/050_brief_settings.sql");
    expect(html).not.toContain("<select");
  });
});

// LAR-17-s5 — "when do the agents speak", after Quiet hours.
describe("/proactivity — when the agents speak", () => {
  it("renders after Quiet hours, states the owner's clock, the five-minute/next-slot rule, and the no-second-send rule", async () => {
    const html = await render([]);

    expect(html).toContain("When the agents speak");
    expect(html.indexOf("Quiet hours")).toBeLessThan(html.indexOf("When the agents speak"));
    expect(html.indexOf("When the agents speak")).toBeLessThan(html.indexOf("Ceilings"));

    // The owner's clock (this view's is America/New_York).
    expect(html).toMatch(/When the agents speak[\s\S]*America\/New_York/);
    // Takes effect within about five minutes, from the next slot.
    expect(html).toMatch(/within about five minutes/);
    expect(html).toMatch(/next slot/);
    // Moving an hour after today's brief already sent does not send a second one.
    expect(html).toMatch(/does not send a second one/);
  });

  // The schedule-hours section only — "· default" also marks a door's quiet-hours row when
  // nothing is stored for it, so counting over the WHOLE page would count someone else's markers.
  const scheduleSection = (html: string): string =>
    html.slice(html.indexOf("When the agents speak"), html.indexOf("Ceilings"));

  it("shows the five owner-facing schedules with their default hours, marked as defaults", async () => {
    const html = await render([]);
    const section = scheduleSection(html);

    expect(section).toContain("Morning brief");
    expect(section).toContain("Evening brief");
    expect(section).toContain("Digest");
    expect(section).toContain("CRM routing");
    expect(section).toContain("Weekly summary");
    // dream and voice-learn are internal night jobs — never offered here.
    expect(section).not.toMatch(/\bdream\b/i);
    expect(section).not.toMatch(/voice-learn/i);

    // Every row marked "· default" when no row is stored, and pre-filled with the engine default.
    expect((section.match(/· default/g) ?? []).length).toBe(5);
    expect(section).toContain('value="8"'); // morning-brief
    expect(section).toContain('value="20"'); // evening-brief
    expect(section).toContain('value="9, 17"'); // digest
    expect(section).toContain('value="9, 13, 17"'); // crm-routing
  });

  it("a stored hour overrides the default and drops the default marker for that row only", async () => {
    scheduleHoursState.rows = [{ schedule: "morning-brief", hours: [7] }];
    const html = await render([]);
    const section = scheduleSection(html);

    expect(section).toContain('value="7"');
    expect((section.match(/· default/g) ?? []).length).toBe(4); // every OTHER schedule still default
  });

  it("shows the missing-table notice instead of the control when schedule_settings cannot be read", async () => {
    scheduleHoursState.fail = true;
    const html = await render([]);

    expect(html).toContain("sql/065_schedule_settings.sql");
    expect(html).not.toContain('aria-label="Morning brief hour"');
  });
});
