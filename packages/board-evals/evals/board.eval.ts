import { readFileSync, writeFileSync } from "node:fs";
import { defineEval } from "eve/evals";

// A thrown error fails the eval — the same `send` / `respondAll` / `inputRequests` API the spike
// used, now called on ONE captured session rather than on `t` directly.
//
// `t.send` now starts a brand-new session on every call (eve 0.59's eval API: "Create a new
// session with its first message"), and `respondAll` moved off the shared context onto the
// session handle. Most of this eval's state is file-based (BOARD_LEVELS/BOARD_LOG/…), so which
// session a turn runs in would not matter for that — EXCEPT the callId dedup evidence below:
// the mock model's tool-call ids are deterministic PER SESSION (turn/step-indexed), not globally
// unique, so a fresh session per call collides "write no-row"'s callId with "write gated"'s and
// silently misfiles the second consult's "asked" decision as a resumed duplicate of the first
// (measured: both got `mock-tool-call-1-0-1`). One shared session, exactly like eve's 0.32 `t.send`
// implicitly gave this eval, keeps callIds distinct across the whole run.
function check(ok: boolean, what: string): void {
  if (!ok) throw new Error(`board eval: ${what}`);
}

export default defineEval({
  async test(t) {
    const session = await t.session();
    const L = process.env.BOARD_LEVELS!, S = process.env.BOARD_SKEW!, LOG = process.env.BOARD_LOG!;
    const log = () => readFileSync(LOG, "utf8");
    const lines = (file: string): Array<{ decision: string; callId?: string }> => {
      try {
        return readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
      } catch {
        return [];
      }
    };
    const EVENTS = process.env.BOARD_EVENTS!;
    let skew = 0;
    const board = (levels: object | string) => {
      writeFileSync(L, typeof levels === "string" ? levels : JSON.stringify(levels));
      writeFileSync(S, String((skew += 31_000))); // past the 30 s cache
    };

    board({}); // no row → the agent's own level (autonomous) → runs without asking
    const a = await session.send("write no-row");
    check((a.inputRequests ?? []).length === 0, "no row: expected no card");
    check(log().includes("write no-row"), "no row: expected the write to run");

    board({ atlas: "gated" }); // the board says ask
    const b = await session.send("write gated");
    check((b.inputRequests ?? []).length === 1, "gated: expected one card");
    await session.respondAll("approve");
    check(log().includes("write gated"), "gated: expected the write after approval");
    // One card is one piece of evidence: eve consults the policy again on resume, with the SAME callId,
    // and the evidence keeps one row per callId (final review F6).
    const asked = lines(EVENTS).filter((e) => e.decision === "asked");
    check(asked.length === 1, `gated: expected one 'asked' for one card, got ${asked.length}`);
    check(typeof asked[0]?.callId === "string" && asked[0].callId !== "", "gated: expected eve's callId on the evidence");
    const resumed = lines(`${EVENTS}.resumed`);
    check(resumed.length === 1 && resumed[0]!.callId === asked[0]!.callId, "gated: expected the resumed consult to carry the same callId");
    t.log(`gated → one card, callId ${asked[0]!.callId}, consulted again on resume with the same id`);

    board({ atlas: "never" }); // refused, never run
    const c = await session.send("write never");
    check((c.inputRequests ?? []).length === 0, "never: expected no card");
    check(!log().includes("write never"), "never: the write must not run");
    // The refusal reaches the model as the call's result (the scripted model's own reply is only "DONE:…").
    const refused = JSON.stringify(c.toolCalls.find((call) => call.name === "vault_write")?.output ?? null);
    check(refused.includes("switched off"), "never: expected the board's reason relayed to the model");
    t.log(`never → the model was told: ${refused}`);

    board({ atlas: "autonomous", gmail: "autonomous" }); // gmail_send is always-ask: locked
    const d = await session.send("send hello");
    check((d.inputRequests ?? []).length === 1, "always-ask: expected a card despite autonomous");
    await session.respondAll("cancel");
    check(!log().includes("sent:send hello"), "always-ask: cancelled mail must not send");

    board("{ not json"); // unreadable table → fails closed to ask, even though the agent's own level is autonomous
    const e = await session.send("write closed");
    check((e.inputRequests ?? []).length === 1, "fail closed: expected a card");
    await session.respondAll("cancel");

    // Failed reads are not cached; recovery must work without moving the fixture clock.
    writeFileSync(L, JSON.stringify({ atlas: "autonomous" }));
    const recovered = await session.send("write recovered");
    check((recovered.inputRequests ?? []).length === 0 && log().includes("write recovered"), "failed read was cached or recovery did not run");
    writeFileSync(L, JSON.stringify({ atlas: "never" }));
    const cached = await session.send("write cached");
    check((cached.inputRequests ?? []).length === 0 && log().includes("write cached"), "30-second cache was bypassed");
    board({ atlas: "never" });
    await session.send("write expired-cache");
    check(!log().includes("write expired-cache"), "expired cache ignored the board flip");
    t.log("REQUIRED: board flip, always-ask, cache and fail-closed read PASS");
  },
});
