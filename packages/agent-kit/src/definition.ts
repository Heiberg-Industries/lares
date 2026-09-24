// The definition (agent-definitions spec, Part 2; ADR-0015). An agent is a FOLDER, not an image:
//
//   /srv/lares/agents/<name>/
//     agent.json   this schema — today's declaration plus six fields the builder writes
//     duties.md    what this agent is for, in the owner's words (may be absent)
//     voice.md     how it sounds
//
// This file deliberately does NOT edit manifest.ts. `definitionSchema` is
// `manifestSchema.extend(...)`, so every check manifest.ts already makes still runs, and a
// change there reaches a definition for free.
//
// THE FALLBACK IS LOAD-BEARING. With LARES_DEFINITION_DIR unset — every unit test, every CI
// build, every `eve build` — a service loads its OWN committed agent.json + agent/voice.md and
// an empty duties. That is the NEUTRAL DEFAULT the repo rule requires, and it is what keeps the
// byte-identical gate meaningful: the same code path assembles the persona whether the bytes
// came from a mounted folder or from the image.
//
// No credential reads and no I/O at module scope: eve evaluates this module during `eve build`.
import { createHash } from "node:crypto";
import { readFile, lstat, readlink, open } from "node:fs/promises";
import { join } from "node:path";
import { constants } from "node:fs";
import { z } from "zod";

import { manifestSchema } from "./manifest.js";

/** The keys `manifestSchema` (manifest.ts) knows about, as a Set for O(1) membership tests.
 *  DERIVED, not hand-listed: a definition-only field added to `definitionSchema.extend({...})`
 *  in a later task is invisible to this set automatically, so it is stripped by `manifestViewOf`
 *  below without anyone having to remember to update a parallel list here. Shared with
 *  `definition-validate.ts`, which had this same derivation before `manifestViewOf` existed. */
const MANIFEST_KEYS: ReadonlySet<string> = new Set(Object.keys(manifestSchema.shape));

/** The manifest-shaped subset of a definition. `manifest.ts`'s own seams —
 *  `assertDeclarationIntegrity`, `resolveExtensionTool`, `resolveSkillTool` — all parse their
 *  argument against the STRICT `manifestSchema`, which knows nothing of the definition-only
 *  fields (`gender`, `description`, `language`, `duties`, `schedules`, `doors`). Handed a
 *  definition as-is, they throw "Unrecognized keys" on every call, so a caller resolving a
 *  skill or an extension tool against a LOADED DEFINITION (rather than the service's own
 *  static `agent.json` import) strips those fields first. Safe to skip re-validating: a
 *  definition already passed through `definitionSchema` (this file's own `parseDefinition`),
 *  which extends `manifestSchema` field-for-field — nothing this view exposes was left
 *  unchecked on the way in. */
export function manifestViewOf(d: AgentDefinition): unknown {
  return Object.fromEntries(Object.entries(d).filter(([k]) => MANIFEST_KEYS.has(k)));
}

export const DEFAULT_DEFINITION_DIR_ENV = "LARES_DEFINITION_DIR";

/** ADR-0013's five purposes behind any installation prefix (plan D4). The engine names no
 *  installation, so it cannot check the prefix — the builder supplies it from a setting. */
export const MODEL_ALIAS_RE = /^[a-z0-9]+-(brain|writer|utility|gate|embed)$/;

export const GENDERS = ["female", "male", "agent"] as const;

const doorSchema = z.strictObject({
  kind: z.enum(["slack", "telegram", "email"]),
  /** A door may be SAVED while its setup is pending; it may not be switched on until its
   *  secrets exist (spec Part 2). `enabled` is that switch; the keeper refuses `true` without
   *  the secret (Task 3's door-secret check, enforced in Task 12). */
  enabled: z.boolean().default(true),
  /** Per-door settings the door adapter reads (channel id, chat id, mailbox). NEVER a secret —
   *  secrets are files under /etc/lares/secrets/. */
  settings: z.record(z.string(), z.string()).default({}),
});
export type DoorDeclaration = z.infer<typeof doorSchema>;

const scheduleSchema = z.strictObject({
  on: z.boolean(),
  /** ORB-268 adds times; declared now so a definition written today survives that release. */
  times: z.array(z.string()).optional(),
});

export const definitionSchema = manifestSchema.extend({
  /** How the console and other agents speak of this agent. Never inferred from a name. */
  gender: z.enum(GENDERS).optional(),
  /** One line, the owner's words, shown on the Fleet page. */
  description: z.string().optional(),
  /** This agent's default conversation language. ABSENT means "no instruction — follow the
   *  counterpart", which is exactly today's behaviour and is what keeps the byte-identical gate
   *  green (plan D3). The builder always sets one for a new agent. */
  language: z.string().min(2).optional(),
  /** The duties file's name inside the definition folder. A path, not the text. */
  duties: z.string().default("duties.md"),
  /** name -> on/off (+ times, per ORB-268). ANDed with EVE_SCHEDULES_LIVE (plan D6). */
  schedules: z.record(z.string(), scheduleSchema).default({}),
  /** Several per agent, each with its own setup flow (spec Part 5). When absent, derived from
   *  the legacy `channels` list, so today's three declarations need no edit. */
  doors: z.array(doorSchema).optional(),
});

export type AgentDefinition = z.infer<typeof definitionSchema>;

export interface LoadedDefinition {
  definition: AgentDefinition;
  dutiesMd: string;
  voiceMd: string;
  /** `"definition"` = a mounted folder; `"service"` = the image's own neutral files. */
  source: "definition" | "service";
  dir: string;
  hash: string;
}

/** Parse an already-loaded definition. Throws naming the offending field — the whole point is
 *  that a typo fails loudly at save, not at 07:00 in front of a schedule. */
export function parseDefinition(raw: unknown): AgentDefinition {
  const result = definitionSchema.safeParse(raw);
  if (result.success) return result.data;
  const detail = result.error.issues
    .map((i) => `${i.path.length > 0 ? i.path.join(".") : "<root>"}: ${i.message}`)
    .join("; ");
  throw new Error(`invalid agent definition — ${detail}`);
}

/** The doors this definition declares, with the legacy `channels` list as the fallback. */
export function doorsOf(d: AgentDefinition): { kind: string; enabled: boolean }[] {
  if (d.doors) return d.doors.map((x) => ({ kind: x.kind, enabled: x.enabled }));
  return d.channels.map((kind) => ({ kind, enabled: true }));
}

/** Deep, key-sorted clone for canonical JSON. `JSON.stringify(value, keyArray)` is NOT a
 *  recursive key filter — it applies the SAME allowlist at every nesting level, so a top-level
 *  `Object.keys(definition)` allowlist would silently blank out `grants[].capability`,
 *  `autonomy.<capability>`, `schedules.<name>.on`, and every other nested field (verified
 *  against this repo's Node: `JSON.stringify({grants:[{capability:"gmail"}]}, ["grants"])` →
 *  `'{"grants":[{}]}'`). That would make `hashOf` blind to exactly the fields whose drift
 *  matters most — a widened grant, a flipped autonomy level. Sorting keys recursively instead
 *  keeps the hash stable under key order AND sensitive to every field's value. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/** Stable identity of the whole definition — the three files together. Task 4 stores it and
 *  compares it at session start to notice a hand edit; the keeper stores it on every save. */
export function hashOf(loaded: Pick<LoadedDefinition, "definition" | "dutiesMd" | "voiceMd">): string {
  const canonical = JSON.stringify(canonicalize(loaded.definition));
  return createHash("sha256")
    .update(canonical).update("\n--\n")
    .update(loaded.dutiesMd).update("\n--\n")
    .update(loaded.voiceMd)
    .digest("hex");
}

async function readOr(path: string, fallback: string | null): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if (fallback === null) throw new Error(`definition: cannot read ${path}: ${(err as Error).message}`);
    return fallback;
  }
}

/** Load this agent's definition. With `LARES_DEFINITION_DIR` set, the mounted folder is the only
 *  truth — a missing or malformed `agent.json` THROWS rather than falling back, because a silent
 *  fallback to the image's neutral persona is exactly the half-configured state ADR-0015 rule 8
 *  forbids. Task 4 is what turns that throw into "keep running on the last valid one". */
export async function loadDefinition(opts: { serviceDir: string; env?: NodeJS.ProcessEnv }): Promise<LoadedDefinition> {
  const env = opts.env ?? process.env;
  const mounted = env[DEFAULT_DEFINITION_DIR_ENV];
  const fromFolder = typeof mounted === "string" && mounted.trim() !== "";
  const dir = fromFolder ? mounted : opts.serviceDir;
  const source: LoadedDefinition["source"] = fromFolder ? "definition" : "service";

  // Pin one generation, never resolve the three root aliases independently. Plain folders
  // remain supported; recheck after their read to detect a concurrent first publication.
  const files = fromFolder ? await readDefinitionFiles(dir) : null;
  const raw = files ? files["agent.json"] : await readOr(join(dir, "agent.json"), null);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (err) {
    throw new Error(`definition: ${join(dir, "agent.json")} is not valid JSON: ${(err as Error).message}`);
  }
  const definition = parseDefinition(parsed);

  // The service fallback keeps today's layout: voice at agent/voice.md, no duties in the image.
  if (fromFolder && definition.duties !== "duties.md") throw new Error("definition: duties must be duties.md");
  const voicePath = fromFolder ? join(dir, "voice.md") : join(dir, "agent", "voice.md");
  const dutiesPath = fromFolder ? join(dir, definition.duties) : join(dir, "agent", definition.duties);

  const voiceMd = files ? files["voice.md"] : await readOr(voicePath, null);
  const dutiesMd = files ? files["duties.md"] : await readOr(dutiesPath, "");
  return { definition, dutiesMd, voiceMd, source, dir, hash: hashOf({ definition, dutiesMd, voiceMd }) };
}

/** Validate the entire path before any definition read. Generation files are regular files;
 * only the fixed .current pointer may be a symlink. Never follow user-supplied paths outside
 * the mounted folder. Staged generations are invisible until the pointer rename. */
export async function definitionSnapshotDir(dir: string): Promise<string> {
  const root = await lstat(dir);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error("definition: unsafe root");
  let target: string;
  try { target = await readlink(join(dir, ".current")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    for (const name of ["agent.json", "duties.md", "voice.md"]) {
      try { const st = await lstat(join(dir, name)); if (!st.isFile() || st.isSymbolicLink()) throw new Error("definition: unsafe plain file"); }
      catch (e) { if (name !== "duties.md" || (e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    }
    return dir;
  }
  if (!/^\.generations\/[0-9a-f-]{36}$/.test(target)) throw new Error("definition: unsafe generation pointer");
  for (const path of [join(dir, ".generations"), join(dir, target)]) {
    const st = await lstat(path); if (!st.isDirectory() || st.isSymbolicLink()) throw new Error("definition: unsafe generation");
  }
  const snapshot = join(dir, target);
  for (const name of ["agent.json", "duties.md", "voice.md"]) {
    const st = await lstat(join(snapshot, name)); if (!st.isFile() || st.isSymbolicLink()) throw new Error("definition: unsafe generation file");
  }
  return snapshot;
}

export type DefinitionFileContents = Record<"agent.json" | "duties.md" | "voice.md", string>;
/** Read a coherent keeper publication while permitting atomic editors to replace any root
 * alias with a regular file. Such replacements are owner-authored overrides. A keeper save
 * journals its alias conversion; readers never combine overrides with a half-published save.
 * Each open is NOFOLLOW and retains its descriptor across an editor's atomic rename. */
export async function readDefinitionFiles(dir: string): Promise<DefinitionFileContents> {
  const marker = join(dir, ".publishing");
  async function idle(): Promise<void> {
    try { await lstat(marker); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return; throw e; }
    throw new Error("definition: publication interrupted or in progress; keeper recovery required");
  }
  for (let attempt = 0; attempt < 4; attempt++) {
    await idle();
    const snapshot = await definitionSnapshotDir(dir);
    const files = {} as DefinitionFileContents;
    let overrides = snapshot === dir;
    const identity: Array<{path: string; ino: number; mtimeMs: number; size: number}> = [];
    for (const name of ["agent.json", "duties.md", "voice.md"] as const) {
      const rootPath = join(dir, name);
      let path = join(snapshot, name);
      let st;
      try { st = await lstat(rootPath); }
      catch (e) { if (snapshot === dir && name === "duties.md" && (e as NodeJS.ErrnoException).code === "ENOENT") { files[name] = ""; continue; } throw e; }
      if (st.isSymbolicLink()) {
        if (snapshot === dir || await readlink(rootPath) !== `.current/${name}`) throw new Error("definition: unsafe root alias");
      } else {
        if (!st.isFile()) throw new Error("definition: unsafe root file");
        overrides = true;
        path = rootPath; // Atomic hand-edit override, intentionally takes precedence.
      }
      identity.push({path: rootPath, ino: st.ino, mtimeMs: st.mtimeMs, size: st.size});
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { if (!(await file.stat()).isFile()) throw new Error("definition: unsafe file"); files[name] = await file.readFile("utf8"); }
      finally { await file.close(); }
    }
    await idle();
    if (overrides && await definitionSnapshotDir(dir) !== snapshot) continue;
    let changed = false;
    for (const previous of identity) {
      const now = await lstat(previous.path);
      if (now.ino !== previous.ino || now.mtimeMs !== previous.mtimeMs || now.size !== previous.size) changed = true;
    }
    if (!changed) return files;
  }
  throw new Error("definition: files changed repeatedly during read; retry next session");
}
