/**
 * The file the keeper boots from (`/etc/lares/keeper.json`), rendered from the release file the
 * installer was given. Nothing here pulls an image, talks to a registry, reads a file or
 * touches a container — data in, one object out, exactly like `stack-compose.ts` beside it.
 *
 * IT RETURNS A WHOLE `KeeperConfig`, NOT A `LifecycleConfig`. `services/keeper/lib/config.ts`'s
 * `loadKeeperConfig` parses that path with a `.strict()` schema in which `lifecycle` is one
 * OPTIONAL nested field among twelve; a bare lifecycle block written there is refused with
 * "keeper: invalid or unreadable configuration" and the keeper does not start. The type below
 * is that schema's own, imported by type only — nothing of the keeper's runtime (zod, pg) is
 * loaded into the installer by this file.
 *
 * THE FIRST AGENT IS THE OWNER'S, WHATEVER IT IS NAMED. The console asks the owner for a name
 * and one of three roles after installation, so the keeper cannot key the fresh binding by a
 * guessed literal name. Role defaults carry the real owner id and the shared route-password
 * source; an exact per-name binding, when an existing installation has one, still wins.
 */
import { join } from "node:path";
import { imageFor, type ReleaseManifest } from "./release-manifest.js";
import type { KeeperConfig } from "../../keeper/lib/config.js";

/** The agents' own compose file, the one the keeper WRITES. Its name is fixed here because two
 *  fields of the keeper's configuration are two readings of the same file and must agree:
 *  `files` (relative, resolved against `dir` — `docker.ts`'s `execute`) and
 *  `lifecycle.composeFile` (absolute — `ownedDocker`'s `-f`). */
export const AGENTS_COMPOSE_FILE = "compose.lares-agents.yaml";

/** Where the roles and their templates live INSIDE the keeper image, not on the host: the
 *  keeper reads `join(templatesDir, role, "role.md")` and `deployedToolsFor(join(rolesDir,
 *  role))` from its own filesystem (docs/research/2026-09-16-keeper-lifecycle-installation.md
 *  fixes both paths). They are not an installation's choice, so they are not options. */
export const KEEPER_ROLES_DIR = "/app/services";
export const KEEPER_TEMPLATES_DIR = "/app/packages/agent-kit/templates";

/** The egress proxy's compose service name, and the address agents reach it on. Both are the
 *  keeper's own (`compose.lares-keeper.yaml`'s `container_name`), not this installation's. */
export const PROXY_CONTAINER = "lares-egress-proxy";
const PROXY_URL = `http://${PROXY_CONTAINER}:8888`;

/** The database service name inside the fleet's own network. The loopback port the stack
 *  publishes (127.0.0.1:5432) exists for the host's migration run; nothing in a container uses
 *  it. */
const DB_HOST = "db";
const DB_PORT = 5432;

export interface KeeperConfigOptions {
  /** Compose project name for the agents the keeper owns (`docker compose --project-name`). */
  readonly project: string;
  /** Must be the network F1's `renderStackCompose` created — `docker.ts`'s inventory runs a
   *  literal `docker network inspect` on this string. */
  readonly network: string;
  readonly subnet: string;
  readonly proxyAddress: string;
  /** The keeper-owned root, mounted into the keeper container at the SAME absolute path
   *  (`compose.lares-keeper.yaml`'s `${LARES_ROOT}:${LARES_ROOT}`). It is also the compose
   *  project directory, and the agents' compose file is written inside it. */
  readonly dir: string;
  /** `/srv/lares/agents` — one folder per agent (ADR-0015). The keeper mounts
   *  `${agentsDir}/${name}:/definition:ro` itself. */
  readonly agentsDir: string;
  readonly retiredDir: string;
  readonly backupDir: string;
  readonly egressDir: string;
  /** `$PREFIX/etc/lares/secrets` — where `install.sh` generated this installation's secrets. */
  readonly secretsDir: string;
  readonly pgUser: string;
  readonly pgDatabase: string;
  /** GATEWAY_URL, e.g. the gateway's compose service name on the fleet's own network. */
  readonly gatewayUrl: string;
  /** The id `run_first_owner` just wrote into the identity register. */
  readonly ownerId: string;
}

/** Refuses (throws `ReleaseManifestInvalid`, re-thrown from `imageFor`) when the release names
 *  no image for the keeper's egress proxy, its firewall helper, or any of the three roles. */
export function renderKeeperConfig(
  manifest: ReleaseManifest,
  opts: KeeperConfigOptions,
): KeeperConfig {
  const passwordFile = join(opts.secretsDir, "database-password");
  const managedSecretsDir = join(opts.dir, "secrets");
  const db = {
    host: DB_HOST,
    port: DB_PORT,
    database: opts.pgDatabase,
    user: opts.pgUser,
    passwordFile,
  };

  return {
    // Definitions resolved at runtime on neutral engine images (ADR-0015). "overlay" is the
    // older per-agent-image machinery one installation is still on; a fresh install is never
    // that.
    mode: "rendered",
    project: opts.project,
    dir: opts.dir,
    files: [AGENTS_COMPOSE_FILE],
    agentsDir: opts.agentsDir,
    retiredDir: opts.retiredDir,
    // Door/runtime-control and per-agent gateway secrets are created by the keeper. This path is
    // under its writable same-path root; installer-owned inputs remain under opts.secretsDir and
    // are mounted read-only into the keeper.
    secretsDir: managedSecretsDir,
    rolesDir: KEEPER_ROLES_DIR,
    templatesDir: KEEPER_TEMPLATES_DIR,
    backupDir: opts.backupDir,
    db,
    lifecycle: {
      network: opts.network,
      subnet: opts.subnet,
      reservedAddresses: [opts.proxyAddress],
      composeFile: join(opts.dir, AGENTS_COMPOSE_FILE),
      egressDir: opts.egressDir,
      imageByRole: {
        "chief-of-staff": imageFor(manifest, "chief-of-staff"),
        travel: imageFor(manifest, "travel"),
        creative: imageFor(manifest, "creative"),
      },
      proxyContainer: PROXY_CONTAINER,
      squidImage: imageFor(manifest, "lares-egress-proxy"),
      firewallImage: imageFor(manifest, "lares-firewall-helper"),
      adminDb: db,
      workflowTemplate: "empty_workflow",
      workflowOwner: opts.pgUser,
      runtime: {
        // Installation-only master switch, off until the owner turns it on: a fresh install
        // has no schedule anybody has read, let alone approved.
        schedulesLive: false,
        databaseUrl: `postgres://${opts.pgUser}@${DB_HOST}:${DB_PORT}/${opts.pgDatabase}`,
        // Per-agent workflow databases hang off this server URL: `lifecycle.ts` sets the
        // pathname itself, one database per agent, so this one carries none.
        workflowServer: `postgres://${opts.pgUser}@${DB_HOST}:${DB_PORT}/`,
        gatewayUrl: opts.gatewayUrl,
        proxyUrl: PROXY_URL,
        passwordFile,
        // Exact entries remain the compatibility seam for external/existing installations.
        // Fresh on-box installs let the keeper persist and register one budgeted key per agent.
        gatewayKeys: {},
        gatewayMasterKeyFile: join(opts.secretsDir, "gateway-master-key"),
      },
      // Empty on a fresh install, and explicitly so: no integration is switched on yet, so
      // there is nothing to allow out beyond the fleet's own network. An omitted list would
      // silently remove a seal on a later render; an empty one says "none, on purpose".
      egress: {
        endpoints: {},
        legacyConsumers: [],
        internalNetworks: [opts.subnet],
        directDestinations: [],
        infrastructureHosts: [],
      },
      installationPrepared: true,
      defaultBindings: {
        "chief-of-staff": {
          role: "chief-of-staff",
          // The owner reaches the agent as `ownerId` and ONLY as `ownerId`:
          // `runtime-bindings.ts` accepts no `AGENT_OWNER_USER_ID` in `environment` (its
          // `environmentKeys` enum does not contain it, and a test already pins the refusal),
          // and `compose-agents.ts` sets that variable from this field.
          ownerId: opts.ownerId,
          environment: {},
          mounts: [],
          secrets: {
            EVE_SAGA_ROUTE_PASSWORD_FILE: join(opts.secretsDir, "eve-route-password"),
          },
        },
        travel: {
          role: "travel",
          ownerId: opts.ownerId,
          environment: {},
          mounts: [],
          secrets: {
            EVE_ROUTE_PASSWORD_FILE: join(opts.secretsDir, "eve-route-password"),
          },
        },
        creative: {
          role: "creative",
          ownerId: opts.ownerId,
          environment: {},
          mounts: [],
          secrets: {
            EVE_ROUTE_PASSWORD_FILE: join(opts.secretsDir, "eve-route-password"),
          },
        },
      },
    },
  };
}
