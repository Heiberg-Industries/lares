// A scripted model: "write …" calls vault_write, "send …" calls gmail_send — once per message — then
// answers in plain text. No real model, no gateway, no cost. Each message calls its tool exactly once:
// a refused or cancelled call returns no `written` output, so "call until a result appears" would
// loop, and the model instead remembers which messages it has already acted on.
//
// The `seam …` messages are the measurement surface for the dynamic-seams eval. eve's eval harness
// exposes a turn's `.message`, `.toolCalls`, `.inputRequests` and `.events` but NOT the model's tool
// set or the resolved system prompt — so the model reports them back. `mockModel`'s request view
// carries `tools` (name + description) and `messages` (including the system role), which is the real
// thing the model was handed, not a reconstruction.
import { appendFileSync, existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { definitionModel, resolveDefinitionForModel } from "@lares/agent-kit/definition-model";
import { fixtureDefinition } from "../lib/definition.js";
import { defineAgent } from "eve";
import { mockModel } from "eve/evals";
import { grantedNames } from "../lib/seam-grants.js";

const acted = new Set<string>();

// The seam messages get their OWN memo, keyed by the user-message index as well as the text, because
// several sessions send the identical line and a session-blind `acted` would let the first session's
// memory suppress the second session's tool call. The `write …`/`send …` memo above deliberately
// stays keyed on the text alone: those turns park on approval cards and resume, and the resumed
// model call must still count as "already acted on".
const seamActed = new Set<string>();

const SEAM = "seam ";

const scripted = mockModel(({ lastUserMessage, messages, tools, toolResults, userMessageCount }) => {
  if (process.env.PROOF_MODEL_LOG) appendFileSync(process.env.PROOF_MODEL_LOG, "model-call\n");
  const msg = lastUserMessage ?? "";

  if (msg.startsWith(SEAM)) {
    const rest = msg.slice(SEAM.length);

    // Q1/Q2: the exact tool set this model call was given.
    if (rest === "tools") return `TOOLS ${tools.map((t) => t.name).sort().join(" ")}`;

    // Q1: which copy of a contested name the model is looking at.
    if (rest.startsWith("describe ")) {
      const name = rest.slice("describe ".length);
      const matches = tools.filter((t) => t.name === name);
      return `DESCRIBE ${name} count=${matches.length} ${matches.map((t) => t.description ?? "<none>").join(" | ")}`;
    }

    // Q4: the system prompt as assembled for this call, after the instruction resolvers ran.
    if (rest === "system") return `SYSTEM ${messages.filter((m) => m.role === "system").map((m) => m.text).join(" ¶ ")}`;

    // Q3/Q4: call one tool by name and read its result back. Call FIRST, then report — reading
    // `toolResults` first would find the same tool's result from an EARLIER turn (it stays in the
    // prompt) and answer without calling anything this turn.
    const key = `${userMessageCount}|${msg}`;
    const latest = (name: string) => [...toolResults].reverse().find((r) => r.name === name);

    if (rest.startsWith("call ")) {
      const name = rest.slice("call ".length);
      if (!seamActed.has(key)) {
        seamActed.add(key);
        return { toolCalls: [{ name, input: {} }] };
      }
      const done = latest(name);
      return done ? `RESULT ${name} ${JSON.stringify(done.output)}` : `NORESULT ${name}`;
    }

    // Q4: store a value in session state.
    if (rest.startsWith("lang ")) {
      const lang = rest.slice("lang ".length);
      if (!seamActed.has(key)) {
        seamActed.add(key);
        return { toolCalls: [{ name: "seam_language", input: { set: lang } }] };
      }
      const done = latest("seam_language");
      return done ? `RESULT seam_language ${JSON.stringify(done.output)}` : "NORESULT seam_language";
    }

    // Task 6: call the REAL production-shaped set_language tool, not the seam_language fixture.
    if (rest.startsWith("setlang ")) {
      const lang = rest.slice("setlang ".length);
      if (!seamActed.has(key)) {
        seamActed.add(key);
        return { toolCalls: [{ name: "set_language", input: { language: lang } }] };
      }
      const done = latest("set_language");
      return done ? `RESULT set_language ${JSON.stringify(done.output)}` : "NORESULT set_language";
    }

    return `SEAM? ${rest}`;
  }

  const tool = msg.startsWith("write") ? "vault_write" : msg.startsWith("send") ? "gmail_send" : null;
  if (tool && !acted.has(msg)) {
    acted.add(msg);
    return { toolCalls: [{ name: tool, input: { text: msg } }] };
  }
  return `DONE:${msg}`;
});

// Q5: the same control file the tool catalogue reads selects a different model. A distinct mock is
// the only way to SEE a runtime selection in a fixture with no provider — its reply is unmistakable.
//
// eve 0.60.1 removed `defineDynamic({ fallback, events })`'s `fallback`, and confines a live
// provider-object model selection to `step.started` — a `session.started`/`turn.started` selection
// is "durable" and must be a serializable model-id string, or eve throws
// ("Dynamic model selection returned a provider object, but durable model selections must be
// serializable. Return a model id string, or use a \"step.started\" model resolver."). A declared
// handler returning null now throws too ("Dynamic model resolver returned no model"), so there is no
// scope left where a harmless no-op return is possible for a model resolver.
//
// This agent is shared by every eval file in the package (evals.config.ts: "one local dev process"),
// so a `session.started` model handler — whatever it returned — would run on every session any eval
// creates, not only this one's Q5 probe. Combined with the two throws above, that leaves exactly one
// usable flag:
//   alt_model_step  step.started returning a provider object (an AI SDK LanguageModel)
// The 0.32-era `alt_model_object` and `alt_model_id` flags are retired, not ported — see the Q5
// comment in evals/seams.eval.ts for what each proved and why neither survives on 0.60.1. In
// particular: a model-id STRING at session/turn scope is the one shape this project forbids
// everywhere (eve would route it through the Vercel AI Gateway, bypassing the self-hosted LiteLLM
// gateway — packages/agent-kit/src/definition-model.ts), so no code path here may ever hand eve one.
// No flag ⇒ `resolveAlias` picks "scripted", the same default every other eval in this package relies
// on.
const alternate = mockModel(({ lastUserMessage }) => `ALT-MODEL:${lastUserMessage ?? ""}`);

export default defineAgent({
  // Ported to `definitionModel` — the same step.started-only helper the three role services use
  // (packages/agent-kit/src/definition-model.ts). It pins one alias per session on the first step
  // and reuses it for later steps, and it hands the chosen model to `guardDefinitionModel`
  // internally, so `scripted`/`alternate` are gated on `resolveAlias` having actually completed —
  // the same readiness gate the repair-race proof in definition.eval.ts depends on.
  // `modelContextWindowTokens` is no longer a sibling here: `sessionGatewayModel` (agent-kit) bakes
  // in 200_000 with every selection, which is what "the compaction model has no window of its own"
  // used to require at this level.
  model: definitionModel({
    resolveAlias: async (sessionId) => {
      if (process.env.LARES_DEFINITION_DIR) {
        try { await resolveDefinitionForModel(() => fixtureDefinition(sessionId)); }
        catch (error) {
          // Deterministic repair race: the real resolver already failed. Repair the folder
          // BEFORE eve chooses a model, to prove the failed session remains refused.
          const repair = `${process.env.LARES_DEFINITION_DIR}/repair-on-failure.json`;
          if (existsSync(repair)) {
            writeFileSync(`${process.env.LARES_DEFINITION_DIR}/agent.json`, readFileSync(repair));
            unlinkSync(repair);
          }
          throw error;
        }
      }
      return grantedNames().includes("alt_model_step") ? "alternate" : "scripted";
    },
    provider: (alias) => (alias === "alternate" ? alternate : scripted),
  }),
});
