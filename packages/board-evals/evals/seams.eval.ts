// ORB-278 / LAR-5 step 2, Task 1. Not a behaviour test: a MEASUREMENT of eve 0.32's dynamic seams,
// committed so it can be re-run against a later eve. Each question records a verdict and the eval
// keeps going, so one run answers all five even when one is NO; any NO fails the run at the end.
//
// The eval harness has no accessor for the model's tool set or the resolved system prompt (see
// EveEvalTurn in eve/dist/src/evals/types.d.ts: message, data, events, inputRequests, toolCalls,
// sessionId, status). So the fixture's mock model reports both back in its reply — mockModel's
// request view carries `tools` and the system `messages` exactly as eve handed them over.
//
// Every question that depends on a `session.started` resolver uses its own `await t.session()`:
// the grants file is read once per session, so a fresh session is the only way to change the
// answer.
import { writeFileSync } from "node:fs";
import { defineEval } from "eve/evals";

interface Verdict {
  readonly q: string;
  readonly yes: boolean;
  readonly evidence: string;
}

export default defineEval({
  async test(t) {
    const GRANTS = process.env["SEAM_GRANTS"];
    if (GRANTS === undefined) throw new Error("seams eval: SEAM_GRANTS is not set");
    const grant = (names: string[]) => writeFileSync(GRANTS, JSON.stringify(names));

    const verdicts: Verdict[] = [];
    const record = (q: string, yes: boolean, evidence: string) => {
      verdicts.push({ q, yes, evidence });
      t.log(`${q}: ${yes ? "YES" : "NO"} — ${evidence}`);
    };

    try {
      // ── Q1 + Q2 ──────────────────────────────────────────────────────────────────────────────
      // A session.started resolver returning a Record produces exactly those tools; an authored
      // agent/tools/<name>.ts of the same name is overridden, not duplicated.
      grant(["cat_alpha", "vault_write"]);
      const s1 = await t.session();
      const tools = (await s1.send("seam tools")).message ?? "";
      const described = (await s1.send("seam describe vault_write")).message ?? "";
      t.log(`Q1/Q2 tool set: ${tools}`);
      t.log(`Q1 vault_write: ${described}`);

      record(
        "Q1a granted catalogue tool present",
        tools.includes(" cat_alpha") || tools.includes("TOOLS cat_alpha"),
        `tool set = ${tools}`,
      );
      record(
        "Q1b authored tool overridden, not duplicated",
        described.includes("count=1") && described.includes("Catalogue's own vault_write"),
        described,
      );
      record(
        "Q2 ungranted catalogue tool absent",
        !tools.includes("cat_beta"),
        `cat_beta ${tools.includes("cat_beta") ? "PRESENT" : "absent"} in ${tools}`,
      );

      // The override is behavioural, not cosmetic: the catalogue's executor answers, and the
      // authored file's board approval no longer applies.
      const overridden = await s1.send("seam call vault_write");
      const overriddenOut = JSON.stringify(
        overridden.toolCalls.find((c) => c.name === "vault_write")?.output ?? null,
      );
      record(
        "Q1c the catalogue's executor answers vault_write",
        overriddenOut.includes("catalogue"),
        `vault_write output = ${overriddenOut}`,
      );

      // ── Q3 ───────────────────────────────────────────────────────────────────────────────────
      // A catalogue key carrying a mounted extension's reserved prefix, while that extension's own
      // slot is a disableTool() sentinel.
      grant(["probe__probe_extension_tool"]);
      const s3 = await t.session();
      const tools3 = (await s3.send("seam tools")).message ?? "";
      t.log(`Q3 tool set: ${tools3}`);
      record(
        "Q3a the probe mount is live (control)",
        tools3.includes("probe__probe_live_tool"),
        `probe__probe_live_tool ${tools3.includes("probe__probe_live_tool") ? "present" : "ABSENT"}`,
      );
      const described3 = (await s3.send("seam describe probe__probe_extension_tool")).message ?? "";
      record(
        "Q3b the prefixed catalogue key appears exactly once",
        described3.includes("count=1"),
        described3,
      );
      const probed = await s3.send("seam call probe__probe_extension_tool");
      const probeOut = JSON.stringify(
        probed.toolCalls.find((c) => c.name === "probe__probe_extension_tool")?.output ?? null,
      );
      record(
        "Q3c the catalogue's copy answers, not the extension's",
        probeOut.includes("catalogue"),
        `probe__probe_extension_tool output = ${probeOut}`,
      );

      // ── Q4 ───────────────────────────────────────────────────────────────────────────────────
      // A value written to eve session state in a tool call survives to the next turn's instruction
      // resolver, and stays out of other sessions.
      grant([]);
      const s4 = await t.session();
      const set = await s4.send("seam lang no");
      t.log(`Q4 set: ${set.message ?? ""}`);
      const system = (await s4.send("seam system")).message ?? "";
      t.log(`Q4 system prompt on the NEXT turn: ${system}`);
      record(
        "Q4a the next turn's instruction resolver sees the stored value",
        system.includes("SEAM_LANG=no"),
        system,
      );
      const readBack = await s4.send("seam call seam_language");
      const readOut = JSON.stringify(
        readBack.toolCalls.find((c) => c.name === "seam_language")?.output ?? null,
      );
      record(
        "Q4b the value survives the turn boundary",
        readOut.includes('"no"'),
        `seam_language output = ${readOut}`,
      );

      const s4b = await t.session();
      const other = await s4b.send("seam call seam_language");
      const otherOut = JSON.stringify(
        other.toolCalls.find((c) => c.name === "seam_language")?.output ?? null,
      );
      const otherSystem = (await s4b.send("seam system")).message ?? "";
      t.log(`Q4 other session system prompt: ${otherSystem}`);
      record(
        "Q4c the value does not leak to another session",
        otherOut.includes('"en"') && otherSystem.includes("SEAM_LANG=en"),
        `other session: ${otherOut}, ${otherSystem}`,
      );

      // ── Task 6 ───────────────────────────────────────────────────────────────────────────────
      // The REAL language switch (packages/agent-kit/src/language.ts, wired through
      // agent/tools/set_language.ts + agent/instructions/language_switch.ts above) — not the
      // generic Q4 fixture, which proves the SEAM exists but never touches
      // `languageInstruction`/`LANGUAGE_STATE_KEY` at all. This proves the actual production
      // module's text and key work end to end through the same seam: a tool call in one turn
      // reaches the NEXT turn's real language instruction, and a second session never sees it —
      // the two properties Task 6's brief states as the ones that matter ("the definition never
      // changes" / "the choice dies with the conversation").
      grant([]);
      const s6 = await t.session();
      const setLang = await s6.send("seam setlang en");
      t.log(`Task 6 set_language: ${setLang.message ?? ""}`);
      const system6 = (await s6.send("seam system")).message ?? "";
      t.log(`Task 6 system prompt on the NEXT turn: ${system6}`);
      record(
        "Task 6a set_language's write reaches the NEXT turn's real language instruction",
        system6.includes("Write in en for this conversation") && system6.includes("## Language"),
        system6,
      );

      const s6b = await t.session();
      const system6b = (await s6b.send("seam system")).message ?? "";
      t.log(`Task 6 second session's system prompt: ${system6b}`);
      record(
        "Task 6b a second session never sees the first session's language switch",
        !system6b.includes("## Language") && !system6b.includes("Write in en for this conversation"),
        system6b,
      );

      // ── Q5 ───────────────────────────────────────────────────────────────────────────────────
      // `model: definitionModel({ resolveAlias, provider })` in agent.ts — does the selection take
      // effect at runtime? (Whether it COMPILES is answered by `pnpm exec eve build`, recorded in
      // the research note.)
      //
      // REWORKED for eve 0.60.1, not just re-run: the original three probes assumed `defineDynamic`
      // still had a `fallback` and that `session.started` could return either a provider object or a
      // model-id string. Neither is true any more, and the ground shifted enough that two of the
      // three probes cannot be asked the same way:
      //
      //   - `alt_model_object` ("session.started refuses a provider object, degrades to the
      //     fallback") depended on a `session.started` model handler existing at all. It no longer
      //     can: this package runs every eval file against ONE shared agent in one dev process
      //     (evals.config.ts: "All required evals share one local dev process"), so a
      //     `session.started` model handler — whatever it returned — would fire on every session any
      //     eval in this suite creates, not just this probe's. And there is no safe "no-op" return at
      //     that scope: eve's `resolve-model.js` throws on a returned provider object there
      //     unconditionally ("durable model selections must be serializable"), and it throws on a
      //     null/undefined return too ("Dynamic model resolver returned no model"). The ONE value
      //     that scope tolerates is a string — which is `alt_model_id`'s case, below. So keeping a
      //     `session.started` model handler at all, for any reason, would fail Q1–Q4 and Task 6.
      //   - `alt_model_id` ("session.started accepts a model ID string and routes the turn to it")
      //     is the forbidden shape itself: this project's rule (packages/agent-kit/src/
      //     definition-model.ts) is that eve must never be handed a bare model-id string, anywhere,
      //     because eve resolves one through the Vercel AI Gateway, bypassing the self-hosted LiteLLM
      //     gateway. Proving eve "still honors" that string would mean this codebase carries a live
      //     path that does exactly the thing the rule exists to prevent — in a test fixture, but a
      //     real attempted gateway call all the same. Kept only as a comment, not as running code.
      //
      // Both are DROPPED, not ported. What survives is `alt_model_step` — the one scope
      // (`step.started`) a live provider object is legal in — now reached through `definitionModel`,
      // the same step.started-only helper the three role services use. That also means the model
      // resolver reads the same per-session definition the tools/instructions resolvers read
      // (`fixtureDefinition`), so `definition.eval.ts`'s repair-race proof still exercises the model
      // side exactly as it did before this rework.
      const reply = async (flag: string): Promise<string> => {
        grant([flag]);
        const s = await t.session();
        try {
          const turn = await s.send("seam tools");
          const failures = turn.events.flatMap((e) =>
            e.type === "turn.failed" ? [`${e.data.code} :: ${e.data.message}`] : [],
          );
          const detail = failures.length === 0 ? "" : ` FAILED(${failures.join(" | ")})`;
          return `[${turn.status}] ${turn.message ?? "<no message>"}${detail}`;
        } catch (error) {
          return `[threw] ${error instanceof Error ? error.message : String(error)}`;
        }
      };
      const served = (r: string, by: "ALT-MODEL:" | "TOOLS ") => r.includes(by);

      const viaStep = await reply("alt_model_step");
      t.log(`Q5 step.started → provider object: ${viaStep.slice(0, 200)}`);
      record(
        "Q5a step.started may return a provider object",
        served(viaStep, "ALT-MODEL:"),
        `reply = ${viaStep.slice(0, 200)}`,
      );

      grant([]);
      const s5b = await t.session();
      const back = (await s5b.send("seam tools")).message ?? "";
      record(
        "Q5b no override flag granted — step.started serves the default (scripted) model",
        back.startsWith("TOOLS "),
        `reply = ${back.slice(0, 80)}`,
      );
    } finally {
      // board.eval.ts shares this agent. An empty catalogue is the state it needs, whatever happened
      // above.
      grant([]);
    }

    const failed = verdicts.filter((v) => !v.yes);
    t.log(`SEAMS SUMMARY: ${verdicts.map((v) => `${v.q}=${v.yes ? "YES" : "NO"}`).join(", ")}`);
    if (failed.length > 0) {
      throw new Error(`seams eval: ${failed.map((v) => `${v.q} → NO (${v.evidence})`).join("; ")}`);
    }
  },
});
