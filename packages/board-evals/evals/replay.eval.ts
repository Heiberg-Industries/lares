// THE REPLAY PROOF (ADR-0015 rule 4).
//
// The seam probes establish that a dynamic tools resolver's map becomes the model's tool set. They
// do not establish that a tool reaching the model ONLY that way still behaves like an authored tool
// once real work is involved: that its own approval decides whether a card appears, and that its
// executor is still there after the turn has paused on that card. A resolver-emitted tool that
// lost its approval would ship every gated write in the fleet with no card, so it is measured
// here rather than read.
//
// WHAT "REPLAY" MEANS ON EVE 1.0. A dynamic tool is never kept live. eve runs the resolver before
// every ordinary model call, "including when a turn continues after ... an approval"
// (eve/docs/dynamic-configuration/index.md): the saved part is the memo (here, the granted
// names), and the tool objects, with their approvals and executors, are rebuilt from it by ordinary
// code each time. So every call is already a rebuild, and the approval pause is a rebuild across a
// durable boundary. (On 0.60.1 the same point was proven through stored metadata and registered
// step functions; the mechanism changed, the question did not.)
//
// TWO CASES, and the first is what makes the second mean anything. "A card appeared" is equally
// consistent with the tool's own approval having decided and with a tool that always asks. Only
// the autonomous case can tell them apart:
//
//   1. board says `vault: autonomous` -> the pool tool's own `boardApproval` is consulted, answers
//      "no card", and the executor runs. The approval really is the tool's.
//   2. board says `vault: gated` -> one card; approve; the executor runs afterwards, once. The
//      executor really did survive the pause.
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
    let skew = 1_000_000; // well past board.eval.ts's own skew; the board is read fresh for every decision
    const board = (levels: object): void => {
      writeFileSync(L, JSON.stringify(levels));
      writeFileSync(S, String((skew += 31_000)));
    };
    const calls = (): number =>
      readFileSync(LOG, "utf8").split("\n").filter((l) => l === "pool-vault-list").length;

    // The grant has to be in place BEFORE the first send: the resolver decides once per conversation.
    writeFileSync(G, JSON.stringify(["vault_list"]));
    try {
      // The tool exists at all, and it is the POOL's copy — description carried across by the
      // resolver, not invented by it.
      const set = await t.send("seam describe vault_list");
      check(
        /count=1/u.test(set.reply ?? "") && (set.reply ?? "").includes("List notes (pool fixture)."),
        `pool tool absent or not the pool's copy — ${set.reply ?? "<no message>"}`,
      );
      t.log(`[replay] the pool tool reached the model: ${set.reply ?? ""}`);

      // CASE 1 — autonomous. A tool that always asks, or one whose own approval was dropped on the
      // way through the resolver and replaced, would show a card here.
      board({ vault: "autonomous" });
      const before = calls();
      const a = await t.send("seam call vault_list");
      check(a.interactions.length === 0, "autonomous: a card appeared — the approval in force is not the pool tool's own");
      check(calls() === before + 1, `autonomous: the pool executor did not run — reply ${JSON.stringify(a.reply ?? null)}, status ${a.status}, call ${JSON.stringify(a.toolCalls.find((c) => c.name === "vault_list") ?? null)}`);
      check((a.reply ?? "").includes('"from":"pool"'), `autonomous: the POOL's executor did not answer — ${a.reply ?? "<no message>"}`);
      t.log(`[replay] autonomous -> no card, the pool executor answered: ${a.reply ?? ""}`);

      // CASE 2 — gated -> pause -> approve. The executor has to be rebuilt for the resumed turn.
      board({ vault: "gated" });
      const gatedBefore = calls();
      const b = await t.send("seam call vault_list");
      check(b.interactions.length === 1, "gated: expected exactly one card from the pool tool's own approval");
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
