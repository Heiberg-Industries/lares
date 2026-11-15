// The checks that used to run only at BUILD time, run now on every save and again at
// every session start (ADR-0015 rule 8). They must be at least as strict as the build's, and
// each one has a test proving an invalid definition is refused.
//
// NEVER THROWS, on purpose: a save shows the owner every reason at once instead of the first
// one. `assertDefinitionValid` is the throwing form, for the session-start path where a single
// joined message is what a log line wants.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { AgentDefinition } from "./definition.js";
import { MODEL_ALIAS_RE, manifestViewOf } from "./definition.js";
import { assertDeclarationIntegrity } from "./manifest.js";
import { tsBasenames } from "./persona/deployed-tools.js";
import { assertRoleToolsAreDeployed } from "./persona/index.js";
import { assertNoUngatedWrites, isDisabledSentinel } from "./write-shape-lint.js";
import { deliveryFindings } from "./delivery.js";
import { OUTSIDE_CAPABILITY, checkOutsideUrl, outsideSecretName } from "./outside-tools.js";

export interface ValidationFinding { check: string; message: string }

export interface ValidateOptions {
  definition: AgentDefinition;
  /** The role template's text — what the "tools the role names are present" check reads. */
  roleMd: string;
  /** What this image actually ships, from `deployedToolsFor(serviceDir)`. */
  deployedTools: string[];
  /** When given, the write-shape lint runs over this service's tool sources. Omitted in the
   *  keeper, which has no source tree — there the lint already ran in CI on the image. */
  serviceDir?: string;
  /** Override the deployed-tool list the write-shape lint scans, instead of reading
   *  `serviceDir` off disk (`deployedToolsFor`). For tests, which have no real service tree to
   *  point `serviceDir` at — forwarded to `assertNoUngatedWrites`'s own `toolNames` option. */
  toolNames?: readonly string[];
  /** Does this door's secret file exist? The keeper passes a real check; tests pass a stub.
   *  Omitted entirely = skip the door check (the session-start path, where the secret's
   *  presence is the container's problem, not the definition's). */
  secretExists?: (name: string) => boolean;
  /** The role's own tool names, from `toolSourcesFor(roleDir)`. When given, a name that two
   *  sources both offer is refused (check 9). Omitted = that check is skipped. */
  toolSources?: ToolSources;
}

// ONE TOOL PER NAME.
//
// eve 1.0 does not refuse two tools with the same name. Its merge keeps whichever source it met
// first and writes one error line for the other (`definitions/combine.js`, `mergeTools`: "the
// first keeps it"; a tool file comes before anything resolved at session start). So one of the
// two is dropped without anyone deciding which — its description, its code and its approval rule
// with it. Here the same situation is a refusal, with both sources named.
export interface ToolSources {
  /** The names the role's tool files take: `agent/tools/` and the agent-kit mount. */
  authored: string[];
  /** Every name the role's pool can hand a session: `catalogue/`. */
  catalogue: string[];
}

export interface ToolNameCollision { name: string; sources: [string, string] }

const AUTHORED_SOURCE = "a tool file of that name (agent/tools/ or the agent-kit mount)";
const POOL_SOURCE = "the role's tool pool (catalogue/)";

/** Every name offered twice: by a tool file and a session-resolved source, or by two
 *  session-resolved sources. `dynamic` maps a source's plain description to its names. */
export function toolNameCollisions(
  authored: readonly string[],
  dynamic: Readonly<Record<string, readonly string[]>>,
): ToolNameCollision[] {
  const owner = new Map<string, string>(authored.map((name) => [name, AUTHORED_SOURCE]));
  const out: ToolNameCollision[] = [];
  for (const [source, names] of Object.entries(dynamic)) {
    for (const name of new Set(names)) {
      const first = owner.get(name);
      if (first === undefined) owner.set(name, source);
      else out.push({ name, sources: [first, source] });
    }
  }
  return out;
}

/** A role's tool names by source, read off its folder like `deployedToolsFor` (file names, and
 *  each file's text — nothing is imported).
 *
 *  A file that is switched off takes no name and is left out: the `disableTool()` stub a role
 *  keeps at a path its pool has taken over (`isDisabledSentinel`, the same test the write-shape
 *  lint uses). Nothing else is exempt. A tool the agent-kit extension ships counts as live unless
 *  the role's mount has such a stub for it — deleting the stub brings the extension's copy back.
 *
 *  WHAT IT CANNOT SEE: a name written inside a file. A resolver that hands over several tools
 *  under names of its own is known here only by its file name.
 *
 *  `kitDir` defaults to where the kit sits beside a role in the repo and in every image. */
export function toolSourcesFor(agentDir: string, kitDir = join(agentDir, "..", "..", "packages", "agent-kit")): ToolSources {
  const isTool = (file: string): boolean => !isDisabledSentinel(readFileSync(file, "utf8"));
  const tools = join(agentDir, "agent", "tools");
  const mount = join(agentDir, "agent", "extensions", "agent-kit");
  const overrides = tsBasenames(join(mount, "tools"));
  const shipped = existsSync(mount) || existsSync(`${mount}.ts`) ? tsBasenames(join(kitDir, "extension", "tools")) : [];
  return {
    authored: [
      ...tsBasenames(tools).filter((n) => isTool(join(tools, `${n}.ts`))),
      ...[...new Set([...shipped, ...overrides])]
        .filter((n) => !overrides.includes(n) || isTool(join(mount, "tools", `${n}.ts`)))
        .map((n) => `agent-kit__${n}`),
    ].sort(),
    catalogue: tsBasenames(join(agentDir, "catalogue")).filter((n) => n !== "index").sort(),
  };
}

/** How the keeper names a door's secret file under /etc/lares/secrets/. */
export function doorSecretName(agentName: string, kind: string): string {
  return `${agentName}-${kind}-token`;
}

function capture(check: string, fn: () => void, out: ValidationFinding[]): void {
  try {
    fn();
  } catch (err) {
    out.push({ check, message: err instanceof Error ? err.message : String(err) });
  }
}

export function validateDefinition(opts: ValidateOptions): ValidationFinding[] {
  const out: ValidationFinding[] = [];
  const d = opts.definition;

  // 1 + 2. Everything manifest.ts already enforces: skills within grants (never-widen), one
  // grant per capability, every capability known, no autonomy over an ungranted capability, a
  // persona that names a file. `assertSkillsWithinGrants` runs inside it.
  //
  // `assertDeclarationIntegrity` parses its argument against the STRICT `manifestSchema`
  // (manifest.ts), which knows nothing of the definition-only fields (`gender`, `description`,
  // `language`, `duties`, `schedules`, `doors`) that `parseDefinition` always fills in with
  // defaults. Passed the definition as-is, it throws "Unrecognized keys" on every call — so
  // `manifestViewOf` (definition.ts), the manifest-shaped subset, is what gets checked here.
  const before = out.length;
  capture("declaration-integrity", () => void assertDeclarationIntegrity(manifestViewOf(d)), out);
  // The never-widen failure gets its own name so the builder can point at the skill row rather
  // than at the whole declaration.
  const added = out[before];
  if (added && /a skill can never widen access|unknown skill|requires unknown capability/.test(added.message)) {
    added.check = "skills-within-grants";
  }

  // 3. The tools this definition's role text names must be present. Framework tools count as
  // held — `web_search` is enabled in the declaration, not shipped as a file.
  capture("role-tools-present", () => assertRoleToolsAreDeployed(opts.roleMd, [...opts.deployedTools, ...d.framework_tools], "role"), out);

  // 4. The write-shape lint, where there is a source tree to lint.
  if (opts.serviceDir) {
    capture("write-shape", () => assertNoUngatedWrites({
      agentDir: opts.serviceDir!,
      manifest: d,
      label: d.name,
      ...(opts.toolNames ? { toolNames: opts.toolNames } : {}),
    }), out);
  }

  // 5. The model is a purpose alias, never a raw model id (ADR-0013 rule 3; standing model policy).
  if (!MODEL_ALIAS_RE.test(d.model)) {
    out.push({
      check: "model-alias",
      message: `model "${d.model}" is not a purpose alias. Use <installation>-<purpose> with one of brain, writer, utility, gate, embed (ADR-0013) — never a raw model id.`,
    });
  }

  // 6. A door may be SAVED while its setup is pending; it may not be switched ON until its
  // secret exists. Without this, an enabled Telegram door with no token is a half-configured
  // agent, which is what ADR-0015 rule 8 forbids.
  // Wrapped in `capture()` like every other check: `secretExists` is the keeper's own I/O (a
  // filesystem stat under /etc/lares/secrets), and this module's whole point is that a save is
  // REFUSED with a reason, never crashed — a permission error reading the secrets directory
  // must become a `door-secret` finding, not an uncaught exception that takes the save down.
  const exists = opts.secretExists;
  if (exists) {
    for (const door of d.doors ?? []) {
      if (!door.enabled) continue;
      capture("door-secret", () => {
        const secret = doorSecretName(d.name, door.kind);
        if (!exists(secret)) {
          throw new Error(
            `the ${door.kind} door is switched on but its secret "${secret}" does not exist — connect it first, or save it switched off`,
          );
        }
      }, out);
    }
  }

  // 7. Outside tools. Each rule names the entry so the owner can find it.
  const outside = d.outsideTools ?? [];
  if (outside.length > 0) {
    capture("outside-tools", () => {
      const names = new Set<string>();
      for (const t of outside) {
        if (names.has(t.name)) throw new Error(`outside tool "${t.name}" is listed twice — each name must be unique`);
        names.add(t.name);
      }
    }, out);
    const grant = d.grants.find((g) => g.capability === OUTSIDE_CAPABILITY);
    if (!grant || grant.scope === "none") {
      out.push({ check: "outside-tools", message: `outside tools are listed but the agent holds no "${OUTSIDE_CAPABILITY}" grant — grant it (read, or write-with-confirm) first` });
    }
    for (const t of outside) {
      const allow = new Set(t.tools.allow);
      const stray = t.tools.read.filter((x) => !allow.has(x));
      if (stray.length > 0) {
        out.push({ check: "outside-tools", message: `outside tool "${t.name}": read lists ${stray.join(", ")}, which are not in allow — read must be a subset of allow` });
      }
      if (grant?.scope === "read") {
        const reads = new Set(t.tools.read);
        const writes = t.tools.allow.filter((x) => !reads.has(x));
        if (writes.length > 0) {
          out.push({ check: "outside-tools", message: `outside tool "${t.name}": the grant is read-only but ${writes.join(", ")} is allowed and not marked read — list it under read or widen the grant to write-with-confirm` });
        }
      }
      const url = checkOutsideUrl(t.url);
      if (!url.ok) out.push({ check: "outside-tools", message: `outside tool "${t.name}": ${url.reason}` });
      if (t.token && exists) {
        capture("outside-tools", () => {
          const secret = outsideSecretName(d.name, t.name);
          if (!exists(secret)) {
            throw new Error(`outside tool "${t.name}" needs a token but its secret "${secret}" does not exist — add it first, or set token to false`);
          }
        }, out);
      }
    }
    if (grant?.scope === "write") {
      out.push({ check: "outside-tools", message: `the "${OUTSIDE_CAPABILITY}" grant is "write" (no confirmation card); outside tools only run behind a card or read-only — use write-with-confirm or read` });
    }
  }

  // 8. Delivery routing: known kinds, known doors, no empty or repeated list.
  for (const message of deliveryFindings(d.delivery)) out.push({ check: "delivery", message });

  // 9. One tool per name. The pool is checked whole, not only what this definition is granted,
  // and an outside tool by every name its allow list could produce (`<name>__<tool>`), so the
  // answer does not change from one conversation to the next.
  if (opts.toolSources) {
    const dynamic: Record<string, readonly string[]> = { [POOL_SOURCE]: opts.toolSources.catalogue };
    for (const t of outside) dynamic[`the outside tool "${t.name}" in this definition`] = t.tools.allow.map((x) => `${t.name}__${x}`);
    for (const c of toolNameCollisions(opts.toolSources.authored, dynamic)) {
      out.push({
        check: "tool-names",
        message: `the tool name "${c.name}" is taken twice: by ${c.sources[0]} and by ${c.sources[1]}. A name can belong to only one tool — rename one of them, or make the tool file a disableTool() stub if the other has replaced it`,
      });
    }
  }

  return out;
}

export function assertDefinitionValid(opts: ValidateOptions): void {
  const findings = validateDefinition(opts);
  if (findings.length === 0) return;
  throw new Error(
    `definition "${opts.definition.name}" is invalid:\n` +
      findings.map((f) => `  - [${f.check}] ${f.message}`).join("\n"),
  );
}
