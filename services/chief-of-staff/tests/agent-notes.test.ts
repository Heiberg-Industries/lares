/**
 * W4B-s5 — the agent's own notes store, and the tool that writes it. Against a REAL disposable
 * Postgres running the REAL migration file, the house pattern (`tests/standing-facts.test.ts`).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { getPool, closePool } from "@lares/agent-kit/db";
import { taintTurn, resetTaintForTests } from "@lares/agent-kit/origin-taint";
import { addNote, notesForSession, NOTES_SURFACED_PER_SESSION, type AgentNote } from "../lib/agent-notes.js";
import { buildFactsCorrection } from "../lib/standing-facts.js";

describe("agent notes are add-only and stamped", () => {
  let container: StartedPostgreSqlContainer;
  let dbUrl: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16-alpine").start();
    dbUrl = container.getConnectionUri();
    process.env["DATABASE_URL"] = dbUrl;
    await getPool().query(readFileSync(join(import.meta.dirname, "../sql/002-standing-facts.sql"), "utf8"));
    await getPool().query(readFileSync(join(import.meta.dirname, "../sql/003-facts-owner.sql"), "utf8"));
    await getPool().query(readFileSync(join(import.meta.dirname, "../sql/004-standing-facts-origin.sql"), "utf8"));
    await getPool().query(readFileSync(join(import.meta.dirname, "../sql/005-standing-facts-validity.sql"), "utf8"));
    await getPool().query(readFileSync(join(import.meta.dirname, "../../box/sql/071_agent_notes.sql"), "utf8"));
  }, 120_000);

  afterAll(async () => {
    await closePool();
    await container.stop();
  });

  beforeEach(async () => {
    process.env["DATABASE_URL"] = dbUrl;
    await getPool().query("TRUNCATE agent_notes RESTART IDENTITY");
    resetTaintForTests();
  });

  it("stores a note with the turn's own class", async () => {
    const n = await addNote(getPool(), {
      owner: "fixture-owner", agent: "role-under-test", kind: "watch",
      note: "waiting on the supplier's confirmation", origin: "agent",
      sessionId: "s1", turnId: "t1",
    });
    expect(n.id).toBeGreaterThan(0);
    expect(n.origin).toBe("agent");
  });

  it("accepts a third-party note rather than refusing it", async () => {
    const n = await addNote(getPool(), {
      owner: "fixture-owner", agent: "role-under-test", kind: "followup",
      note: "the invoice in that email says the 14th", origin: "third_party",
      sessionId: "s1", turnId: "t2",
    });
    expect(n.origin).toBe("third_party");
  });

  it("refuses an unknown kind and an over-long note at the database, not only in zod", async () => {
    await expect(getPool().query(
      "INSERT INTO agent_notes (owner, agent, kind, note, origin, session_id, turn_id) VALUES ('o','a','plan','x','agent','s','t')",
    )).rejects.toThrow(/agent_notes_kind_check/);
    await expect(getPool().query(
      "INSERT INTO agent_notes (owner, agent, kind, note, origin, session_id, turn_id) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      ["o", "a", "watch", "x".repeat(401), "agent", "s", "t"],
    )).rejects.toThrow(/agent_notes_note_check/);
  });

  it("returns a session's notes oldest first", async () => {
    for (const note of ["first", "second"]) {
      await addNote(getPool(), {
        owner: "fixture-owner", agent: "role-under-test", kind: "working",
        note, origin: "agent", sessionId: "s9", turnId: "t",
      });
    }
    expect((await notesForSession(getPool(), "s9")).map((n) => n.note)).toEqual(["first", "second"]);
  });

  it("repeats only a session's newest notes, so a long conversation cannot grow the prompt without end", async () => {
    for (let i = 0; i < NOTES_SURFACED_PER_SESSION + 3; i++) {
      await addNote(getPool(), {
        owner: "fixture-owner", agent: "role-under-test", kind: "working",
        note: `note ${i}`, origin: "agent", sessionId: "s-long", turnId: "t",
      });
    }
    const surfaced = (await notesForSession(getPool(), "s-long")).map((n) => n.note);
    expect(surfaced).toHaveLength(NOTES_SURFACED_PER_SESSION);
    expect(surfaced[0]).toBe("note 3");
    expect(surfaced.at(-1)).toBe(`note ${NOTES_SURFACED_PER_SESSION + 2}`);
  });

  it("exposes no way to change or remove a note", async () => {
    const mod = await import("../lib/agent-notes.js");
    expect(Object.keys(mod).filter((k) => /update|edit|delete|remove|forget/i.test(k))).toEqual([]);
  });

  describe("the save_note tool", () => {
    it("stamps the turn's class through stampFor, and never takes one as input", async () => {
      const tool = (await import("../catalogue/save_note.js")).default;
      expect(Object.keys(tool.inputSchema.shape).sort()).toEqual(["kind", "note"]);
      taintTurn({ sessionId: "s5", turnId: "t5" }, "third_party");
      const out = await tool.execute(
        { kind: "watch", note: "the page said the deadline moved" },
        { session: { id: "s5", turn: { id: "t5" } } } as never,
      );
      expect(out.saved).toBe(true);
      const [row] = await notesForSession(getPool(), "s5");
      expect(row!.origin).toBe("third_party");
    });

    it("says plainly when the table is not there yet, instead of throwing", async () => {
      await getPool().query("ALTER TABLE agent_notes RENAME TO agent_notes_hidden");
      const tool = (await import("../catalogue/save_note.js")).default;
      const out = await tool.execute(
        { kind: "working", note: "x" },
        { session: { id: "s6", turn: { id: "t6" } } } as never,
      );
      expect(out.saved).toBe(false);
      expect(out.message).toMatch(/071_agent_notes\.sql/);
      await getPool().query("ALTER TABLE agent_notes_hidden RENAME TO agent_notes");
    });
  });
});

// ── buildFactsCorrection's notes half — pure, no database ────────────────────────────────────
//
// Property (3) of this slice: a note is never a fact and never an instruction, and — the part
// that is easy to get wrong — a note stamped `third_party` or `synced` must never be placed in
// the system prompt, however it is worded, because it was written on a turn that had already
// read someone else's words. This is the render-time gate that keeps that true.
describe("buildFactsCorrection surfaces notes safely (W4B-s5)", () => {
  const noteAt = (origin: AgentNote["origin"]): AgentNote => ({
    id: 1,
    owner: "fixture-owner",
    agent: "role-under-test",
    kind: "watch",
    note: "waiting on the supplier's reply",
    origin,
    sessionId: "s",
    turnId: "t",
    at: new Date("2026-09-18T09:00:00Z"),
  });

  it("shows an agent-origin note back, under its own heading", () => {
    const out = buildFactsCorrection([], [], [noteAt("agent")]);
    expect(out).toMatch(/^## Since this conversation began/m);
    expect(out).toContain("I have noted, this conversation:");
    expect(out).toContain("waiting on the supplier's reply");
  });

  it("shows an owner-origin or system-origin note back too", () => {
    expect(buildFactsCorrection([], [], [noteAt("owner")])).toContain("waiting on the supplier's reply");
    expect(buildFactsCorrection([], [], [noteAt("system")])).toContain("waiting on the supplier's reply");
  });

  it("never shows a third_party-origin note back — outside text must not re-enter the prompt", () => {
    expect(buildFactsCorrection([], [], [noteAt("third_party")])).toBe("");
  });

  it("never shows a synced-origin note back either", () => {
    expect(buildFactsCorrection([], [], [noteAt("synced")])).toBe("");
  });

  it("is still empty with no notes and no fact changes — the default stays byte-identical", () => {
    expect(buildFactsCorrection([], [])).toBe("");
  });
});
