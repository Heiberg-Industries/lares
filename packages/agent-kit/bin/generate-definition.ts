#!/usr/bin/env tsx
// Offline migration preparation only. This does not prove the live-image equality gate,
// register ownership, update a mounted definition, or perform a runtime cutover.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { parseDefinition } from "../src/definition.js";
import { assertDeclarationIntegrity, parseManifest } from "../src/manifest.js";

let args;
try {
  args = parseArgs({ options: {
    agent: { type: "string" }, role: { type: "string" }, out: { type: "string" },
    check: { type: "boolean", default: false },
  }, strict: true }).values;
  if (!args.agent || !args.role || !args.out) throw new Error("--agent, --role and --out are required");
} catch (error) {
  console.error(`generate-definition: ${error instanceof Error ? error.message : error}`);
  console.error("usage: generate-definition --agent <overlay agent dir> --role <role id> --out <definition dir> [--check]");
  process.exit(2);
}

try {
  const raw = JSON.parse(readFileSync(join(args.agent, "agent.json"), "utf8"));
  // Parse for validation only: serializing parsed defaults would change the declaration.
  for (const key of ["language", "duties", "doors", "gender"]) {
    if (Object.hasOwn(raw, key)) throw new Error(`source declares ${key}; strict migration requires it absent`);
  }
  if (raw.role !== undefined && raw.role !== args.role) throw new Error("source role differs from --role");
  const declaration = { ...raw, role: raw.role ?? args.role };
  assertDeclarationIntegrity(parseManifest(declaration));
  parseDefinition(declaration);
  const files = {
    "agent.json": Buffer.from(`${JSON.stringify(declaration, null, 2)}\n`),
    "voice.md": readFileSync(join(args.agent, "agent", "voice.md")),
  };
  if (args.check) {
    const names = readdirSync(args.out).sort();
    if (names.join(",") !== "agent.json,voice.md") throw new Error("definition must contain exactly agent.json and voice.md (no duties)");
    for (const [name, bytes] of Object.entries(files)) {
      if (!readFileSync(join(args.out, name)).equals(bytes)) throw new Error(`${join(args.out, name)} is STALE`);
    }
    console.log(`generate-definition: ${args.out} is up to date`);
  } else {
    // An existing directory could be a live mount or contain duties/publication metadata.
    // Refuse it, including identical output; --check is the read-only idempotent operation.
    mkdirSync(args.out); // parent must exist; exclusive directory creation, no overwrite
    for (const [name, bytes] of Object.entries(files)) writeFileSync(join(args.out, name), bytes, { flag: "wx" });
    console.log(`generate-definition: staged ${args.out}; live persona/tool gates still required`);
  }
} catch (error) {
  console.error(`generate-definition: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}
