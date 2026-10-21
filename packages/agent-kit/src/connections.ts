// GENERATED FILE — do not edit by hand.
// Regenerate with: pnpm -C packages/agent-kit run generate:connections
//
// Sources: the integration manifests in `integrations/<id>/integration.json` (the vendor half)
// and `integrations/installation.json` (the installation half — which instances exist, what each
// one's secret files are called, which capability needs which connection, and the consumers that
// have no grants to derive their connections from). Edit a source, then regenerate.
// `packages/agent-kit/tests/integration-generate.test.ts` fails when this file is stale.
//
// The CONNECTION half of an integration: which credential, whose custody, which secret files.
// Capabilities NAME connections; services and doors declare them (declaredConsumers) because
// they have no grants to derive them from.
//
// NEUTRALITY: pure data + pure functions. No vendor imports, no I/O — this file is read by the
// runtime and by the console.

/** Who holds the credential — this is what decides what the console may OFFER, not just show. */
export type Custody =
  | "console"   // the console holds it and can (re)connect it
  | "host"      // a secret file on the box; the console never mounts it and must not claim to see it
  | "foreign";  // another system's custody entirely. Status only, never management. (No connection
                // below declares this today — Twenty's key is a HOST secret, "host" below — but the
                // distinction exists for a future credential the console can't even see the file for.)

export interface ConnectionInstanceDef {
  /** Unique within the connection: an org, an agent, or "shared". */
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
}

const defs: ConnectionDef[] = [
  {
    // Consent only: one fixed work DATA client, separate from console sign-in.
    // No runtime capabilities or secretEnv entries: keeper does not mount this credential.
    id: "microsoft",
    label: "Microsoft work data consent (agent use pending)",
    custody: "console",
    instances: [{ id: "main", label: "Work data client", secrets: ["microsoft-data-tenant-id", "microsoft-data-client-id", "microsoft-data-client-secret"] }],
  },
  {
    id: "google",
    label: "Google (Gmail + Calendar)",
    custody: "console",
    configEnv: { redirectUri: { env: "GOOGLE_REDIRECT_URI", default: "" } },
    // One OAuth client per org. Internal consent only accepts users of that client's Workspace,
    // which is why a user in another Workspace cannot go through another org's client. The
    // console lists the orgs this host holds a client for; this single entry only keeps the
    // connection discoverable on a blank install.
    instances: [{ id: "main", label: "Workspace", secrets: [] }],
  },
  {
    id: "twenty",
    label: "Twenty CRM (API key)",
    custody: "host",
    configEnv: { baseUrl: { env: "TWENTY_BASE_URL", default: "" } },
    instances: [{ id: "shared", secrets: ["twenty-key"] }],
  },
  {
    id: "readability",
    label: "Readability worker",
    custody: "host",
    configEnv: { baseUrl: { env: "READABILITY_URL", default: "" } },
    instances: [{ id: "shared", secrets: ["readability-token"] }],
  },
  {
    // No configEnv: GATEWAY_URL is read directly via ctx.env at each build site today, and adding
    // it here would change gen-compose output for no gain. Left deliberately.
    id: "gateway",
    label: "LiteLLM gateway",
    custody: "host",
    instances: [{ id: "shared", secrets: ["gateway-key"] }],
  },
  {
    id: "notion",
    label: "Notion (integration token)",
    custody: "host",
    instances: [{ id: "shared", secrets: ["notion-token"] }],
  },
  {
    id: "slack",
    label: "Slack (bot)",
    custody: "host",
    instances: [{ id: "shared", secrets: ["slack-token", "slack-signing-secret"] }],
  },
  {
    id: "telegram",
    label: "Telegram (bot)",
    custody: "host",
    instances: [{ id: "shared", secrets: ["telegram-token", "telegram-webhook-secret"] }],
  },
  {
    // Declared because the keeper mounts this key from an agent definition and no list said
    // so. Read by the digest schedule alongside the KARAKEEP_URL environment binding.
    id: "karakeep",
    label: "Karakeep (bookmarks)",
    custody: "host",
    instances: [{ id: "shared", secrets: ["karakeep-api-key"] }],
  },
  {
    // The bearer token for the installation's own signals endpoint (SIGNAL_SPINE_URL).
    // Already mountable by the keeper; declared here so it is visible and rotatable like the rest.
    id: "signals",
    label: "Signal spine (bearer token)",
    custody: "host",
    instances: [{ id: "shared", secrets: ["signal-spine-token", "signal-read-token"] }],
  },
];

export const connections: Map<string, ConnectionDef> = new Map(defs.map((d) => [d.id, d]));

/**
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
 */
export const connectionsByCapability: Record<string, string[]> = {
  autonomy: [],
  calendar: ["google"],
  deadline: [],
  digest: [],
  gmail: ["google"],
  identity: [],   // reads the box's own user_aliases registry — no external credential
  notion: [],
  obligation: [],   // reads/writes the box's own obligation_threads table — no external credential
  outside: [],   // each outside tool's optional bearer token is a per-agent file the owner places on the server; the definition names the server
  // Fans out over capabilities the chief of staff already holds — so it needs their credentials, and no new one.
  person: ["twenty", "google"],
  read_url: ["readability"],
  remind: [],
  signals: [],
  studio: ["gateway:shared"],
  transit: [],
  twenty: ["twenty"],
  echo: [],
  outreach: [],
  voice: [],
  vault: [],
  // Not capabilities but SKILLS (@lares/agent-kit/skill-grants): an audit action can carry a
  // skill's name as its prefix, so the console has to be able to resolve those too.
  commercial: ["twenty", "gateway:shared"],
};

/**
 * Consumers WITHOUT grants. Agents are deliberately absent — their connections are derived from
 * agent.json grants → capability → the capability→connection map above, so this list can never
 * contradict what an agent is actually granted.
 */
export const declaredConsumers: ConsumerDef[] = [
  // Reads Calendar through agent-runtime's resolver, Notion with its own token, and Twenty,
  // for the People projection (read-only, keyed by email).
  { name: "notion-sync", kind: "service", connections: ["google", "notion", "twenty"] },
  { name: "email-watcher", kind: "service", connections: ["google"] },
  { name: "console", kind: "console", connections: ["google"] },
  { name: "Slack door", kind: "door", connections: ["slack:shared"] },
  { name: "Telegram door", kind: "door", connections: ["telegram:shared"] },
];

export interface ParsedRef { connectionId: string; instanceId: string | undefined }

/** `"google"` → every instance. `"gateway:shared"` → that one. */
export function parseConnectionRef(ref: string): ParsedRef {
  const [connectionId, instanceId] = ref.split(":", 2);
  return { connectionId, instanceId };
}

/** Resolve a ref to its instances. Throws on an unknown id — a silent empty set would mount
 *  nothing and surface much later as a missing-credential crash at agent boot. */
export function instancesFor(ref: string): ConnectionInstanceDef[] {
  const { connectionId, instanceId } = parseConnectionRef(ref);
  const def = connections.get(connectionId);
  if (!def) throw new Error(`connections: unknown connection "${connectionId}" (ref "${ref}")`);
  if (instanceId === undefined) return def.instances;
  const inst = def.instances.find((i) => i.id === instanceId);
  if (!inst) throw new Error(`connections: unknown instance "${instanceId}" of "${connectionId}"`);
  return [inst];
}

/** Sorted, deduplicated union of every referenced instance's secret names. */
export function secretsForRefs(refs: readonly string[]): string[] {
  const out = new Set<string>();
  for (const ref of refs) for (const inst of instancesFor(ref)) for (const s of inst.secrets) out.add(s);
  return [...out].sort();
}

/** Connection-level configEnv for the referenced connections, keyed by config key. Two connections
 *  reusing the same generic key name ("baseUrl": twenty → TWENTY_BASE_URL, readability → READABILITY_URL) is
 *  expected, not an error — the FIRST ref's definition wins. A capability that actually needs both
 *  values re-declares its own capability-local keys for each one
 *  (twentyBaseUrl, readabilityUrl); this merged, generically-named key is dead weight for it, never
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
}
