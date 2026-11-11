// Not a behaviour test: a MEASUREMENT of eve's dynamic seams, committed so it can be re-run against
// a later eve (first measured on 0.32, re-measured on 0.60.1 and on 1.0.0-rc.9). Each question
// records a verdict and the eval keeps going, so one run answers every question even when one is
// NO; any NO fails the run at the end.
//
// The eval harness has no accessor for the model's tool set or the resolved system prompt (see
// EveEvalTurn in eve/dist/src/evals/types.d.ts: reply, data, events, interactions, toolCalls,
// sessionId, status, view). So the fixture's mock model reports both back in its reply —
// mockModel's request view carries `tools` and the system `messages` exactly as eve handed them
// over.
//
// Every question that depends on the tool catalogue uses its own `await t.session()`: the catalogue
// resolver decides once per conversation (a memo keyed on the session id), so a fresh session is
// the only way to change the answer.
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
      // ── Tool set and overrides ──────────────────────────────────────────────────────────────────────────────
      // A dynamic tools resolver returning a Record produces exactly those tools; an authored
      // agent/tools/<name>.ts of the same name is overridden, not duplicated.
      grant(["cat_alpha", "vault_write"]);
      const s1 = await t.session();
      const tools = (await s1.send("seam tools")).reply ?? "";
      const described = (await s1.send("seam describe vault_write")).reply ?? "";
      t.log(`Tool set: ${tools}`);
      t.log(`vault_write: ${described}`);

      record(
        "Tool set: granted catalogue tool present",
        tools.includes(" cat_alpha") || tools.includes("TOOLS cat_alpha"),
        `tool set = ${tools}`,
      );
      record(
        "Tool set: authored tool overridden, not duplicated",
        described.includes("count=1") && described.includes("Catalogue's own vault_write"),
        described,
      );
      record(
        "Tool set: ungranted catalogue tool absent",
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
        "Tool set: the catalogue's executor answers vault_write",
        overriddenOut.includes("catalogue"),
        `vault_write output = ${overriddenOut}`,
      );

      // ── Prefixed catalogue key ───────────────────────────────────────────────────────────────────────────────────
      // A catalogue key carrying a mounted extension's reserved prefix, while that extension's own
      // slot is a disableTool() sentinel.
      grant(["probe__probe_extension_tool"]);
      const s3 = await t.session();
      const tools3 = (await s3.send("seam tools")).reply ?? "";
      t.log(`Prefixed-key tool set: ${tools3}`);
      record(
        "Prefixed key: the probe mount is live (control)",
        tools3.includes("probe__probe_live_tool"),
        `probe__probe_live_tool ${tools3.includes("probe__probe_live_tool") ? "present" : "ABSENT"}`,
      );
      const described3 = (await s3.send("seam describe probe__probe_extension_tool")).reply ?? "";
      record(
        "Prefixed key: the prefixed catalogue key appears exactly once",
        described3.includes("count=1"),
        described3,
      );
      const probed = await s3.send("seam call probe__probe_extension_tool");
      const probeOut = JSON.stringify(
        probed.toolCalls.find((c) => c.name === "probe__probe_extension_tool")?.output ?? null,
      );
      record(
        "Prefixed key: the catalogue's copy answers, not the extension's",
        probeOut.includes("catalogue"),
        `probe__probe_extension_tool output = ${probeOut}`,
      );

      // ── Session state ───────────────────────────────────────────────────────────────────────────────────
      // A value written to eve session state in a tool call reaches the instruction resolver on
      // the next turn, and stays out of other sessions.
      grant([]);
      const s4 = await t.session();
      const set = await s4.send("seam lang no");
      t.log(`Session state set: ${set.reply ?? ""}`);
      const system = (await s4.send("seam system")).reply ?? "";
      t.log(`Session state, system prompt on the NEXT turn: ${system}`);
      record(
        "Session state: the next turn's instruction resolver sees the stored value",
        system.includes("SEAM_LANG=no"),
        system,
      );
      const readBack = await s4.send("seam call seam_language");
      const readOut = JSON.stringify(
        readBack.toolCalls.find((c) => c.name === "seam_language")?.output ?? null,
      );
      record(
        "Session state: the value survives the turn boundary",
        readOut.includes('"no"'),
        `seam_language output = ${readOut}`,
      );

      const s4b = await t.session();
      const other = await s4b.send("seam call seam_language");
      const otherOut = JSON.stringify(
        other.toolCalls.find((c) => c.name === "seam_language")?.output ?? null,
      );
      const otherSystem = (await s4b.send("seam system")).reply ?? "";
      t.log(`Session state, other session system prompt: ${otherSystem}`);
      record(
        "Session state: the value does not leak to another session",
        otherOut.includes('"en"') && otherSystem.includes("SEAM_LANG=en"),
        `other session: ${otherOut}, ${otherSystem}`,
      );

      // ── Language switch ───────────────────────────────────────────────────────────────────────────────
      // The REAL language switch (packages/agent-kit/src/language.ts, wired through
      // agent/tools/set_language.ts + agent/instructions/language_switch.ts above) — not the
      // generic session-state fixture, which proves the SEAM exists but never touches
      // `languageInstruction`/`LANGUAGE_STATE_KEY` at all. This proves the actual production
      // module's text and key work end to end through the same seam: a tool call in one turn
      // reaches the NEXT turn's real language instruction, and a second session never sees it —
      // the two properties that matter ("the definition never
      // changes" / "the choice dies with the conversation").
      grant([]);
      const s6 = await t.session();
      const setLang = await s6.send("seam setlang en");
      t.log(`Language switch, set_language: ${setLang.reply ?? ""}`);
      const system6 = (await s6.send("seam system")).reply ?? "";
      t.log(`Language switch, system prompt on the NEXT turn: ${system6}`);
      record(
        "Language switch: set_language's write reaches the NEXT turn's real language instruction",
        system6.includes("Write in en for this conversation") && system6.includes("## Language"),
        system6,
      );

      const s6b = await t.session();
      const system6b = (await s6b.send("seam system")).reply ?? "";
      t.log(`Language switch, second session's system prompt: ${system6b}`);
      record(
        "Language switch: a second session never sees the first session's language switch",
        !system6b.includes("## Language") && !system6b.includes("Write in en for this conversation"),
        system6b,
      );

      // ── Model selection ───────────────────────────────────────────────────────────────────────────────────
      // `model: definitionModel({ resolveAlias, provider })` in agent.ts — does the selection take
      // effect at runtime? (Whether it COMPILES is answered by `pnpm exec eve build`.)
      //
      // The selection is always a provider OBJECT, chosen by the dynamic model function eve runs
      // before every model call and pinned per conversation by `definitionModel`, the helper the
      // role services use. The 0.32-era probes that handed eve a model-id STRING are gone and stay
      // gone: this project's rule (packages/agent-kit/src/definition-model.ts) is that eve must
      // never be handed a bare model id, because eve resolves one through a hosted model gateway
      // instead of the installation's own. Nothing in this fixture attempts that, and
      // agent/instrumentation.ts makes the default provider refuse if anything ever did.
      //
      // The model resolver reads the same per-session definition the tools and instructions
      // resolvers read (`fixtureDefinition`), so `definition.eval.ts`'s repair-race proof
      // exercises the model side too.
      const reply = async (flag: string): Promise<string> => {
        grant([flag]);
        const s = await t.session();
        try {
          const turn = await s.send("seam tools");
          const failures = turn.events.flatMap((e) =>
            e.type === "turn.settled" && e.data.outcome === "failed"
              ? [`${e.data.error?.code ?? "<no code>"} :: ${e.data.error?.message ?? "<no message>"}`]
              : [],
          );
          const detail = failures.length === 0 ? "" : ` FAILED(${failures.join(" | ")})`;
          return `[${turn.status}] ${turn.reply ?? "<no message>"}${detail}`;
        } catch (error) {
          return `[threw] ${error instanceof Error ? error.message : String(error)}`;
        }
      };
      const served = (r: string, by: "ALT-MODEL:" | "TOOLS ") => r.includes(by);

      const viaStep = await reply("alt_model_step");
      t.log(`Model selection, dynamic model → provider object: ${viaStep.slice(0, 200)}`);
      record(
        "Model selection: the dynamic model may return a provider object",
        served(viaStep, "ALT-MODEL:"),
        `reply = ${viaStep.slice(0, 200)}`,
      );

      grant([]);
      const s5b = await t.session();
      const back = (await s5b.send("seam tools")).reply ?? "";
      record(
        "Model selection: no override flag granted — the default (scripted) model serves",
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
