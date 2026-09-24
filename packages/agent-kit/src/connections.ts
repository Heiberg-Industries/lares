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
}

const defs: ConnectionDef[] = [
  {
    id: "google",
    label: "Google (Gmail + Calendar)",
    custody: "console",
    configEnv: { redirectUri: { env: "GOOGLE_REDIRECT_URI", default: "" } },
    // One OAuth client per org. Internal consent only accepts users of that client's Workspace,
    // which is why a user in another Workspace cannot go through the heiberg client (ORB-28).
    instances: [
      { id: "heiberg", label: "Workspace A", secrets: ["google-client-id-heiberg", "google-client-secret-heiberg"] },
      { id: "zero7", label: "Workspace B", secrets: ["google-client-id-zero7", "google-client-secret-zero7"] },
    ],
  },
  {
    id: "twenty",
    label: "Twenty CRM (API key)",
    custody: "host",
    configEnv: { baseUrl: { env: "TWENTY_BASE_URL", default: "" } },
    instances: [{ id: "shared", secrets: ["twenty-key"] }],
  },
  {
    id: "orakel",
    label: "Orakel",
    custody: "host",
    configEnv: { baseUrl: { env: "ORAKEL_URL", default: "" } },
    instances: [{ id: "shared", secrets: ["orakel-key"] }],
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
    instances: [
      { id: "shared", secrets: ["gateway-key"] },
      { id: "marcel", secrets: ["marcel-gateway-key"] },
    ],
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
    instances: [
      { id: "saga", secrets: ["slack-bot-token", "slack-app-token"] },
      { id: "calliope", secrets: ["calliope-slack-bot-token", "calliope-slack-app-token"] },
    ],
  },
  {
    id: "telegram",
    label: "Telegram (bot)",
    custody: "host",
    instances: [
      { id: "saga", secrets: ["telegram-bot-token"] },
      { id: "marcel", secrets: ["marcel-telegram-bot-token"] },
    ],
  },
  {
    // LAR-76: added because the keeper already mounts this key from an agent definition and no
    // list said so. Read by the digest schedule alongside the KARAKEEP_URL environment binding.
    id: "karakeep",
    label: "Karakeep (bookmarks)",
    custody: "host",
    instances: [{ id: "shared", secrets: ["karakeep-api-key"] }],
  },
  {
    // LAR-76: the bearer token for the installation's own signals endpoint (SIGNAL_SPINE_URL).
    // Already mountable by the keeper; declared here so it is visible and rotatable like the rest.
    id: "signals",
    label: "Signal spine (bearer token)",
    custody: "host",
    instances: [{ id: "shared", secrets: ["signal-spine-token"] }],
  },
  {
    // A plain API key, NOT the OAuth client above: different credential, different custody, and
    // the travel tools treat it as optional. LAR-76 closes the gap the secret lint reported —
    // this key was read in code and declared nowhere.
    id: "places",
    label: "Google Places (API key)",
    custody: "host",
    instances: [{ id: "shared", secrets: ["google-places-api-key"] }],
  },
  {
    // LAR-76: optional third-party flight-status key the keeper already mounts.
    id: "aerodatabox",
    label: "AeroDataBox (flight status)",
    custody: "host",
    instances: [{ id: "shared", secrets: ["aerodatabox-api-key"] }],
  },
  {
    // LAR-76: optional. The file names below are the ones the keeper mounts today; the adapter's
    // own hard-coded fallback path spells them with an agent prefix, which only ever applies when
    // the environment variables below are unset — the keeper always sets them.
    id: "strava",
    label: "Strava (OAuth client)",
    custody: "host",
    instances: [{ id: "shared", secrets: ["strava-client-id", "strava-client-secret"] }],
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
  markets: [],
  network: [],
  notion: [],
  obligation: [],   // reads/writes the box's own obligation_threads table — no external credential
  orakel: ["orakel"],
  // Fans out over capabilities Saga already holds — so it needs their credentials, and no new one.
  person: ["twenty", "google", "orakel"],
  read_url: ["readability"],
  remind: [],
  signals: [],
  studio: ["gateway:shared"],
  transit: [],
  twenty: ["twenty"],
  echo: [],
  outreach: [],
  voice: [],
  travel: [],
  places: [],
  strava: [],
  shopping: [],
  persona: [],
  currency: [],
  admin: [],
  vault: [],
  // Not capabilities but SKILLS (@lares/agent-kit/skill-grants): an audit action can carry a
  // skill's name as its prefix, so the console has to be able to resolve those too.
  commercial: ["twenty", "gateway:shared", "orakel"],
};

/**
 * Consumers WITHOUT grants. Agents are deliberately absent — their connections are derived from
 * agent.json grants → capability → the capability→connection map above, so this list can never
 * contradict what an agent is actually granted.
 */
export const declaredConsumers: ConsumerDef[] = [
  // Reads Calendar through agent-runtime's resolver, Notion with its own token, and — since
  // ORB-39 Phase 4 — Twenty, for the People projection (read-only, keyed by email).
  { name: "notion-sync", kind: "service", connections: ["google", "notion", "twenty"] },
  { name: "email-watcher", kind: "service", connections: ["google"] },
  { name: "marcel", kind: "service", connections: ["google", "gateway:marcel", "telegram:marcel"] },
  { name: "console", kind: "console", connections: ["google"] },
  { name: "saga (Slack door)", kind: "door", connections: ["slack:saga"] },
  { name: "saga (Telegram door)", kind: "door", connections: ["telegram:saga"] },
  { name: "calliope (Slack door)", kind: "door", connections: ["slack:calliope"] },
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
}
