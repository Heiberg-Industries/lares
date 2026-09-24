// Re-enables eve's default `web_search` tool — old Marcel's own web-search capability
// (`anthropic.tools.webSearch_20250305({ maxUses: 3 })`, `services/marcel/lib/brain.ts:144`).
//
// This is the ONLY default eve tool this agent wires. Every other default (bash, read_file,
// write_file, glob, grep, web_fetch, todo, ask_question, agent, load_skill,
// connection_search) is disabled per the Global Constraints
// (docs/superpowers/plans/2026-08-16-eve-marcel-wave.md) — that disabling lands with
// `agent/agent.ts` in Task 10, which is where the agent-level wiring (and the other 10
// `disableTool()` sentinel files) belongs; this file only owns the one re-enable Task 6 is
// responsible for (see the plan's contract-table row 26).
//
// eve-marcel's model is a directly-constructed Anthropic provider
// (`lib/gateway-provider.ts`'s `gatewayModel()`, via `createAnthropic` against the LiteLLM
// `/anthropic` passthrough) — NOT a Vercel AI Gateway model id. Per eve's own docs
// (`node_modules/eve/docs/concepts/default-harness.md`): "`web_search` requires a supported
// model provider" and "Direct provider models continue to use their native search
// implementation" — the `provider` option below only takes effect for AI Gateway models, so
// leaving the built-in default untouched would ALREADY give Marcel Anthropic's own native web
// search, identical to old Marcel's explicit tool call. This file exists anyway, per "Override
// a default" in that same doc, to make the decision explicit and auditable in code rather than
// an accidental omission that happens to produce the right behavior.
// eve 0.45.0 moved the provided tool definitions off `eve/tools` and onto dedicated
// `eve/tools/*` entrypoints (CHANGELOG 0.45.0, b3cf8ee + 6252784). Same function, same
// `{ provider }` input, same `WebSearchToolDefinition` result — 0.60.1's own docstring shows
// this exact import (`node_modules/eve/dist/src/tools/provided/web-search.d.ts`).
import { webSearch } from "eve/tools/web_search";

export default webSearch({ provider: "exa" });
