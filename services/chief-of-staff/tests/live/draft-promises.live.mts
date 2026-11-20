/**
 * LIVE: does a real model leave `[confirm: …]` markers instead of promising a date or a price?
 *
 * The deterministic half of this eval (the prompt carries the rule, the grader is right) is
 * tests/draft-promises.test.ts and runs in `pnpm test`. This is the half that needs the writer
 * model: it drafts a reply to the invented extension thread N times through the SAME prompt
 * both drafters use (`buildReplyPrompt`) and grades each draft with `gradeDraft`.
 *
 * Run by hand, from a place that has the gateway key (same setup as draft-compare.live.mts):
 *   node --import tsx tests/live/draft-promises.live.mts [--runs 5]
 * Exit 0 only when EVERY run passes. Costs `runs` writer calls.
 */
import { buildReplyPrompt } from "../../lib/reply-prompt.js";
import { gatewayComplete } from "../../lib/llm-complete.js";
import { splitDraft } from "../../lib/email-triage.js";
import { EXTENSION_THREAD, gradeDraft } from "../support/draft-promises.js";

const runsArg = process.argv.indexOf("--runs");
const runs = runsArg > -1 ? Number(process.argv[runsArg + 1]) || 5 : 5;

const prompt = buildReplyPrompt({
  account: "owner@project.example", lang: "en", voiceBlock: "", examples: [], contextBlocks: "",
  closing: 'End with a short, warm closing and your first name only (e.g. "Best, <first name>").',
  ownerName: "the owner",
  original: { from: EXTENSION_THREAD.from, subject: EXTENSION_THREAD.subject, body: EXTENSION_THREAD.body },
});

let failed = 0;
for (let n = 1; n <= runs; n++) {
  const draft = await gatewayComplete(prompt, { model: process.env["DRAFT_MODEL"] ?? "writer", purpose: "writer" });
  const { body } = splitDraft(draft, EXTENSION_THREAD.subject);
  const g = gradeDraft(body);
  if (!g.pass) failed++;
  console.log(`--- run ${n}: ${g.pass ? "PASS" : "FAIL"} ${g.problems.join("; ")}\n${body}\n`);
}
console.log(`${runs - failed}/${runs} passed`);
process.exit(failed === 0 ? 0 : 1);
