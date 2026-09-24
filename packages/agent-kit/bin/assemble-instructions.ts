#!/usr/bin/env tsx
// bin/assemble-instructions.ts — the build hook (ORB-145 Phase 2, Task 7).
//
// Phase 3 wires three eve agent services to run this before `eve build`, turning each
// service's OWN agent.json + a SHARED role template + its OWN voice.md into
// `agent/instructions.md` — the one file eve boots the agent's persona from. This file is the
// CLI only; the actual assembly logic is Task 5's `assemblePersona` and Task 6's `lintRole` /
// `assertRoleIsGeneric`, both re-exported from `../src/persona/index.js`.
//
//   tsx bin/assemble-instructions.ts \
//     --agent <dir containing agent.json> --role <role.md> --voice <voice.md> \
//     [--display <display name>] --out <path to write> [--check]
//
// `--display` is optional: without it the name comes from agent.json's own `display`, and
// without that from its `name` (lares repo split, ORB-262 — the display name moved out of
// each service's package.json and into the agent's declaration).
//
// `--check` is the same assembly with the write replaced by a comparison: it exits 0 when the
// file at `--out` is byte-for-byte what this run would have written, and 1 when it differs or
// is missing. It exists because the image build does NOT assemble — services/chief-of-staff's
// Dockerfile runs `pnpm exec eve build` on the COMMITTED tree — so without a check in that
// build, a commit that edits role.md, voice.md or agent.json without re-running the assembler
// ships stale instructions with nothing to notice. The Dockerfile runs this immediately before
// `eve build`; the drift test in the service's own suite is the same guard one layer earlier.
//
// Exit codes:
//   0 — instructions.md written (or, under --check, confirmed up to date); the success line
//       lands on stdout (see below).
//   1 — the role template is not generic (lintRole found something) OR it names a tool this
//       agent does not ship (assertRoleToolsAreDeployed) OR the manifest fails
//       assertDeclarationIntegrity (or fails to load/parse at all) OR, under --check, the
//       out file is stale or missing. The reason goes to stderr, verbatim from whichever
//       check threw. NOTHING is written — see ordering note.
//   2 — usage error: an unknown flag, or one of the four required flags is missing. Node's
//       own parseArgs message (unknown flag) or this file's own message (missing flag) goes
//       to stderr. NOTHING is written.
//
// ORDERING IS THE WHOLE POINT OF THIS FILE. Every read and every check runs before the single
// `writeFileSync` call at the bottom — there is no early, partial, or best-effort write. A
// role template that is 90% generic must never land in a real agent's instructions.md just
// because assembly got that far before lintRole objected.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { assertDeclarationIntegrity, loadManifest } from "../src/manifest.js";
import { assemblePersona, assertRoleIsGeneric, assertRoleToolsAreDeployed, deployedToolsFor } from "../src/persona/index.js";

const REQUIRED_FLAGS = ["agent", "role", "voice", "out"] as const;
type Flag = (typeof REQUIRED_FLAGS)[number];
type Args = Record<Flag, string> & { display?: string; check: boolean };

function usage(message: string): never {
  console.error(`assemble-instructions: ${message}`);
  console.error(
    "usage: assemble-instructions --agent <dir containing agent.json> --role <role.md> " +
      "--voice <voice.md> [--display <display name>] --out <path to write> [--check]",
  );
  process.exit(2);
}

/** argv -> the four required options (+ optional --display), or a usage error (exit 2) — never a partial result.
 *  `node:util`'s own `parseArgs` catches an unknown flag or a value-less string option
 *  (strict: true); the "required" property has no equivalent there, so it is checked here,
 *  once all four are known to be either present or absent. */
function parseCliArgs(argv: string[]): Args {
  try {
    const { values } = parseArgs({
      args: argv,
      strict: true,
      options: {
        agent: { type: "string" },
        role: { type: "string" },
        voice: { type: "string" },
        display: { type: "string" },
        out: { type: "string" },
        check: { type: "boolean", default: false },
      },
    });
    const missing = REQUIRED_FLAGS.filter((flag) => values[flag] === undefined);
    if (missing.length > 0) {
      throw new Error(`missing required option(s): ${missing.map((f) => `--${f}`).join(", ")}`);
    }
    return values as Args;
  } catch (err) {
    return usage(err instanceof Error ? err.message : String(err));
  }
}

const args = parseCliArgs(process.argv.slice(2));

try {
  // The agent's own declaration first — assertDeclarationIntegrity is the cross-field truth
  // (persona set, skills within grants, every capability known) that the schema alone cannot
  // express; loadManifest's own parseManifest call already rejects a malformed agent.json
  // before this line, with an equally specific message.
  const manifest = assertDeclarationIntegrity(loadManifest(join(args.agent, "agent.json")));

  const roleMd = readFileSync(args.role, "utf8");
  // The lint gate: a role template naming a real person, company, vendor, place or language
  // is not a TEMPLATE, it is Bendik's actual agent with the serial numbers still on. The label
  // is the role file's own path, so the message says which file to fix when more than one
  // service's build runs this in the same CI log.
  assertRoleIsGeneric(roleMd, args.role);

  const voiceMd = readFileSync(args.voice, "utf8");

  // What this agent actually SHIPS, read off its own folder — never the capability docs' fleet-
  // wide tool unions, which name every tool any agent holding that capability has. Rendered
  // unfiltered, Marcel's persona claimed `calendar_create_event` and `travel_read` and Saga's
  // claimed `sveip` and `nytur`, under a heading that says these are the only capabilities there
  // are. Derived identically in both modes below, because `--check` has to compare against the
  // same rendering the write would produce.
  const deployedTools = deployedToolsFor(args.agent);

  // ORB-210 item 3. The lint above proves the role text is generic about PEOPLE; this one proves
  // it is honest about TOOLS. A role template names tools by name, so dropping the grant behind
  // one leaves the generated section silently not naming it while the role text keeps instructing
  // the agent to call it. Framework tools count as held: `web_search` is enabled in the
  // declaration, not shipped as a file.
  assertRoleToolsAreDeployed(roleMd, [...deployedTools, ...manifest.framework_tools], args.role);

  // The flag wins; otherwise the declaration's own display name; otherwise the agent's name.
  const displayName = args.display ?? manifest.display ?? manifest.name;
  const instructions = assemblePersona({ manifest, roleMd, voiceMd, displayName, deployedTools });

  if (args.check) {
    // Never writes. Reads what is on disk and compares; a missing file is as stale as a
    // different one, and both name the file plus the command that fixes it, because the reader
    // of this message is usually a failing image build with no other context.
    let onDisk: string;
    try {
      onDisk = readFileSync(args.out, "utf8");
    } catch {
      throw new Error(`${args.out} does not exist — run the assemble script for this agent and commit the result`);
    }
    if (onDisk !== instructions) {
      throw new Error(`${args.out} is STALE — it is not what --role ${args.role} + --voice ${args.voice} + ${join(args.agent, "agent.json")} assemble to. Run the assemble script for this agent and commit the result`);
    }
    console.log(`assemble-instructions: ${args.out} is up to date`);
    process.exit(0);
  }

  // The only write in this file, and the last statement before success — see the header note.
  writeFileSync(args.out, instructions);

  // k = granted capabilities, i.e. every grant whose scope is not "none" (manifest.ts's own
  // `isGranted`). Deliberately NOT the narrower set renderEnvironment actually prints (which
  // also drops a capability whose autonomy is "never") — this line reports what the
  // DECLARATION grants, not what one render pass chose to show, so it stays a stable count of
  // intent even as autonomy levels are tuned.
  const capabilities = manifest.grants.filter((g) => g.scope !== "none").length;
  const skills = manifest.skills.length;
  const bytes = Buffer.byteLength(instructions, "utf8");
  // "tool FILES", not "tools", and the word matters: this is `deployedToolsFor`'s naive
  // filesystem count, which includes every `disableTool()` sentinel file the agent ships to
  // switch an eve or kit tool OFF. Saga reports 66 here against 58 tools `eve build` actually
  // compiles — both numbers are right, and calling this one "tools" made it read as a
  // contradiction of the compiled count (ORB-145 whole-branch review, minor #6). What eve
  // compiled is the authoritative number: see templates/README.md § "Reading what actually
  // shipped".
  console.log(
    `assembled ${args.out} (${bytes} bytes, ${capabilities} capabilities, ${deployedTools.length} tool files, ${skills} skills)`,
  );
} catch (err) {
  console.error(`assemble-instructions: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
