import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * The Writing style page's Re-learn button and its status line, rendered from the database rows the
 * page really reads. Only the pool is faked, answered per query, so the real `lib/voice.ts` decides.
 *
 * THE BUG THIS PINS. The button used to be given the shared `default` card's learn status. No run
 * writes there: the schedule writes the status on the MAILBOX's own row (`setStatusFor(mailbox, …)`)
 * and now also records the job's outcome. So a running learn looked idle, and a failed one looked fine.
 */
vi.mock("../lib/auth", () => ({ requirePage: async () => ({ id: "owner-1" }), actingAddress: async () => "owner@owner.example" }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

type Row = Record<string, unknown>;
const db = vi.hoisted(() => ({
  cards: [] as Row[],
  requestedAt: null as Date | null,
  /** Outcome records, one per agent (`<agent>/voice-learn`); any other key too, to prove it is ignored. */
  runs: [] as Row[],
  agents: [] as Row[],
  /** What went through the one connection the page takes. */
  onConnection: [] as string[],
}));
vi.mock("../lib/db", () => {
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    if (/FROM schedule_run/.test(sql)) {
      const keys = (params?.[0] ?? []) as string[];
      return { rows: db.runs.filter((r) => keys.includes(String(r.job))) };
    }
    if (/SELECT relearn_requested_at FROM voice_profile/.test(sql)) return { rows: [{ relearn_requested_at: db.requestedAt }] };
    if (/FROM voice_profile/.test(sql)) return { rows: db.cards };
    if (/FROM agent_definitions/.test(sql)) {
      // The page's own filter on the keeper's status column, applied to the fake rows.
      const keep = /status <> 'retired'/.test(sql) ? (s: unknown) => s !== "retired" : /status = 'valid'/.test(sql) ? (s: unknown) => s === "valid" : () => true;
      return { rows: db.agents.filter((a) => keep(a.status ?? "valid")) };
    }
    return { rows: [] };
  });
  // The request and the outcome are read on one connection, in one read-only transaction.
  const onConnection = async (sql: string, params?: unknown[]) => { db.onConnection.push(sql); return query(sql, params); };
  return { pool: { query, connect: async () => ({ query: onConnection, release: () => {} }) } };
});

const card = (id: string, learn_status: string, learn_message = ""): Row => ({
  id, core: "", notes_en: "", notes_no: "", model_en: null, model_no: null, learn_key: "chief-of-staff",
  learn_lookback_days: 365, learn_cap: 300, learn_status, learn_message, proposed: null,
});
const agent = (name: string, display: string, on = true): Row => ({
  name, definition: { name, role: "chief-of-staff", display, schedules: { "voice-learn": { on } } },
});
const run = (state: string, extra: Row = {}): Row => ({
  job: `${String(extra.agent ?? "example-agent")}/voice-learn`, agent: "example-agent", state, reason: "", detail: "", counts: {},
  started_at: new Date(), updated_at: new Date(), ...extra,
});

async function render(): Promise<string> {
  const { default: Page } = await import("../app/writing-style/page");
  return renderToStaticMarkup(await Page());
}
const button = (html: string) => html.match(/<button[^>]*>[^<]*<\/button>/)?.[0] ?? "";
/** The `disabled` attribute itself (the class list mentions `disabled:` styles on every button). */
const isDisabled = (html: string) => /<button[^>]*\sdisabled=""/.test(button(html));

beforeEach(() => {
  db.cards = [card("default", "idle"), card("owner@owner.example", "idle")];
  db.requestedAt = null;
  db.runs = [];
  db.agents = [agent("example-agent", "Example Agent")];
  db.onConnection = [];
});

describe("the Re-learn button follows the run, not the default card", () => {
  it("a mailbox that is learning disables the button, though the default card says idle", async () => {
    db.cards = [card("default", "idle"), card("owner@owner.example", "running")];
    const html = await render();
    expect(isDisabled(html)).toBe(true);
    expect(button(html)).toContain("Learning…");
    expect(html).toContain('data-state="running"');
  });

  it("a mailbox whose learn failed shows the failure and why", async () => {
    db.cards = [card("default", "idle"), card("owner@owner.example", "error", "gateway 500")];
    const html = await render();
    expect(html).toContain('data-state="failed"');
    expect(html).toContain("The error was: gateway 500");
  });

  it("the job record wins: running from the record, though every card says idle", async () => {
    db.runs = [run("running")];
    expect(isDisabled(await render())).toBe(true);
  });
});

describe("the status line says what is happening, in words", () => {
  it("a pending request reads as requested and names the agent", async () => {
    db.requestedAt = new Date();
    const html = await render();
    expect(html).toContain('data-state="requested"');
    expect(html).toContain("Example Agent starts it within a minute or two.");
    expect(isDisabled(html)).toBe(false);
  });

  it("switched off: says so with the agent's display name and links to where the switch is", async () => {
    db.agents = [agent("example-agent", "Example Agent", false)];
    const html = await render();
    expect(html).toContain('data-state="skipped"');
    expect(html).toContain("Voice Learn is switched off for Example Agent");
    expect(html).toContain('href="/agents/example-agent/edit"');
  });

  it("no mailbox chosen: links to the agent's page, where it is chosen", async () => {
    db.runs = [run("skipped", { reason: "no-mailbox", detail: "No mailbox.", started_at: null })];
    const html = await render();
    expect(html).toContain("No mailbox chosen for Example Agent.");
    expect(html).toContain('href="/agents/example-agent"');
  });

  it("finished: when, and the counts", async () => {
    db.runs = [run("finished", { counts: { kept: 12, dropped: 3 } })];
    const html = await render();
    expect(html).toContain('data-state="finished"');
    expect(html).toContain("Finished today at");
    expect(html).toContain("Kept 12 emails as examples, left out 3.");
  });

  it("nothing ever ran: no status line, just the button", async () => {
    const html = await render();
    expect(html).not.toContain("lares-run-status");
    expect(button(html)).toContain("Re-learn from Sent mail");
  });
});

describe("the request and the outcome are read together", () => {
  it("from one snapshot, so the page never falls between the schedule's claim and its start", async () => {
    await render();
    const seen = db.onConnection.join("\n");
    expect(db.onConnection[0]).toBe("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    expect(seen).toMatch(/SELECT relearn_requested_at FROM voice_profile/);
    expect(seen).toMatch(/FROM agent_definitions/);
    expect(seen).toMatch(/FROM schedule_run/);
    expect(db.onConnection.at(-1)).toBe("COMMIT");
  });
});

describe("more than one chief-of-staff agent: one record each, combined on the page", () => {
  beforeEach(() => {
    db.agents = [agent("example-agent", "Example Agent"), agent("other-agent", "Other Agent")];
  });

  it("one agent still learning: the page says running, though the other agent finished after it started", async () => {
    const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);
    db.runs = [
      run("running", { agent: "other-agent", started_at: minutesAgo(20), updated_at: minutesAgo(20) }),
      run("finished", { counts: { kept: 5, dropped: 1 }, started_at: minutesAgo(10), updated_at: minutesAgo(1) }),
    ];
    const html = await render();
    expect(html).toContain('data-state="running"');
    expect(isDisabled(html)).toBe(true);
  });

  it("the newest outcome names whose run it was by display name", async () => {
    db.runs = [run("finished", { agent: "other-agent", counts: { kept: 4, dropped: 2 } })];
    const html = await render();
    expect(html).toContain("Last run by Other Agent. Kept 4 emails as examples, left out 2.");
  });

  it("an agent whose saved definition is invalid still runs: its run shows; a retired agent's does not", async () => {
    db.agents = [agent("example-agent", "Example Agent"), { ...agent("other-agent", "Other Agent"), status: "invalid" }];
    db.runs = [run("running", { agent: "other-agent" })];
    expect(await render()).toContain('data-state="running"');
    db.agents = [agent("example-agent", "Example Agent"), { ...agent("other-agent", "Other Agent"), status: "retired" }];
    const html = await render();
    expect(html).not.toContain('data-state="running"');
    expect(html).not.toContain("Other Agent");
  });

  it("a record under a key no chief-of-staff agent has (an earlier shared record) is ignored", async () => {
    db.runs = [{ ...run("running"), job: "chief-of-staff/voice-learn", agent: "" }];
    const html = await render();
    expect(html).not.toContain("lares-run-status");
    expect(button(html)).toContain("Re-learn from Sent mail");
  });
});
