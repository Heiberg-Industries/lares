// THE REPLAY PROOF for ORB-278 step 2, Task 7 (ADR-0015 rule 4).
//
// Q1 established that a `session.started` resolver's map becomes the model's tool set. It did not
// establish that a tool reaching the model ONLY that way still behaves like an authored tool once
// real work is involved — and eve's own `DynamicToolEntry` docstring says approval is "only honored
// for step-scoped dynamic tools", which, if true, would ship every gated write in the fleet with no
// card. So it is measured here rather than read.
//
// The mechanics that make this worth one eval file: a session-scoped dynamic tool is NOT kept live.
// `dynamic-tool-lifecycle.js` stores serializable metadata for it (`SessionDynamicToolMetadataKey`)
// and registers its executor and its approval as step functions; `build-dynamic-tools.js` rebuilds
// both on every step from that metadata. Every call is therefore already a replay, and the approval
// pause is a replay across a durable boundary.
//
// TWO CASES, and the first is what makes the second mean anything. `buildReplayedApproval` falls
// back to `() => "user-approval"` when the approval step function is missing, so "a card appeared"
// is equally consistent with the approval having survived and with it having been LOST. Only the
// autonomous case can tell them apart:
//
//   1. board says `vault: autonomous` -> the pool tool's own `boardApproval` is consulted, answers
//      "no card", and the executor runs. The approval really was reconstructed.
//   2. board says `vault: gated` -> one card; approve; the executor runs afterwards. The executor
//      really did survive the pause.
import { readFileSync, writeFileSync } from "node:fs";
import { defineEval } from "eve/evals";

function check(ok: boolean, what: string): void {
  if (!ok) throw new Error(`replay eval: ${what}`);
}

export default defineEval({
  async test(t) {
    const G = process.env["SEAM_GRANTS"]!;
    const L = process.env["BOARD_LEVELS"]!;
    const S = process.env["BOARD_SKEW"]!;
    const LOG = process.env["BOARD_LOG"]!;
    let skew = 1_000_000; // well past board.eval.ts's own skew, and past the policy's 30 s cache
    const board = (levels: object): void => {
      writeFileSync(L, JSON.stringify(levels));
      writeFileSync(S, String((skew += 31_000)));
    };
    const calls = (): number =>
      readFileSync(LOG, "utf8").split("\n").filter((l) => l === "pool-vault-list").length;

    // The grant has to be in place BEFORE the first send: the resolver runs once, at session start.
    writeFileSync(G, JSON.stringify(["vault_list"]));
    try {
      // The tool exists at all, and it is the POOL's copy — description carried across by the
      // resolver, not invented by it.
      const set = await t.send("seam describe vault_list");
      check(
        /count=1/u.test(set.message ?? "") && (set.message ?? "").includes("List notes (pool fixture)."),
        `pool tool absent or not the pool's copy — ${set.message ?? "<no message>"}`,
      );
      t.log(`[replay] the pool tool reached the model: ${set.message ?? ""}`);

      // CASE 1 — autonomous. If the approval had been lost across the durable boundary, eve's
      // missing-step fallback would ask here.
      board({ vault: "autonomous" });
      const before = calls();
      const a = await t.send("seam call vault_list");
      check((a.inputRequests ?? []).length === 0, "autonomous: a card appeared — the replayed approval is eve's fallback, not the tool's");
      check(calls() === before + 1, "autonomous: the pool executor did not run");
      check((a.message ?? "").includes('"from":"pool"'), `autonomous: the POOL's executor did not answer — ${a.message ?? "<no message>"}`);
      t.log(`[replay] autonomous -> no card, the pool executor answered: ${a.message ?? ""}`);

      // CASE 2 — gated -> pause -> approve. The executor has to come back from durable metadata.
      board({ vault: "gated" });
      const gatedBefore = calls();
      const b = await t.send("seam call vault_list");
      check((b.inputRequests ?? []).length === 1, "gated: expected exactly one card from the pool tool's own approval");
      check(calls() === gatedBefore, "gated: the executor ran BEFORE the approval was given");
      await b.session.respondAll("approve");
      check(calls() === gatedBefore + 1, "gated: the executor did not run after the approval — it did not survive the replay");
      t.log(`[replay] gated -> one card -> approved -> the pool executor ran (${calls()} calls logged)`);
    } finally {
      // Leave the grants empty, the state board.eval.ts and seams.eval.ts both need.
      writeFileSync(G, "[]");
    }
  },
});
