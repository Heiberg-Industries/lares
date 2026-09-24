// The checks that ran at BUILD time until ORB-278 step 2, run now on every save and again at
// every session start (ADR-0015 rule 8). They must be at least as strict as the build's, and
// each one has a test proving an invalid definition is refused.
//
// NEVER THROWS, on purpose: a save shows the owner every reason at once instead of the first
// one. `assertDefinitionValid` is the throwing form, for the session-start path where a single
// joined message is what a log line wants.
import type { AgentDefinition } from "./definition.js";
import { MODEL_ALIAS_RE, manifestViewOf } from "./definition.js";
import { assertDeclarationIntegrity } from "./manifest.js";
import { assertRoleToolsAreDeployed } from "./persona/index.js";
import { assertNoUngatedWrites } from "./write-shape-lint.js";

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
  // ORB-278 step 2's `market_edge.ts` session-start resolver reuses the same helper for
  // `resolveSkillTool`, which parses against the same strict schema.
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
      if (!door.enabled || door.kind === "email") continue; // Email is real OAuth metadata, verified by keeper lifecycle, never a token file.
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
