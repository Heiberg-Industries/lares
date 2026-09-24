import { beforeEach, describe, expect, it, vi } from "vitest";

const queryMock = vi.fn();
vi.mock("../lib/db", () => ({ pool: { query: (...a: unknown[]) => queryMock(...a) } }));
const listAgentsMock = vi.fn();
vi.mock("../lib/agents", () => ({ listAgents: (...a: unknown[]) => listAgentsMock(...a) }));

const saga = {
  name: "saga", displayName: "Saga", role: "chief-of-staff", skills: [], doors: ["slack"], startedAt: "2026-10-01T06:00:00Z",
  grants: [{ capability: "gmail", scope: "write-with-confirm" }, { capability: "calendar", scope: "read" }],
  autonomy: { gmail: "gated" },
  tools: ["gmail_draft", "gmail_send", "calendar_list_events"],
};

beforeEach(() => {
  queryMock.mockReset();
  listAgentsMock.mockReset();
  listAgentsMock.mockResolvedValue([saga]);
});

describe("getBoardRows", () => {
  it("shows the effective level, where it came from, the locked tools and the evidence", async () => {
    // String(sql), not `(sql: string) =>` + `.includes` on it directly: vitest's own cleanup calls
    // the mock once more with no arguments after the test body finishes (same reason
    // tests/markets-view.test.ts's `withTables` reads `String(sql)` rather than trusting the
    // declared param type).
    queryMock.mockImplementation(async (sql?: unknown) => {
      const text = String(sql ?? "");
      if (text.includes("FROM ratchet")) return { rows: [{ agent: "saga", capability: "gmail", action: "", level: "autonomous", updated_by: "owner@owner.example", updated_at: new Date("2026-10-02T08:00:00Z") }] };
      if (text.includes("FROM approval_events")) return { rows: [{ agent: "saga", capability: "gmail", tool: "gmail_send", decision: "locked", n: "4", last_at: new Date("2026-10-03T09:00:00Z") }] };
      return { rows: [] };
    });
    const { getBoardRows } = await import("../lib/board");
    const rows = await getBoardRows();
    const gmail = rows.find((r) => r.capability === "gmail")!;
    expect(gmail.level).toBe("autonomous");
    expect(gmail.source).toEqual({ kind: "board", by: "owner@owner.example", at: "2026-10-02T08:00:00.000Z" });
    // Final review F2: at ✓ gmail_send sends to people the owner has written to — the column says so.
    expect(gmail.lockedTools).toEqual([{ tool: "gmail_send", reason: "asks for anyone you haven't written to" }]);
    expect(gmail.evidence).toEqual({ asked: 0, autonomous: 0, denied: 0, locked: 4, failedClosed: 0, lastAt: "2026-10-03T09:00:00.000Z" });
    expect(gmail.controllable).toBe(true);
  });
  it("falls back to the agent's own level, and a read-only integration has no control", async () => {
    queryMock.mockResolvedValue({ rows: [] });
    const { getBoardRows } = await import("../lib/board");
    const rows = await getBoardRows();
    expect(rows.find((r) => r.capability === "gmail")).toMatchObject({ level: "gated", source: { kind: "definition" } });
    expect(rows.find((r) => r.capability === "calendar")).toMatchObject({ controllable: false });
  });
  it("counts a failed-closed decision — the check couldn't read the table and asked", async () => {
    queryMock.mockImplementation(async (sql?: unknown) => {
      const text = String(sql ?? "");
      if (text.includes("FROM approval_events")) {
        return { rows: [{ agent: "saga", capability: "gmail", tool: "gmail_send", decision: "failed-closed", n: "2", last_at: new Date("2026-10-04T07:00:00Z") }] };
      }
      return { rows: [] };
    });
    const { getBoardRows } = await import("../lib/board");
    const rows = await getBoardRows();
    const gmail = rows.find((r) => r.capability === "gmail")!;
    expect(gmail.evidence).toEqual({ asked: 0, autonomous: 0, denied: 0, locked: 0, failedClosed: 2, lastAt: "2026-10-04T07:00:00.000Z" });
  });

  // Final review F1: a plain `write` grant's tools carry no approval, so a dial there would do nothing.
  it("only a write-with-confirm grant has a control; a plain write does not", async () => {
    queryMock.mockResolvedValue({ rows: [] });
    listAgentsMock.mockResolvedValue([{
      name: "helper", displayName: "Helper", role: "assistant", skills: [], doors: [], startedAt: "2026-10-01T06:00:00Z",
      grants: [{ capability: "vault", scope: "write", areas: ["shared"] }, { capability: "remind", scope: "write-with-confirm" }],
      autonomy: {},
      tools: ["vault_write", "remind_set"],
    }]);
    const { getBoardRows } = await import("../lib/board");
    const rows = await getBoardRows();
    expect(rows.find((r) => r.capability === "vault")).toMatchObject({ scope: "write", controllable: false });
    expect(rows.find((r) => r.capability === "remind")).toMatchObject({ scope: "write-with-confirm", controllable: true });
  });

  // Final review F2 + F11: an agent that registered no tool list still shows its capability's locks,
  // from the documented tools — and a history-checked contact tool says what it actually does.
  it("with no registered tool list, the locks come from the capability's documented tools", async () => {
    queryMock.mockResolvedValue({ rows: [] });
    listAgentsMock.mockResolvedValue([{
      name: "helper", displayName: "Helper", role: "assistant", skills: [], doors: [], startedAt: "2026-10-01T06:00:00Z",
      grants: [{ capability: "calendar", scope: "write-with-confirm" }],
      autonomy: { calendar: "gated" },
      tools: null,
    }]);
    const { getBoardRows } = await import("../lib/board");
    const [calendar] = await getBoardRows();
    expect(calendar!.lockedTools).toEqual(expect.arrayContaining([
      { tool: "calendar_create_event", reason: "asks for anyone you haven't written to" },
      { tool: "calendar_update_event", reason: "first contact with someone always asks first" },
      { tool: "calendar_delete_event", reason: "deleting data always asks first" },
    ]));
    expect(calendar!.lockedTools.map((l) => l.tool)).not.toContain("calendar_list_events");
  });
  it("with no registered tool list, a read or plain-write grant lists no locks (the agent may not hold those tools)", async () => {
    queryMock.mockResolvedValue({ rows: [] });
    listAgentsMock.mockResolvedValue([{
      name: "helper", displayName: "Helper", role: "assistant", skills: [], doors: [], startedAt: "2026-10-01T06:00:00Z",
      grants: [{ capability: "calendar", scope: "read" }, { capability: "remind", scope: "write" }],
      autonomy: {},
      tools: null,
    }]);
    const { getBoardRows } = await import("../lib/board");
    const rows = await getBoardRows();
    expect(rows.find((r) => r.capability === "calendar")!.lockedTools).toEqual([]);
    expect(rows.find((r) => r.capability === "remind")!.lockedTools).toEqual([]);
  });

  // W5C-s8 — THE AREA IS THE ACTION. One `vault` grant is three lanes on the board, because the
  // approval check reads `(agent, "vault", <area>)` per tool. One row for the capability would put
  // a dial on screen that sets a key nothing reads, and would silently merge three decisions.
  const librarian = {
    name: "librarian", displayName: "Librarian", role: "assistant", skills: [], doors: [], startedAt: "2026-10-01T06:00:00Z",
    grants: [{ capability: "vault", scope: "write-with-confirm", areas: ["private", "shared", "facts"] }],
    autonomy: { vault: "gated" },
    tools: ["agent-kit__vault_drop", "vault_write", "atlas_resolve_proposal", "forget"],
  };

  it("shows one row per granted vault area, each with a human label", async () => {
    queryMock.mockResolvedValue({ rows: [] });
    listAgentsMock.mockResolvedValue([librarian]);
    const { getBoardRows } = await import("../lib/board");
    const rows = await getBoardRows();
    expect(rows.map((r) => [r.capability, r.action, r.actionLabel])).toEqual([
      ["vault", "private", "Private notes"],
      ["vault", "shared", "Shared notes"],
      ["vault", "facts", "Facts"],
    ]);
  });

  it("a level set for one area is shown on that row alone", async () => {
    queryMock.mockImplementation(async (sql?: unknown) => {
      const text = String(sql ?? "");
      if (text.includes("FROM ratchet")) {
        return { rows: [{ agent: "librarian", capability: "vault", action: "shared", level: "autonomous", updated_by: "owner@example.com", updated_at: new Date("2026-10-02T08:00:00Z") }] };
      }
      return { rows: [] };
    });
    listAgentsMock.mockResolvedValue([librarian]);
    const { getBoardRows } = await import("../lib/board");
    const rows = await getBoardRows();
    expect(rows.find((r) => r.action === "shared")).toMatchObject({ level: "autonomous", source: { kind: "board", by: "owner@example.com" } });
    expect(rows.find((r) => r.action === "facts")).toMatchObject({ level: "gated", source: { kind: "definition" } });
    expect(rows.find((r) => r.action === "private")).toMatchObject({ level: "gated", source: { kind: "definition" } });
  });

  it("each area lists only its own always-ask tools", async () => {
    queryMock.mockResolvedValue({ rows: [] });
    listAgentsMock.mockResolvedValue([librarian]);
    const { getBoardRows } = await import("../lib/board");
    const rows = await getBoardRows();
    // The kit's personal-store delete is a private-area lock; `forget` is a facts-area one.
    expect(rows.find((r) => r.action === "private")!.lockedTools.map((l) => l.tool)).toEqual(["agent-kit__vault_drop"]);
    expect(rows.find((r) => r.action === "facts")!.lockedTools.map((l) => l.tool)).toEqual(["forget"]);
    expect(rows.find((r) => r.action === "shared")!.lockedTools).toEqual([]);
  });

  // `approval_events` (038) has no action column, so the area is read back off the `tool` column
  // it already carries — otherwise the same capability-wide totals would be printed three times.
  it("attributes a vault decision to the area of the tool it was made for", async () => {
    queryMock.mockImplementation(async (sql?: unknown) => {
      const text = String(sql ?? "");
      if (text.includes("FROM approval_events")) {
        return { rows: [
          { agent: "librarian", capability: "vault", tool: "forget", decision: "locked", n: "2", last_at: new Date("2026-10-03T09:00:00Z") },
          { agent: "librarian", capability: "vault", tool: "vault_write", decision: "asked", n: "5", last_at: new Date("2026-10-04T09:00:00Z") },
        ] };
      }
      return { rows: [] };
    });
    listAgentsMock.mockResolvedValue([librarian]);
    const { getBoardRows } = await import("../lib/board");
    const rows = await getBoardRows();
    expect(rows.find((r) => r.action === "facts")!.evidence).toMatchObject({ locked: 2, asked: 0, lastAt: "2026-10-03T09:00:00.000Z" });
    expect(rows.find((r) => r.action === "shared")!.evidence).toMatchObject({ asked: 5, locked: 0, lastAt: "2026-10-04T09:00:00.000Z" });
    expect(rows.find((r) => r.action === "private")!.evidence).toMatchObject({ asked: 0, locked: 0, lastAt: null });
  });

  it("a vault grant with no areas shows nothing to set, rather than a dial nothing reads", async () => {
    queryMock.mockResolvedValue({ rows: [] });
    listAgentsMock.mockResolvedValue([{ ...librarian, grants: [{ capability: "vault", scope: "write-with-confirm" }] }]);
    const { getBoardRows } = await import("../lib/board");
    expect(await getBoardRows()).toEqual([]);
  });

  it("a non-vault row still has no action at all", async () => {
    queryMock.mockResolvedValue({ rows: [] });
    const { getBoardRows } = await import("../lib/board");
    const rows = await getBoardRows();
    expect(rows.every((r) => r.action === "" && r.actionLabel === null)).toBe(true);
  });

  it("keeps two agents' settings and evidence apart", async () => {
    queryMock.mockImplementation(async (sql?: unknown) => {
      const text = String(sql ?? "");
      if (text.includes("FROM ratchet")) return { rows: [{ agent: "helper", capability: "gmail", action: "", level: "never", updated_by: "owner@example.com", updated_at: new Date("2026-10-05T08:00:00Z") }] };
      if (text.includes("FROM approval_events")) return { rows: [{ agent: "saga", capability: "gmail", tool: "gmail_send", decision: "asked", n: "3", last_at: new Date("2026-10-05T09:00:00Z") }] };
      return { rows: [] };
    });
    listAgentsMock.mockResolvedValue([saga, {
      name: "helper", displayName: "Helper", role: "assistant", skills: [], doors: [], startedAt: "2026-10-01T06:00:00Z",
      grants: [{ capability: "gmail", scope: "write-with-confirm" }],
      autonomy: { gmail: "autonomous" },
      tools: ["gmail_send"],
    }]);
    const { getBoardRows } = await import("../lib/board");
    const rows = await getBoardRows();
    const mine = rows.find((r) => r.agent === "saga" && r.capability === "gmail")!;
    const theirs = rows.find((r) => r.agent === "helper" && r.capability === "gmail")!;
    expect(mine).toMatchObject({ level: "gated", source: { kind: "definition" } });
    expect(mine.evidence.asked).toBe(3);
    expect(theirs).toMatchObject({ level: "never", source: { kind: "board", by: "owner@example.com" } });
    expect(theirs.evidence.asked).toBe(0);
  });

  // W7B-s2 — what the OWNER answered (approval_asks, box 086), beside what the policy decided
  // (evidence, above). `readApprovalCounts` issues its own "FROM approval_asks" query.
  it("shows what the owner answered, per capability, beside what the policy decided", async () => {
    listAgentsMock.mockResolvedValue([{
      name: "helper", displayName: "Helper", role: "assistant", skills: [], doors: [], startedAt: "2026-10-01T06:00:00Z",
      grants: [{ capability: "gmail", scope: "write-with-confirm" }],
      autonomy: { gmail: "gated" },
      tools: ["gmail_send"],
    }]);
    queryMock.mockImplementation(async (sql?: unknown) => {
      const text = String(sql ?? "");
      if (text.includes("FROM approval_asks")) return { rows: [
        { agent: "helper", tool: "gmail_send", asked: "4", approved: "3", cancelled: "1",
          never_answered: "0", first_at: new Date("2026-08-01T00:00:00Z"), last_at: new Date("2026-09-19T00:00:00Z") },
      ] };
      return { rows: [] };
    });
    const { getBoardRows } = await import("../lib/board");
    const gmail = (await getBoardRows()).find((r) => r.capability === "gmail")!;
    expect(gmail.answers).toEqual({ approved: 3, cancelled: 1, neverAnswered: 0, rate: 0.75 });
  });

  it("says nothing rather than 0% when nobody has answered anything", async () => {
    queryMock.mockResolvedValue({ rows: [] });
    const { getBoardRows } = await import("../lib/board");
    expect((await getBoardRows())[0]!.answers.rate).toBeNull();
  });

  // W7B-s3 — "this could act on its own": a SUGGESTION, never applied. `couldGraduate` is wiring
  // over `@lares/agent-kit/approval-stats`'s own `couldActOnItsOwn` — the arithmetic is that
  // module's test's job, not this one's.
  it("marks a row couldGraduate when one of its tools has a clean, long-enough history", async () => {
    listAgentsMock.mockResolvedValue([{
      name: "helper", displayName: "Helper", role: "assistant", skills: [], doors: [], startedAt: "2026-10-01T06:00:00Z",
      grants: [{ capability: "remind", scope: "write-with-confirm" }],
      autonomy: { remind: "gated" },
      tools: ["remind_set"],
    }]);
    const longAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    queryMock.mockImplementation(async (sql?: unknown) => {
      const text = String(sql ?? "");
      if (text.includes("FROM approval_asks")) return { rows: [
        { agent: "helper", tool: "remind_set", asked: "12", approved: "12", cancelled: "0",
          never_answered: "0", first_at: longAgo, last_at: new Date() },
      ] };
      return { rows: [] };
    });
    const { getBoardRows } = await import("../lib/board");
    const remind = (await getBoardRows()).find((r) => r.capability === "remind")!;
    expect(remind.couldGraduate).toBe(true);
  });

  it("says nothing when ANOTHER tool on the same row has been refused — the dial frees the whole row", async () => {
    listAgentsMock.mockResolvedValue([{
      name: "helper", displayName: "Helper", role: "assistant", skills: [], doors: [], startedAt: "2026-10-01T06:00:00Z",
      grants: [{ capability: "remind", scope: "write-with-confirm" }],
      autonomy: { remind: "gated" },
      tools: ["remind_set", "remind_list"],
    }]);
    const longAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    queryMock.mockImplementation(async (sql?: unknown) => {
      const text = String(sql ?? "");
      if (text.includes("FROM approval_asks")) return { rows: [
        { agent: "helper", tool: "remind_set", asked: "12", approved: "12", cancelled: "0",
          never_answered: "0", first_at: longAgo, last_at: new Date() },
        { agent: "helper", tool: "remind_list", asked: "3", approved: "2", cancelled: "1",
          never_answered: "0", first_at: longAgo, last_at: new Date() },
      ] };
      return { rows: [] };
    });
    const { getBoardRows } = await import("../lib/board");
    expect((await getBoardRows()).find((r) => r.capability === "remind")!.couldGraduate).toBe(false);
  });

  it("does not hold a refusal of an always-ask tool against the row — the dial never frees that tool anyway", async () => {
    listAgentsMock.mockResolvedValue([{
      name: "helper", displayName: "Helper", role: "assistant", skills: [], doors: [], startedAt: "2026-10-01T06:00:00Z",
      grants: [{ capability: "remind", scope: "write-with-confirm" }],
      autonomy: { remind: "gated" },
      tools: ["remind_set", "remind_cancel"],
    }]);
    const longAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    queryMock.mockImplementation(async (sql?: unknown) => {
      const text = String(sql ?? "");
      if (text.includes("FROM approval_asks")) return { rows: [
        { agent: "helper", tool: "remind_set", asked: "12", approved: "12", cancelled: "0",
          never_answered: "0", first_at: longAgo, last_at: new Date() },
        { agent: "helper", tool: "remind_cancel", asked: "3", approved: "2", cancelled: "1",
          never_answered: "0", first_at: longAgo, last_at: new Date() },
      ] };
      return { rows: [] };
    });
    const { getBoardRows } = await import("../lib/board");
    expect((await getBoardRows()).find((r) => r.capability === "remind")!.couldGraduate).toBe(true);
  });

  it("says nothing on a row that already acts on its own", async () => {
    listAgentsMock.mockResolvedValue([{
      name: "helper", displayName: "Helper", role: "assistant", skills: [], doors: [], startedAt: "2026-10-01T06:00:00Z",
      grants: [{ capability: "remind", scope: "write-with-confirm" }],
      autonomy: { remind: "autonomous" },
      tools: ["remind_set"],
    }]);
    const longAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    queryMock.mockImplementation(async (sql?: unknown) => {
      const text = String(sql ?? "");
      if (text.includes("FROM approval_asks")) return { rows: [
        { agent: "helper", tool: "remind_set", asked: "12", approved: "12", cancelled: "0",
          never_answered: "0", first_at: longAgo, last_at: new Date() },
      ] };
      return { rows: [] };
    });
    const { getBoardRows } = await import("../lib/board");
    expect((await getBoardRows()).find((r) => r.capability === "remind")!.couldGraduate).toBe(false);
  });

  it("does not mark a row couldGraduate on a refusal, too few cards, or a locked tool", async () => {
    listAgentsMock.mockResolvedValue([{
      name: "helper", displayName: "Helper", role: "assistant", skills: [], doors: [], startedAt: "2026-10-01T06:00:00Z",
      grants: [{ capability: "gmail", scope: "write-with-confirm" }],
      autonomy: { gmail: "gated" },
      tools: ["gmail_send"],
    }]);
    queryMock.mockImplementation(async (sql?: unknown) => {
      const text = String(sql ?? "");
      // gmail_send is a first-contact-locked tool (mustAlwaysAsk) — a clean, long history on it
      // is never a suggestion, whatever the numbers say.
      if (text.includes("FROM approval_asks")) return { rows: [
        { agent: "helper", tool: "gmail_send", asked: "50", approved: "50", cancelled: "0",
          never_answered: "0", first_at: new Date(Date.now() - 200 * 24 * 60 * 60 * 1000), last_at: new Date() },
      ] };
      return { rows: [] };
    });
    const { getBoardRows } = await import("../lib/board");
    const gmail = (await getBoardRows()).find((r) => r.capability === "gmail")!;
    expect(gmail.couldGraduate).toBe(false);
  });

  it("issues no INSERT, UPDATE or DELETE against ratchet — a suggestion is a sentence, never a write", async () => {
    listAgentsMock.mockResolvedValue([{
      name: "helper", displayName: "Helper", role: "assistant", skills: [], doors: [], startedAt: "2026-10-01T06:00:00Z",
      grants: [{ capability: "remind", scope: "write-with-confirm" }],
      autonomy: { remind: "gated" },
      tools: ["remind_set"],
    }]);
    const longAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    queryMock.mockImplementation(async (sql?: unknown) => {
      const text = String(sql ?? "");
      if (text.includes("FROM approval_asks")) return { rows: [
        { agent: "helper", tool: "remind_set", asked: "12", approved: "12", cancelled: "0",
          never_answered: "0", first_at: longAgo, last_at: new Date() },
      ] };
      return { rows: [] };
    });
    const { getBoardRows } = await import("../lib/board");
    const rows = await getBoardRows();
    expect(rows.find((r) => r.capability === "remind")!.couldGraduate).toBe(true);
    for (const call of queryMock.mock.calls) {
      const text = String(call[0] ?? "").toUpperCase();
      expect(text).not.toContain("INSERT INTO RATCHET");
      expect(text).not.toContain("UPDATE RATCHET");
      expect(text).not.toContain("DELETE FROM RATCHET");
    }
  });
});
