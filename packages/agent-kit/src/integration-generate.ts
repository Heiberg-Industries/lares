// The generator behind `src/connections.ts` (W6A-s3).
//
// WHY A GENERATOR AT ALL. `connections.ts` decides which secret files every connection is believed
// to hold and which connections every capability needs. Hand-maintained, it drifted: its own
// comment said every known capability MUST have a line, and `memory` had none. A generator closes
// that class of hole BY CONSTRUCTION — it writes one line per `KNOWN_CAPABILITIES` entry, so the
// hole cannot come back — and it refuses to render a connection that contradicts its integration
// manifest.
//
// WHAT COMES FROM WHERE. An integration manifest (`integrations/<id>/integration.json`) describes
// the VENDOR: it is the same for every installation, so it cannot carry an instance list, a secret
// file name, a custody or a base URL. Those are installation data and live in ONE file,
// `integrations/installation.json`, which wave 9 moves out of the engine. The manifest's job here
// is to be CHECKED against: every manifest must have a connection, and a manifest that declares
// secret names must agree with that connection's instances exactly. (Slack's and Google's manifests
// declare `secrets: []` on purpose — their real secret file names are per agent instance, which is
// installation data — so for those two there is nothing to check and the generator says so rather
// than inventing agreement.)
//
// PURE. `renderConnectionsModule` reads nothing and writes nothing; `bin/generate-connections.ts`
// does the I/O. That is what lets the staleness test render in memory and compare.
import type { IntegrationManifest } from "./integration-manifest.js";
import { KNOWN_SKILLS } from "./skill-grants.js";
import type { ConnectionInstanceDef, ConsumerDef, Custody } from "./connections.js";

/**
 * One instance as the INSTALLATION FILE spells it. `secretEnv` is the half that only the keeper
 * cares about — secret file name → the environment variable the runtime reads that file's path
 * from — and it is deliberately NOT part of `ConnectionInstanceDef`, so it never reaches
 * `connections.ts` or the console. It feeds `integration-secrets.ts` instead (LAR-76).
 */
export interface InstallationInstance extends ConnectionInstanceDef {
  secretEnv?: Readonly<Record<string, string>>;
}

/** One connection as the installation file spells it: everything a manifest cannot carry. */
export interface InstallationConnection {
  id: string;
  label: string;
  custody: Custody;
  configEnv?: Record<string, { env: string; default?: string; required?: boolean }>;
  /** Comment lines emitted inside the rendered object, above `id:`. */
  note?: readonly string[];
  /** Comment lines emitted above the rendered `instances:` line. */
  instancesNote?: readonly string[];
  instances: readonly InstallationInstance[];
}

/** A consumer, plus the comment lines that explain it. */
export interface InstallationConsumer extends ConsumerDef {
  note?: readonly string[];
}

/**
 * The installation-shaped half a manifest cannot carry: which instances exist, what each one's
 * secret files are called, which capability needs which connection, and the consumers that have no
 * grants to derive their connections from. Read from `integrations/installation.json` beside the
 * manifests, so the generator is pure and the wave-9 move is ONE `git mv`.
 *
 * DEVIATION from the wave-6 plan's sketch, which typed this as
 * `{ instances: Record<string, ConnectionInstanceDef[]>; consumers: ConsumerDef[] }`: that shape
 * cannot carry a connection's `label`, `custody` or `configEnv`, and no manifest carries them
 * either, so the committed file could not have been reproduced from it.
 */
export interface InstallationConnections {
  connections: readonly InstallationConnection[];
  /** Capability id → connection refs. A capability absent here renders as `[]`. */
  capabilities: Readonly<Record<string, readonly string[]>>;
  capabilityNotes?: Readonly<Record<string, { above?: readonly string[]; inline?: string }>>;
  consumers: readonly InstallationConsumer[];
}

export const GENERATED_BANNER = [
  "// GENERATED FILE — do not edit by hand.",
  "// Regenerate with: pnpm -C packages/agent-kit run generate:connections",
  "//",
  "// Sources: the integration manifests in `integrations/<id>/integration.json` (the vendor half)",
  "// and `integrations/installation.json` (the installation half — which instances exist, what each",
  "// one's secret files are called, which capability needs which connection, and the consumers that",
  "// have no grants to derive their connections from). Edit a source, then regenerate.",
  "// `packages/agent-kit/tests/integration-generate.test.ts` fails when this file is stale.",
  "//",
  "// The CONNECTION half of an integration: which credential, whose custody, which secret files.",
  "// Capabilities NAME connections; services and doors declare them (declaredConsumers) because",
  "// they have no grants to derive them from.",
  "//",
  "// NEUTRALITY: pure data + pure functions. No vendor imports, no I/O — this file is read by the",
  "// runtime and by the console.",
].join("\n");

const TYPES = `/** Who holds the credential — this is what decides what the console may OFFER, not just show. */
export type Custody =
  | "console"   // the console holds it and can (re)connect it
  | "host"      // a secret file on the box; the console never mounts it and must not claim to see it
  | "foreign";  // another system's custody entirely. Status only, never management. (No connection
                // below declares this today — Twenty's key is a HOST secret, "host" below — but the
                // distinction exists for a future credential the console can't even see the file for.)

export interface ConnectionInstanceDef {
  /** Unique within the connection: an org ("heiberg"), an agent ("marcel"), or "shared". */
  id: string;
  label?: string;
  /** Host secret file names this instance needs. */
  secrets: string[];
}

export interface ConnectionDef {
  id: string;
  label: string;
  custody: Custody;
  /** Config that travels WITH the credential (a base URL), keyed by config key. Capability-local
   *  config (COMMERCIAL_BRANDS, STUDIO_MODEL) stays with the capability that reads it. */
  configEnv?: Record<string, { env: string; default?: string; required?: boolean }>;
  instances: ConnectionInstanceDef[];
}

export interface ConsumerDef {
  name: string;
  kind: "service" | "door" | "console";
  /** Connection refs — see parseConnectionRef. */
  connections: string[];
}`;

const CAPABILITY_MAP_DOC = `/**
 * Capability id → the connection refs that capability needs.
 *
 * Lives here, apart from the adapters, so a consumer that only needs to answer "which connections
 * does capability X need" — the console, today — never imports an adapter and, through it, every
 * vendor client and their transitive workspace dependencies.
 *
 * EVERY capability in KNOWN_CAPABILITIES (@lares/agent-kit/manifest) has a line below, including
 * ones that name no connection at all (an empty array, never an absent key). That is not a
 * convention anyone has to remember any more: the generator writes one line per known capability,
 * so a capability cannot be missing from this map. A few SKILL names follow the capabilities,
 * because an audit action can carry a skill's name as its prefix and the console resolves those
 * through this same map.
 */`;

const CONSUMERS_DOC = `/**
 * Consumers WITHOUT grants. Agents are deliberately absent — their connections are derived from
 * agent.json grants → capability → the capability→connection map above, so this list can never
 * contradict what an agent is actually granted.
 */`;

const FUNCTIONS = `export interface ParsedRef { connectionId: string; instanceId: string | undefined }

/** \`"google"\` → every instance. \`"gateway:shared"\` → that one. */
export function parseConnectionRef(ref: string): ParsedRef {
  const [connectionId, instanceId] = ref.split(":", 2);
  return { connectionId, instanceId };
}

/** Resolve a ref to its instances. Throws on an unknown id — a silent empty set would mount
 *  nothing and surface much later as a missing-credential crash at agent boot. */
export function instancesFor(ref: string): ConnectionInstanceDef[] {
  const { connectionId, instanceId } = parseConnectionRef(ref);
  const def = connections.get(connectionId);
  if (!def) throw new Error(\`connections: unknown connection "\${connectionId}" (ref "\${ref}")\`);
  if (instanceId === undefined) return def.instances;
  const inst = def.instances.find((i) => i.id === instanceId);
  if (!inst) throw new Error(\`connections: unknown instance "\${instanceId}" of "\${connectionId}"\`);
  return [inst];
}

/** Sorted, deduplicated union of every referenced instance's secret names. */
export function secretsForRefs(refs: readonly string[]): string[] {
  const out = new Set<string>();
  for (const ref of refs) for (const inst of instancesFor(ref)) for (const s of inst.secrets) out.add(s);
  return [...out].sort();
}

/** Connection-level configEnv for the referenced connections, keyed by config key. Two connections
 *  reusing the same generic key name ("baseUrl": twenty → TWENTY_BASE_URL, orakel → ORAKEL_URL) is
 *  expected, not an error — the FIRST ref's definition wins. A capability that actually needs both
 *  values (commercial: twenty + orakel) re-declares its own capability-local keys for each one
 *  (twentyBaseUrl, orakelUrl); this merged, generically-named key is dead weight for it, never
 *  read. A capability with only one such connection sees no collision at all. */
export function configEnvForRefs(
  refs: readonly string[],
): Record<string, { env: string; default?: string; required?: boolean }> {
  const out: Record<string, { env: string; default?: string; required?: boolean }> = {};
  for (const ref of refs) {
    const { connectionId } = parseConnectionRef(ref);
    instancesFor(ref); // validate
    for (const [key, spec] of Object.entries(connections.get(connectionId)!.configEnv ?? {})) {
      if (!(key in out)) out[key] = spec;
    }
  }
  return out;
}`;

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function q(value: string): string {
  return JSON.stringify(value);
}

function key(name: string): string {
  return IDENTIFIER.test(name) ? name : q(name);
}

function renderList(values: readonly string[]): string {
  return `[${values.map(q).join(", ")}]`;
}

function renderConfigEnv(
  configEnv: Record<string, { env: string; default?: string; required?: boolean }>,
): string {
  const entries = Object.entries(configEnv).map(([k, spec]) => {
    const parts = [`env: ${q(spec.env)}`];
    if (spec.default !== undefined) parts.push(`default: ${q(spec.default)}`);
    if (spec.required !== undefined) parts.push(`required: ${String(spec.required)}`);
    return `${key(k)}: { ${parts.join(", ")} }`;
  });
  return `{ ${entries.join(", ")} }`;
}

function renderInstance(inst: ConnectionInstanceDef): string {
  const parts = [`id: ${q(inst.id)}`];
  if (inst.label !== undefined) parts.push(`label: ${q(inst.label)}`);
  parts.push(`secrets: ${renderList(inst.secrets)}`);
  return `{ ${parts.join(", ")} }`;
}

function renderConnection(c: InstallationConnection): string[] {
  const out: string[] = ["  {"];
  for (const line of c.note ?? []) out.push(`    // ${line}`);
  out.push(`    id: ${q(c.id)},`);
  out.push(`    label: ${q(c.label)},`);
  out.push(`    custody: ${q(c.custody)},`);
  if (c.configEnv) out.push(`    configEnv: ${renderConfigEnv(c.configEnv)},`);
  for (const line of c.instancesNote ?? []) out.push(`    // ${line}`);
  if (c.instances.length === 1) {
    out.push(`    instances: [${renderInstance(c.instances[0])}],`);
  } else {
    out.push("    instances: [");
    for (const inst of c.instances) out.push(`      ${renderInstance(inst)},`);
    out.push("    ],");
  }
  out.push("  },");
  return out;
}

/** The order is the installation file's own. The console's Integrations page lists its rows in
 *  this Map's iteration order, so reordering here is a visible change on somebody else's page —
 *  the file that a person edits decides it, not the generator. */
function orderConnections(
  connections: readonly InstallationConnection[],
): InstallationConnection[] {
  return [...connections];
}

/** Every check the generator makes before it will render a single byte. Each throws a sentence
 *  that names the file to edit, because the only person who ever reads it is editing one. */
function check(
  manifests: readonly IntegrationManifest[],
  installation: InstallationConnections,
  knownCapabilities: readonly string[],
): void {
  const byId = new Map(installation.connections.map((c) => [c.id, c]));

  for (const m of manifests) {
    const c = byId.get(m.id);
    if (!c) {
      throw new Error(
        `integration-generate: integrations/${m.id}/integration.json has no connection in ` +
          `integrations/installation.json. Add one, or the credential it needs is invisible to the console.`,
      );
    }
    if (m.secrets.length === 0) continue; // declared per instance instead — nothing to check
    const declared = [...new Set(c.instances.flatMap((i) => i.secrets))].sort();
    const expected = [...new Set(m.secrets)].sort();
    if (declared.join("\u0000") !== expected.join("\u0000")) {
      throw new Error(
        `integration-generate: ${m.id} declares secrets [${expected.join(", ")}] in its manifest ` +
          `but [${declared.join(", ")}] across its instances in integrations/installation.json. ` +
          `One of the two is wrong; a secret nobody mounts is a credential nobody can rotate.`,
      );
    }
  }

  checkSecretEnv(installation);

  const capabilityNames = new Set<string>([...knownCapabilities, ...KNOWN_SKILLS]);
  for (const name of Object.keys(installation.capabilities)) {
    if (!capabilityNames.has(name)) {
      throw new Error(
        `integration-generate: integrations/installation.json names "${name}" under capabilities, ` +
          `which is neither a KNOWN_CAPABILITIES nor a KNOWN_SKILLS entry (@lares/agent-kit/skill-grants).`,
      );
    }
  }
  for (const name of Object.keys(installation.capabilityNotes ?? {})) {
    if (!capabilityNames.has(name)) {
      throw new Error(
        `integration-generate: integrations/installation.json has a capabilityNotes entry for ` +
          `"${name}", which no capability or skill is called.`,
      );
    }
  }

  const refSources: Array<[string, readonly string[]]> = [
    ...Object.entries(installation.capabilities).map(
      ([name, refs]) => [`capability ${name}`, refs] as [string, readonly string[]],
    ),
    ...installation.consumers.map(
      (c) => [`consumer ${c.name}`, c.connections] as [string, readonly string[]],
    ),
  ];
  for (const [where, refs] of refSources) {
    for (const ref of refs) {
      const [connectionId, instanceId] = ref.split(":", 2);
      const c = byId.get(connectionId);
      if (!c) {
        throw new Error(
          `integration-generate: ${where} names connection "${connectionId}", which ` +
            `integrations/installation.json does not define.`,
        );
      }
      if (instanceId !== undefined && !c.instances.some((i) => i.id === instanceId)) {
        throw new Error(
          `integration-generate: ${where} names instance "${instanceId}" of "${connectionId}", ` +
            `which integrations/installation.json does not define.`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// The keeper's half (LAR-76): which secret files an agent definition may ask the keeper to mount.
// ---------------------------------------------------------------------------------------------

/** An environment variable name, as the runtime code spells it. */
const ENV_KEY_RE = /^[A-Z][A-Z0-9_]*$/;
/** A secret FILE name. It becomes a path segment under the container's secrets directory, so it
 *  is held to the same shape the secret lint looks for — never a path, never a traversal. */
const SECRET_FILE_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** One row of the keeper's map, with where it came from. */
export interface IntegrationSecretBinding {
  /** The environment variable the runtime reads the mounted path from. */
  env: string;
  /** The secret's file name — what it is called on the box AND inside the container. */
  file: string;
  /** `"<connection>:<instance>"` — rendered as a comment, so a reader can find the source row. */
  source: string;
}

/**
 * Every `secretEnv` row in the installation file, in file order. This is the ONE place that
 * decides what the keeper may mount from an agent definition, so every refusal below is a
 * security check, not a tidiness check:
 *
 *  - an env key naming a secret the instance does not have would mount someone else's file;
 *  - an instance that declares SOME of its secrets' env keys is half a credential pair, which
 *    fails at runtime in the least legible way — so declaring one means declaring all;
 *  - a duplicate env key would silently collapse two credentials onto one variable;
 *  - a file name that is not a plain name would escape the secrets directory.
 */
export function integrationSecretBindings(
  installation: InstallationConnections,
): IntegrationSecretBinding[] {
  checkSecretEnv(installation);
  const out: IntegrationSecretBinding[] = [];
  for (const c of installation.connections) {
    for (const inst of c.instances) {
      if (!inst.secretEnv) continue;
      for (const file of inst.secrets) {
        out.push({ env: inst.secretEnv[file]!, file, source: `${c.id}:${inst.id}` });
      }
    }
  }
  return out;
}

function checkSecretEnv(installation: InstallationConnections): void {
  const seen = new Map<string, string>();
  for (const c of installation.connections) {
    for (const inst of c.instances) {
      const where = `${c.id}:${inst.id}`;
      const secretEnv = inst.secretEnv;
      if (!secretEnv) continue;
      for (const file of Object.keys(secretEnv)) {
        if (!inst.secrets.includes(file)) {
          throw new Error(
            `integration-generate: integrations/installation.json gives ${where} a secretEnv ` +
              `entry for "${file}", which is not one of that instance's secrets. The keeper would ` +
              `be told to mount a file this credential does not own.`,
          );
        }
      }
      for (const file of inst.secrets) {
        const env = secretEnv[file];
        if (env === undefined) {
          throw new Error(
            `integration-generate: integrations/installation.json gives ${where} a secretEnv but ` +
              `no entry for its secret "${file}". Declare an environment variable for every secret ` +
              `of an instance or for none — half a credential pair mounted is worse than neither.`,
          );
        }
        if (!ENV_KEY_RE.test(env)) {
          throw new Error(
            `integration-generate: ${where}'s secretEnv names "${env}", which is not an ` +
              `environment variable name (A-Z, digits and underscores, starting with a letter).`,
          );
        }
        if (!SECRET_FILE_RE.test(file)) {
          throw new Error(
            `integration-generate: ${where} declares the secret file "${file}", which is not a ` +
              `plain lowercase name. A secret file name becomes a path inside the container.`,
          );
        }
        const prior = seen.get(env);
        if (prior !== undefined) {
          throw new Error(
            `integration-generate: integrations/installation.json binds "${env}" twice — ` +
              `${prior} and ${where}. One variable cannot carry two credentials.`,
          );
        }
        seen.set(env, where);
      }
    }
  }
}

export const GENERATED_SECRETS_BANNER = [
  "// GENERATED FILE — do not edit by hand.",
  "// Regenerate with: pnpm -C packages/agent-kit run generate:connections",
  "//",
  "// Source: the `secretEnv` entries in `integrations/installation.json` (the same file the",
  "// console's `connections.ts` is generated from — LAR-76 made the two lists ONE truth).",
  "// `packages/agent-kit/tests/integration-generate.test.ts` fails when this file is stale.",
  "//",
  "// WHAT THIS DECIDES. The keeper merges this map with its own small, hand-written list of",
  "// PLATFORM secrets (a route password, the token-at-rest key, the tracing keys — none of them",
  "// an integration) and mounts nothing outside the union. Adding a line here widens what an",
  "// agent definition can ask for, so a line is added by editing the installation file and",
  "// regenerating, never by hand.",
  "//",
  "// KEY = the environment variable the runtime reads the mounted path from; the binding in an",
  "// agent definition is keyed by it. VALUE = the secret's file name, which is both what it is",
  "// called on the box and what it is called at /run/secrets/<name> inside the container.",
  "//",
  "// LAR-76 renamed two VALUES: the Google client pair was spelled `travel-google-client-id` /",
  "// `travel-google-client-secret` here, a spelling that exists on no box and in no other file.",
  "// Both readers of those variables already fall back to the names below, which are also the",
  "// ones the installation file and the box itself use.",
].join("\n");

/** Renders the exact text of packages/agent-kit/src/integration-secrets.ts. Pure. */
export function renderIntegrationSecretsModule(installation: InstallationConnections): string {
  const bindings = integrationSecretBindings(installation);
  const out: string[] = [GENERATED_SECRETS_BANNER, ""];
  out.push("/** Environment variable → secret file name, for every integration credential an agent");
  out.push(" *  definition may ask the keeper to mount. */");
  if (bindings.length === 0) {
    out.push("export const INTEGRATION_SECRET_FILES = {} as const;");
  } else {
    out.push("export const INTEGRATION_SECRET_FILES = {");
    for (const b of bindings) out.push(`  ${key(b.env)}: ${q(b.file)},   // ${b.source}`);
    out.push("} as const;");
  }
  return out.join("\n") + "\n";
}

/** Renders the exact text of packages/agent-kit/src/connections.ts. Pure: no reads, no writes. */
export function renderConnectionsModule(
  manifests: readonly IntegrationManifest[],
  installation: InstallationConnections,
  knownCapabilities: readonly string[],
): string {
  check(manifests, installation, knownCapabilities);

  const out: string[] = [GENERATED_BANNER, "", TYPES, ""];

  const ordered = orderConnections(installation.connections);
  if (ordered.length === 0) {
    out.push("const defs: ConnectionDef[] = [];");
  } else {
    out.push("const defs: ConnectionDef[] = [");
    for (const c of ordered) out.push(...renderConnection(c));
    out.push("];");
  }
  out.push("");
  out.push("export const connections: Map<string, ConnectionDef> = new Map(defs.map((d) => [d.id, d]));");
  out.push("");

  out.push(CAPABILITY_MAP_DOC);
  const notes = installation.capabilityNotes ?? {};
  const extras = Object.keys(installation.capabilities).filter((n) => !knownCapabilities.includes(n));
  const capabilityLines: string[] = [];
  const line = (name: string): void => {
    for (const above of notes[name]?.above ?? []) capabilityLines.push(`  // ${above}`);
    const inline = notes[name]?.inline;
    const refs = renderList([...(installation.capabilities[name] ?? [])]);
    capabilityLines.push(`  ${key(name)}: ${refs},${inline ? `   // ${inline}` : ""}`);
  };
  for (const name of knownCapabilities) line(name);
  if (extras.length > 0) {
    capabilityLines.push("  // Not capabilities but SKILLS (@lares/agent-kit/skill-grants): an audit action can carry a");
    capabilityLines.push("  // skill's name as its prefix, so the console has to be able to resolve those too.");
    for (const name of extras) line(name);
  }
  if (capabilityLines.length === 0) {
    out.push("export const connectionsByCapability: Record<string, string[]> = {};");
  } else {
    out.push("export const connectionsByCapability: Record<string, string[]> = {");
    out.push(...capabilityLines);
    out.push("};");
  }
  out.push("");

  out.push(CONSUMERS_DOC);
  if (installation.consumers.length === 0) {
    out.push("export const declaredConsumers: ConsumerDef[] = [];");
  } else {
    out.push("export const declaredConsumers: ConsumerDef[] = [");
    for (const c of installation.consumers) {
      for (const n of c.note ?? []) out.push(`  // ${n}`);
      out.push(
        `  { name: ${q(c.name)}, kind: ${q(c.kind)}, connections: ${renderList([...c.connections])} },`,
      );
    }
    out.push("];");
  }
  out.push("");

  out.push(FUNCTIONS);
  return out.join("\n") + "\n";
}
