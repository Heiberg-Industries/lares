import { readFileSync, writeFileSync } from "node:fs";
import { defineEval } from "eve/evals";

// A thrown error fails the eval. Everything runs on ONE captured session: `t.send` starts a
// brand-new session on every call, and `respondAll` lives on the session handle. A card is an
// open `interaction` on the turn (eve 1.0; it was an `inputRequest` before), answered with the
// option id "approve" or "deny" (there is no "cancel" any more: a refusal is "deny").
// Most of this eval's state is file-based (BOARD_LEVELS/BOARD_LOG/…), so which
// session a turn runs in would not matter for that — EXCEPT the callId dedup evidence below:
// the mock model's tool-call ids are deterministic PER SESSION (turn/step-indexed), not globally
// unique, so a fresh session per call collides "write no-row"'s callId with "write gated"'s and
// silently misfiles the second consult's "asked" decision as a resumed duplicate of the first
// (measured: both got `mock-tool-call-1-0-1`). One shared session keeps callIds distinct across
// the whole run.
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
      writeFileSync(S, String((skew += 31_000))); // the fixture clock moves with every flip; no decision may depend on it
    };

    board({}); // no row → the agent's own level (autonomous) → runs without asking
    const a = await session.send("write no-row");
    check(a.interactions.length === 0, "no row: expected no card");
    check(log().includes("write no-row"), "no row: expected the write to run");

    board({ vault: "gated" }); // the board says ask
    const b = await session.send("write gated");
    check(b.interactions.length === 1, "gated: expected one card");
    await session.respondAll("approve");
    check(log().includes("write gated"), "gated: expected the write after approval");
    // One card is one piece of evidence: eve consults the policy again on resume, with the SAME callId,
    // and the evidence keeps one row per callId.
    const asked = lines(EVENTS).filter((e) => e.decision === "asked");
    check(asked.length === 1, `gated: expected one 'asked' for one card, got ${asked.length}`);
    check(typeof asked[0]?.callId === "string" && asked[0].callId !== "", "gated: expected eve's callId on the evidence");
    const resumed = lines(`${EVENTS}.resumed`);
    check(resumed.length === 1 && resumed[0]!.callId === asked[0]!.callId, "gated: expected the resumed consult to carry the same callId");
    t.log(`gated → one card, callId ${asked[0]!.callId}, consulted again on resume with the same id`);

    board({ vault: "never" }); // refused, never run
    const c = await session.send("write never");
    check(c.interactions.length === 0, "never: expected no card");
    check(!log().includes("write never"), "never: the write must not run");
    // The refusal reaches the model as the call's result (the scripted model's own reply is only "DONE:…").
    const refused = JSON.stringify(c.toolCalls.find((call) => call.name === "vault_write")?.output ?? null);
    check(refused.includes("switched off"), "never: expected the board's reason relayed to the model");
    t.log(`never → the model was told: ${refused}`);

    board({ vault: "autonomous", gmail: "autonomous" }); // gmail_send is always-ask: locked
    const d = await session.send("send hello");
    check(d.interactions.length === 1, "always-ask: expected a card despite autonomous");
    await session.respondAll("deny");
    check(!log().includes("sent:send hello"), "always-ask: denied mail must not send");

    board("{ not json"); // unreadable table → fails closed to ask, even though the agent's own level is autonomous
    const e = await session.send("write closed");
    check(e.interactions.length === 1, "fail closed: expected a card");
    await session.respondAll("deny");
    check(!log().includes("write closed"), "fail closed: a denied write must not run");

    // A failed read leaves nothing behind: recovery works without moving the fixture clock.
    writeFileSync(L, JSON.stringify({ vault: "autonomous" }));
    const recovered = await session.send("write recovered");
    check(recovered.interactions.length === 0 && log().includes("write recovered"), "a failed read was remembered, or recovery did not run");
    // THERE IS NO CACHE. The board is read fresh for every decision, so a level switched to
    // "never" bites on the very NEXT call, with the fixture clock unmoved (the kit dropped its
    // 30-second cache for exactly this: a cached level let a revoked permission run for up to
    // half a minute — packages/agent-kit/src/board-approval.ts, header). This check used to
    // assert the opposite, that the stale level still ran until the cache expired.
    writeFileSync(L, JSON.stringify({ vault: "never" }));
    const revoked = await session.send("write revoked");
    check(revoked.interactions.length === 0, "revoked: expected no card");
    check(!log().includes("write revoked"), "a level switched to never did not take effect on the next decision");
    // And the other way, also with the clock unmoved: what the board says now is what applies now.
    writeFileSync(L, JSON.stringify({ vault: "autonomous" }));
    const restored = await session.send("write restored");
    check(restored.interactions.length === 0 && log().includes("write restored"), "a level switched back to autonomous did not take effect on the next decision");
    board({ vault: "never" });
    await session.send("write after-clock-moved");
    check(!log().includes("write after-clock-moved"), "the board flip was ignored after the clock moved");
    t.log("REQUIRED: board flip, always-ask, no stale level and fail-closed read PASS");
  },
});
