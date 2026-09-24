import { afterEach, describe, expect, it, vi } from "vitest";
import {
  APPROVAL_CACHE_MS, BOARD_READ_TIMEOUT_MS, boardApproval, type BoardDeps, type ContactHistory, CONTACT_HISTORY_TIMEOUT_MS,
  clearBoardCache, decideApproval, setBoardDeps,
} from "../src/board-approval.js";
import type { AutonomyLevel } from "../src/manifest.js";

function fakeDeps(levels: Record<string, AutonomyLevel | null | "throw" | "hang">) {
  let clock = 0;
  const reads: string[] = [];
  const events: Array<{ tool: string; decision: string }> = [];
  const callIds: Array<string | undefined> = [];
  const deps: BoardDeps = {
    explicitLevel: async (agent, capability) => {
      reads.push(`${agent}/${capability}`);
      const v = levels[`${agent}/${capability}`];
      if (v === "throw") throw new Error("connection refused");
      if (v === "hang") return new Promise<never>(() => {});
      return v ?? null;
    },
    record: async (e) => {
      events.push({ tool: e.tool, decision: e.decision });
      callIds.push(e.callId);
    },
    now: () => clock,
  };
  return { deps, reads, events, callIds, advance: (ms: number) => { clock += ms; } };
}
const input = (tool: string, capability: string, startingLevel: AutonomyLevel = "gated") => ({ agent: "calliope", tool, capability, startingLevel });

afterEach(() => {
  clearBoardCache();
  setBoardDeps(null);
});

describe("decideApproval", () => {
  it("falls back to the agent's own level when the board has no row", async () => {
    const f = fakeDeps({});
    expect((await decideApproval(input("vault_write", "vault", "autonomous"), f.deps)).status).toBe("not-applicable");
    expect((await decideApproval(input("studio_ideate", "studio", "gated"), f.deps)).status).toBe("user-approval");
  });
  it("the board wins over the agent's own level", async () => {
    const f = fakeDeps({ "calliope/vault": "autonomous" });
    expect(await decideApproval(input("vault_write", "vault", "gated"), f.deps)).toEqual({
      status: "not-applicable", decision: "autonomous", reason: "set to act on its own",
    });
  });
  it("'never' on the board denies with a reason the model can relay", async () => {
    const f = fakeDeps({ "calliope/vault": "never" });
    expect((await decideApproval(input("vault_write", "vault"), f.deps)).status).toEqual({
      type: "denied", reason: "vault is switched off for calliope on the permissions board",
    });
  });
  it("always-ask beats an 'autonomous' board setting", async () => {
    const f = fakeDeps({ "saga/calendar": "autonomous" });
    const d = await decideApproval({ agent: "saga", tool: "calendar_delete_event", capability: "calendar", startingLevel: "autonomous" }, f.deps);
    expect(d).toEqual({ status: "user-approval", decision: "locked", reason: "deleting data always asks first" });
    // Final review F3: a locked tool still reads the level — only so that 🚫 can refuse it.
    expect(f.reads).toEqual(["saga/calendar"]);
  });

  // Final review F3 (controller ruling): 🚫 stops always-ask tools too. No setting loosens always-ask;
  // 🚫 only tightens it.
  describe("always-ask tools and the board's level (F3)", () => {
    const del = (startingLevel: AutonomyLevel = "gated") =>
      ({ agent: "saga", tool: "calendar_delete_event", capability: "calendar", startingLevel });
    it("🚫 on the board refuses an always-ask tool, with the usual reason", async () => {
      const f = fakeDeps({ "saga/calendar": "never" });
      const d = await decideApproval(del(), f.deps);
      expect(d.decision).toBe("denied");
      expect(d.status).toEqual({ type: "denied", reason: "calendar is switched off for saga on the permissions board" });
    });
    it("🚫 as the agent's own level (no board row) refuses too", async () => {
      const f = fakeDeps({});
      expect((await decideApproval(del("never"), f.deps)).decision).toBe("denied");
    });
    it("✋ still asks with the lock's reason", async () => {
      const f = fakeDeps({ "saga/calendar": "gated" });
      expect(await decideApproval(del(), f.deps)).toEqual({ status: "user-approval", decision: "locked", reason: "deleting data always asks first" });
    });
    it("an unreadable table still asks (fails closed), never runs", async () => {
      const f = fakeDeps({ "saga/calendar": "throw" });
      expect(await decideApproval(del("autonomous"), f.deps)).toEqual({ status: "user-approval", decision: "locked", reason: "deleting data always asks first" });
    });
    it("a history-checked contact tool with 🚫 is refused before any recipient is read", async () => {
      const f = fakeDeps({ "saga/gmail": "never" });
      let called = false;
      const d = await decideApproval(
        { agent: "saga", tool: "gmail_send", capability: "gmail", startingLevel: "autonomous", toolInput: { to: ["person@example.com"] }, contactHistory: async () => { called = true; return true; } },
        f.deps,
      );
      expect(d.decision).toBe("denied");
      expect(called).toBe(false);
    });
  });

  // Final review F4 (owner decision O1): switching a meeting series to auto-send always asks.
  it("meeting_followup_auto asks even when its capability is set to act on its own", async () => {
    const f = fakeDeps({ "saga/autonomy": "autonomous" });
    const d = await decideApproval({ agent: "saga", tool: "meeting_followup_auto", capability: "autonomy", startingLevel: "autonomous" }, f.deps);
    expect(d).toEqual({ status: "user-approval", decision: "locked", reason: "changing its own autonomy always asks first" });
  });

  // Final review F8: a hung table read costs a click, never the whole turn.
  it("a table read that never resolves times out and fails closed", async () => {
    vi.useFakeTimers();
    try {
      const f = fakeDeps({ "calliope/vault": "hang" });
      const promise = decideApproval(input("vault_write", "vault", "autonomous"), f.deps);
      await vi.advanceTimersByTimeAsync(BOARD_READ_TIMEOUT_MS + 1);
      expect(await promise).toEqual({
        status: "user-approval", decision: "failed-closed", reason: "the permissions table could not be read — asking first",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  describe("history-checked contact tools (gmail_send, calendar_create_event)", () => {
    const knownHistory: ContactHistory = async () => true;
    const unknownHistory: ContactHistory = async () => false;
    const throwingHistory: ContactHistory = async () => { throw new Error("history source down"); };

    it("gated → asked, without ever calling the history check", async () => {
      const f = fakeDeps({ "saga/gmail": "gated" });
      let called = false;
      const contactHistory: ContactHistory = async () => { called = true; return true; };
      const d = await decideApproval(
        { agent: "saga", tool: "gmail_send", capability: "gmail", startingLevel: "gated", toolInput: { to: ["person@example.com"] }, contactHistory },
        f.deps,
      );
      expect(d).toEqual({ status: "user-approval", decision: "asked", reason: "set to ask first" });
      expect(called).toBe(false);
    });

    it("never → denied", async () => {
      const f = fakeDeps({ "saga/gmail": "never" });
      const d = await decideApproval(
        { agent: "saga", tool: "gmail_send", capability: "gmail", startingLevel: "gated", toolInput: { to: ["person@example.com"] }, contactHistory: knownHistory },
        f.deps,
      );
      expect(d.decision).toBe("denied");
    });

    it("autonomous + every recipient known → not-applicable/autonomous", async () => {
      const f = fakeDeps({ "saga/gmail": "autonomous" });
      const d = await decideApproval(
        {
          agent: "saga", tool: "gmail_send", capability: "gmail", startingLevel: "gated",
          toolInput: { to: ["alice@example.com", "bob@example.com"] }, contactHistory: knownHistory,
        },
        f.deps,
      );
      expect(d).toEqual({ status: "not-applicable", decision: "autonomous", reason: "every recipient has been in touch before" });
    });

    it("autonomous + one unknown recipient → locked", async () => {
      const f = fakeDeps({ "saga/gmail": "autonomous" });
      const d = await decideApproval(
        { agent: "saga", tool: "gmail_send", capability: "gmail", startingLevel: "gated", toolInput: { to: ["person@example.com"] }, contactHistory: unknownHistory },
        f.deps,
      );
      expect(d).toEqual({ status: "user-approval", decision: "locked", reason: "first contact with someone always asks first" });
    });

    // Fix round 1, I5: pin that EVERY recipient is actually checked, not just the first.
    it("autonomous + a mix of known and unknown → locked, and BOTH recipients were queried", async () => {
      const f = fakeDeps({ "saga/gmail": "autonomous" });
      const queried: string[] = [];
      const perAddress: ContactHistory = async (recipient) => {
        queried.push(recipient);
        return recipient === "known@example.com";
      };
      const d = await decideApproval(
        {
          agent: "saga", tool: "gmail_send", capability: "gmail", startingLevel: "gated",
          toolInput: { to: ["known@example.com", "unknown@example.com"] }, contactHistory: perAddress,
        },
        f.deps,
      );
      expect(d).toEqual({ status: "user-approval", decision: "locked", reason: "first contact with someone always asks first" });
      expect(queried.sort()).toEqual(["known@example.com", "unknown@example.com"]);
    });

    it("autonomous + history throws → locked", async () => {
      const f = fakeDeps({ "saga/gmail": "autonomous" });
      const d = await decideApproval(
        { agent: "saga", tool: "gmail_send", capability: "gmail", startingLevel: "gated", toolInput: { to: ["person@example.com"] }, contactHistory: throwingHistory },
        f.deps,
      );
      expect(d).toEqual({ status: "user-approval", decision: "locked", reason: "contact history could not be read — asking first" });
    });

    it("autonomous + unreadable `to` → locked", async () => {
      const f = fakeDeps({ "saga/gmail": "autonomous" });
      const d = await decideApproval(
        { agent: "saga", tool: "gmail_send", capability: "gmail", startingLevel: "gated", toolInput: { to: "not-an-array" }, contactHistory: knownHistory },
        f.deps,
      );
      expect(d).toEqual({ status: "user-approval", decision: "locked", reason: "could not read who this goes to — asking first" });
    });

    // Fix round 1, I3: non-object toolInput must never read as "no attendees" → autonomous.
    it("autonomous + non-object toolInput (e.g. absent) → locked, not 'contacts nobody'", async () => {
      const f = fakeDeps({ "saga/calendar": "autonomous" });
      const d = await decideApproval(
        { agent: "saga", tool: "calendar_create_event", capability: "calendar", startingLevel: "gated", toolInput: undefined, contactHistory: knownHistory },
        f.deps,
      );
      expect(d).toEqual({ status: "user-approval", decision: "locked", reason: "could not read who this goes to — asking first" });
    });

    it("autonomous + no contactHistory given → locked", async () => {
      const f = fakeDeps({ "saga/gmail": "autonomous" });
      const d = await decideApproval(
        { agent: "saga", tool: "gmail_send", capability: "gmail", startingLevel: "gated", toolInput: { to: ["person@example.com"] } },
        f.deps,
      );
      expect(d).toEqual({ status: "user-approval", decision: "locked", reason: "first contact with someone always asks first" });
    });

    // D-C (controller ruling, fix round 1): notify:false no longer means "contacts nobody" —
    // attendees are checked regardless.
    it("calendar_create_event with notify:false still checks attendees (D-C)", async () => {
      const f = fakeDeps({ "saga/calendar": "autonomous" });
      const d = await decideApproval(
        {
          agent: "saga", tool: "calendar_create_event", capability: "calendar", startingLevel: "gated",
          toolInput: { attendees: ["person@example.com"], notify: false }, contactHistory: knownHistory,
        },
        f.deps,
      );
      expect(d).toEqual({ status: "not-applicable", decision: "autonomous", reason: "every recipient has been in touch before" });
    });

    it("calendar_create_event with no attendees → autonomous, without calling the history check", async () => {
      const f = fakeDeps({ "saga/calendar": "autonomous" });
      let called = false;
      const contactHistory: ContactHistory = async () => { called = true; return true; };
      const d = await decideApproval(
        { agent: "saga", tool: "calendar_create_event", capability: "calendar", startingLevel: "gated", toolInput: { notify: false }, contactHistory },
        f.deps,
      );
      expect(d).toEqual({ status: "not-applicable", decision: "autonomous", reason: "contacts nobody" });
      expect(called).toBe(false);
    });

    it("calendar_update_event always locks — the table is read only so 🚫 can refuse it", async () => {
      const f = fakeDeps({ "saga/calendar": "autonomous" });
      const d = await decideApproval(
        { agent: "saga", tool: "calendar_update_event", capability: "calendar", startingLevel: "autonomous", toolInput: { attendees: ["person@example.com"] }, contactHistory: knownHistory },
        f.deps,
      );
      expect(d).toEqual({ status: "user-approval", decision: "locked", reason: "first contact with someone always asks first" });
      expect(f.reads).toEqual(["saga/calendar"]);
    });

    // Fix round 1, I7: a hung history check must not hang approval — it counts as "could not
    // be read" once it exceeds CONTACT_HISTORY_TIMEOUT_MS.
    it("a recipient check that never resolves times out and locks", async () => {
      vi.useFakeTimers();
      try {
        const f = fakeDeps({ "saga/gmail": "autonomous" });
        const neverResolves: ContactHistory = () => new Promise(() => {});
        const promise = decideApproval(
          { agent: "saga", tool: "gmail_send", capability: "gmail", startingLevel: "gated", toolInput: { to: ["person@example.com"] }, contactHistory: neverResolves },
          f.deps,
        );
        await vi.advanceTimersByTimeAsync(CONTACT_HISTORY_TIMEOUT_MS + 1);
        const d = await promise;
        expect(d).toEqual({ status: "user-approval", decision: "locked", reason: "contact history could not be read — asking first" });
      } finally {
        vi.useRealTimers();
      }
    });
  });
  it("fails closed to 'ask' when the table cannot be read", async () => {
    const f = fakeDeps({ "calliope/vault": "throw" });
    expect(await decideApproval(input("vault_write", "vault", "autonomous"), f.deps)).toEqual({
      status: "user-approval", decision: "failed-closed", reason: "the permissions table could not be read — asking first",
    });
  });
  it("caches a level for 30 seconds per agent and capability, then reads again", async () => {
    const f = fakeDeps({ "calliope/vault": "autonomous" });
    await decideApproval(input("vault_write", "vault"), f.deps);
    f.advance(APPROVAL_CACHE_MS - 1);
    await decideApproval(input("vault_write", "vault"), f.deps);
    expect(f.reads).toHaveLength(1);
    f.advance(2);
    await decideApproval(input("vault_write", "vault"), f.deps);
    expect(f.reads).toHaveLength(2);
  });
});

describe("boardApproval — the value a tool puts in `approval`", () => {
  const manifest = {
    name: "calliope", model: "lares-brain", persona: "agent/instructions.md",
    grants: [{ capability: "vault", scope: "write-with-confirm", areas: ["shared"] }], autonomy: { vault: "gated" },
  };
  it("decides from the manifest name and records the decision as evidence", async () => {
    const f = fakeDeps({ "calliope/vault": "autonomous" });
    setBoardDeps(f.deps);
    expect(await boardApproval(manifest, "vault_write")()).toBe("not-applicable");
    await new Promise((r) => setImmediate(r));
    expect(f.events).toEqual([{ tool: "vault_write", decision: "autonomous" }]);
  });
  it("an unknown tool fails closed", async () => {
    setBoardDeps(fakeDeps({}).deps);
    expect(await boardApproval(manifest, "no_such_tool")()).toBe("user-approval");
  });

  // Final review F6: eve consults the policy again when an answered card resumes, with the same
  // callId — the evidence is keyed on it so one card counts once.
  it("records eve's callId with the decision", async () => {
    const f = fakeDeps({ "calliope/vault": "gated" });
    setBoardDeps(f.deps);
    await boardApproval(manifest, "vault_write")({ callId: "call-1" });
    await boardApproval(manifest, "vault_write")();
    await new Promise((r) => setImmediate(r));
    expect(f.callIds).toEqual(["call-1", undefined]);
  });

  // Final review F7: evidence never fails an action — a rejecting record is not an unhandled rejection.
  it("a record that rejects neither fails the call nor leaks an unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    try {
      const f = fakeDeps({ "calliope/vault": "autonomous" });
      setBoardDeps({ ...f.deps, record: async () => { throw new Error("events file not writable"); } });
      expect(await boardApproval(manifest, "vault_write")({ callId: "c" })).toBe("not-applicable");
      expect(await boardApproval(manifest, "no_such_tool")({ callId: "d" })).toBe("user-approval");
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("passes the ctx's toolInput through to the contactHistory check", async () => {
    const gmailManifest = {
      name: "saga", model: "lares-brain", persona: "agent/instructions.md",
      grants: [{ capability: "gmail", scope: "write-with-confirm" }], autonomy: { gmail: "gated" },
    };
    const f = fakeDeps({ "saga/gmail": "autonomous" });
    setBoardDeps(f.deps);
    let seenInput: unknown;
    const contactHistory: ContactHistory = async (_recipient, toolInput) => { seenInput = toolInput; return true; };
    const status = await boardApproval(gmailManifest, "gmail_send", { contactHistory })({ toolInput: { to: ["person@example.com"] } });
    expect(status).toBe("not-applicable");
    expect(seenInput).toEqual({ to: ["person@example.com"] });
  });

  // Fix round 1, I3: eve calls the returned function with NO ctx at all for a non-object call
  // input — that must ask, not read as "no attendees".
  it("calendar_create_event with no ctx at all → locked (fix round 1, I3)", async () => {
    const calendarManifest = {
      name: "saga", model: "lares-brain", persona: "agent/instructions.md",
      grants: [{ capability: "calendar", scope: "write-with-confirm" }], autonomy: { calendar: "gated" },
    };
    const f = fakeDeps({ "saga/calendar": "autonomous" });
    setBoardDeps(f.deps);
    const contactHistory: ContactHistory = async () => true;
    const status = await boardApproval(calendarManifest, "calendar_create_event", { contactHistory })();
    expect(status).toBe("user-approval");
  });
});

// ORB-278 step 2 (Task 5, step 8b): the DEFINITION's level is the approval fallback, not the
// image's. Saga has 16 `ratchet` rows and those still win; Marcel and Calliope have none, so for
// two of the three agents this injected resolver is the only thing deciding.
describe("boardApproval — the definition's level as the fallback (ORB-278 step 2)", () => {
  // The image was built GATED. Every case below proves the injected resolver, not this, decided.
  const gatedManifest = {
    name: "calliope", model: "lares-brain", persona: "agent/persona.md",
    grants: [{ capability: "vault", scope: "write-with-confirm", areas: ["shared"] }], autonomy: { vault: "gated" },
  };

  it("with no ratchet row, a definition saying autonomous lets an ordinary write run without a card", async () => {
    const f = fakeDeps({});
    setBoardDeps(f.deps);
    const status = await boardApproval(gatedManifest, "vault_write", {
      startingLevel: async () => "autonomous",
    })();
    expect(status).toBe("not-applicable");
    await new Promise((r) => setImmediate(r));
    expect(f.events).toEqual([{ tool: "vault_write", decision: "autonomous" }]);
  });

  it("the resolver is asked for the capability, not the tool", async () => {
    setBoardDeps(fakeDeps({}).deps);
    const asked: string[] = [];
    await boardApproval(gatedManifest, "vault_write", {
      startingLevel: async (capability) => { asked.push(capability); return "autonomous"; },
    })();
    expect(asked).toEqual(["vault"]);
  });

  it("a ratchet row saying gated still wins over an autonomous definition", async () => {
    const f = fakeDeps({ "calliope/vault": "gated" });
    setBoardDeps(f.deps);
    const status = await boardApproval(gatedManifest, "vault_write", {
      startingLevel: async () => "autonomous",
    })();
    expect(status).toBe("user-approval");
    await new Promise((r) => setImmediate(r));
    expect(f.events).toEqual([{ tool: "vault_write", decision: "asked" }]);
  });

  it("a startingLevel that rejects makes the call ask, fail-closed", async () => {
    const f = fakeDeps({});
    setBoardDeps(f.deps);
    const status = await boardApproval(gatedManifest, "vault_write", {
      startingLevel: async () => { throw new Error("definition folder unreadable"); },
    })();
    expect(status).toBe("user-approval");
    await new Promise((r) => setImmediate(r));
    // "gated" is what the rejection degrades to, so the recorded decision is an ordinary ask —
    // the agent never acts on a level it could not read.
    expect(f.events).toEqual([{ tool: "vault_write", decision: "asked" }]);
  });

  it("an explicit defaultLevel still outranks the definition — Saga's draft-only writes keep working", async () => {
    const draftManifest = {
      name: "saga", model: "lares-brain", persona: "agent/persona.md",
      grants: [{ capability: "gmail", scope: "write-with-confirm" }], autonomy: { gmail: "gated" },
    };
    setBoardDeps(fakeDeps({}).deps);
    const status = await boardApproval(draftManifest, "gmail_draft", {
      action: "gmail_draft",
      defaultLevel: "autonomous",
      startingLevel: async () => "never",
    })();
    expect(status).toBe("not-applicable");
  });

  // Review finding 3: the level applied must come from the SAME read of the definition the
  // conversation's persona and model came from, or an agent can describe one set of duties while
  // acting on another. eve's ApprovalContext extends SessionContext, so `session.id` is there.
  it("passes eve's session id to the resolver, so one conversation shares one definition", async () => {
    setBoardDeps(fakeDeps({}).deps);
    const seen: (string | undefined)[] = [];
    const approval = boardApproval(gatedManifest, "vault_write", {
      startingLevel: async (_capability, sessionId) => { seen.push(sessionId); return "autonomous"; },
    });
    await approval({ session: { id: "sess-1" }, callId: "c1" });
    await approval({ session: { id: "sess-2" }, callId: "c2" });
    // No session context at all (a direct call, or a future eve that omits it) must still work.
    await approval();
    expect(seen).toEqual(["sess-1", "sess-2", undefined]);
  });

  it("with no startingLevel at all, the manifest's own level still decides (today's behaviour)", async () => {
    setBoardDeps(fakeDeps({}).deps);
    expect(await boardApproval(gatedManifest, "vault_write")()).toBe("user-approval");
  });
});
