// Which tools an agent actually SHIPS, read off its own folder.
//
// A capability doc's `tools` list is the fleet-wide UNION across every agent that grants the
// capability — `calendar` names all six Google Calendar tools because one agent holds write
// access. Rendered unfiltered
// into a second agent's persona, under "**My only capabilities are the tools below.**", that
// union names tools the agent cannot call: an agent without write access would be told it had
// `calendar_create_event`. Same defect as the under-claiming the
// generated section exists to end, pointing the other way — a persona overclaiming rather than
// underclaiming, which is worse, because the model discovers it by calling something that isn't
// there.
//
// FILESYSTEM NAMES ONLY. Nothing here imports a tool module: this runs inside `eve build`'s own
// build step, where importing an agent's tools would execute their module scope (credential
// reads, clients, side effects) for no reason. The names come from the two directories eve
// itself loads from:
//
//   <agentDir>/agent/tools/<name>.ts                        -> "<name>"
//   <agentDir>/catalogue/<name>.ts                           -> "<name>"
//   <agentDir>/agent/extensions/agent-kit/tools/<name>.ts    -> "agent-kit__<name>"
//
// `catalogue/` is on the list because of ADR-0015 rule 3: a role service's real tools
// are a POOL the definition picks from at session start, reached through one `defineDynamic` in
// agent/tools/catalogue.ts, and what stays in agent/tools/ is the `disableTool()` sentinels plus
// that resolver. Reading only agent/tools/ would drop the pool's tools (`atlas_search`,
// `atlas_read`, `atlas_list`, `atlas_write` and `studio_ideate` for the creative agent) out of the
// persona — the generated section would tell the agent it has no Atlas, the under-claim
// returning by the back door. `index.ts` is excluded because it is the pool's manifest, not a tool.
//
// This is deliberately the NAIVE view, and it is one of two guards rather than the only one. A
// file can be present and still not ship — a `disableTool()` sentinel, or an extension tool the
// declaration's own scope check disables at build time — and this function cannot see either.
// The check that can is in each service's tests/agent-declaration.test.ts, which asserts every
// backticked name in the COMMITTED instructions.md against the compiled manifest `eve build`
// actually wrote. Filesystem first (cheap, runs in the build), compiled manifest second
// (authoritative, runs in the suite).
import { readdirSync } from "node:fs";
import { join } from "node:path";

/** `*.ts` basenames in `dir`, or `[]` when the directory does not exist — an agent with no
 *  extension tools is ordinary, not an error. */
function tsBasenames(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".ts"))
      .map((f) => f.replace(/\.ts$/u, ""));
  } catch {
    return [];
  }
}

/** Every tool name the agent at `agentDir` (the folder holding its `agent.json`) has a file for,
 *  sorted, in the exact spelling eve exposes — extension tools carry the `agent-kit__` prefix.
 *
 *  A FILE COUNT, not a tool count. A `disableTool()` sentinel is a `.ts` file like any other, so
 *  The chief of staff's file names cover the tools `eve build` compiles plus the sentinels it ships to
 *  switch framework and kit tools off. That is harmless for rendering — the extra names simply
 *  never match a capability doc's list — but it is why the CLI's success line says "tool files"
 *  and why the compiled manifest, not this function, is the authority on what shipped. */
export function deployedToolsFor(agentDir: string): string[] {
  // DEDUPED, not just concatenated. A PREFIXED tool a service has
  // moved into its own catalogue names its file `catalogue/agent-kit__<bare>.ts` — the basename
  // is ALREADY the prefixed name, by construction (catalogue/index.ts's own import list) — while
  // its mount file, still present as a disabled sentinel, produces the SAME prefixed name through
  // the third spread's `agent-kit__${n}` mapping. Concatenating both listed `agent-kit__
  // transit_plan` twice: harmless for rendering (a capability doc's list still matches
  // it once), but it fed `assertNoUngatedWrites` the same name twice, and it gets noisier with
  // every prefixed tool a future service moves. A `Set` is the whole fix — nothing here needs to
  // know WHY a name repeated, only that a file count is not obligated to double-count a name two
  // different directories happen to agree on.
  return [
    ...new Set([
      // `catalogue` is excluded on the other side too: agent/tools/catalogue.ts is the POOL'S
      // RESOLVER, not a tool. It has no capability, no description and nothing the model can call —
      // leaving it in made `assertNoUngatedWrites` report it as an unmapped tool, which is the
      // right complaint about the wrong thing.
      ...tsBasenames(join(agentDir, "agent", "tools")).filter((n) => n !== "catalogue"),
      ...tsBasenames(join(agentDir, "catalogue")).filter((n) => n !== "index"),
      ...tsBasenames(join(agentDir, "agent", "extensions", "agent-kit", "tools")).map((n) => `agent-kit__${n}`),
    ]),
  ].sort();
}
