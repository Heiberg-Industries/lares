/**
 * The file the keeper boots from (`/etc/lares/keeper.json`), rendered from the release file the
 * installer was given. Nothing here pulls an image, talks to a registry, reads a file or
 * touches a container — data in, one object out, exactly like `stack-compose.ts` beside it.
 *
 * IT RETURNS A WHOLE `KeeperConfig`, NOT A `LifecycleConfig`. `services/keeper/lib/config.ts`'s
 * `loadKeeperConfig` parses that path with a `.strict()` schema in which `lifecycle` is one
 * OPTIONAL nested field among twelve; a bare lifecycle block written there is refused with
 * "keeper: invalid configuration in <path>: <field>: <reason>" and the keeper does not start. The type below
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
import { ENGINE_DATABASE_ROLES } from "./database-privileges.js";
import { DEADLINE_CALENDAR_IN_CONTAINER } from "./stack-compose.js";

/** The agents' own compose file, the one the keeper WRITES. Its name is fixed here because two
 *  fields of the keeper's configuration are two readings of the same file and must agree:
 *  `files` (relative, resolved against `dir` — `docker.ts`'s `execute`) and
 *  `lifecycle.composeFile` (absolute — `ownedDocker`'s `-f`). */
export const AGENTS_COMPOSE_FILE = "compose.lares-agents.yaml";

/** Where the roles and their templates live INSIDE the keeper image, not on the host: the
 *  keeper reads `join(templatesDir, role, "role.md")` and `deployedToolsFor(join(rolesDir,
 *  role))` from its own filesystem (the keeper lifecycle installation research
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
const APP_DATABASE_ROLE = ENGINE_DATABASE_ROLES.application;
const FINANCIAL_DATABASE_ROLE = ENGINE_DATABASE_ROLES.financial;
const WORKFLOW_PROVISIONER_ROLE = "lares_workflow_provisioner";
const WORKFLOW_OWNER_ROLE = "lares_workflow_owner";
const WORKFLOW_RUNTIME_ROLE = "lares_workflow";

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
  readonly pgDatabase: string;
  /** GATEWAY_URL, e.g. the gateway's compose service name on the fleet's own network. */
  readonly gatewayUrl: string;
  /** The id `run_first_owner` just wrote into the identity register. */
  readonly ownerId: string;
  /** Console login identity, separate from the register id. Missing means no app authority. */
  readonly credentialAdministrator?: string;
  /** Host path of the installation's deadline calendar, set ONLY when it is a regular file. The
   *  chief of staff's default binding then mounts it read-only at the same in-container path
   *  the console uses and names it in DEADLINE_CALENDAR_FILE. The creative agent never gets it. */
  readonly deadlineCalendarFile?: string;
  /** `https://<domain>` — where outside services reach this installation's doors. Webhook
   *  registration and Slack app creation refuse to run without it. */
  readonly publicDoorOrigin: string;
  /** The owner's IANA time zone (`OWNER_HOME_TZ` in installation.env). Handed to every agent,
   *  because the keeper never sees the installer's environment. Blank = leave agents on UTC. */
  readonly ownerHomeTz?: string;
  /** The schedules master switch of an earlier keeper.json, kept across installer runs. */
  readonly previousSchedulesLive?: boolean;
  readonly previousBudgetFinancial?: KeeperConfig["budgetFinancial"];
  /** Optional Console model-purpose signer. Omit only when the installation has no custody file. */
  readonly modelPurposeConsoleSigningKeyFile?: string | null;
  /** Dedicated shared socket subdirectory for the chief-only model-purpose claim socket. */
  readonly modelPurposeRuntimeDir?: string | null;
}

/** Refuses (throws `ReleaseManifestInvalid`, re-thrown from `imageFor`) when the release names
 *  no image for the keeper's egress proxy, its firewall helper, or any of the three roles. */
export function renderKeeperConfig(
  manifest: ReleaseManifest,
  opts: KeeperConfigOptions,
): KeeperConfig {
  const passwordFile = join(opts.secretsDir, "database-password");
  const workflowPasswordFile = join(opts.secretsDir, "workflow-password");
  const workflowProvisionerPasswordFile = join(opts.secretsDir, "workflow-provisioner-password");
  const financialPasswordFile = join(opts.secretsDir, "financial-database-password");
  const managedSecretsDir = join(opts.dir, "secrets");
  const db = {
    host: DB_HOST,
    port: DB_PORT,
    database: opts.pgDatabase,
    user: APP_DATABASE_ROLE,
    passwordFile,
  };
  const financialDb = { ...db, user: FINANCIAL_DATABASE_ROLE, passwordFile: financialPasswordFile };
  if (opts.previousBudgetFinancial) {
    const previousDb = opts.previousBudgetFinancial.db;
    if (opts.previousBudgetFinancial.directory !== "/var/lib/lares/budget-financial" ||
      previousDb.host !== financialDb.host || previousDb.port !== financialDb.port ||
      previousDb.database !== financialDb.database || previousDb.user !== financialDb.user ||
      previousDb.passwordFile !== financialDb.passwordFile)
      throw new Error("Existing financial custody does not use the explicit financial database credential; operator recovery is required.");
  }

  const tzEnvironment: Record<string, string> = opts.ownerHomeTz ? { OWNER_HOME_TZ: opts.ownerHomeTz } : {};
  return {
    publicDoorOrigin: opts.publicDoorOrigin,
    designatedOwnerId: opts.ownerId,
    ...(opts.previousBudgetFinancial ? {
      budgetFinancial: {
        directory: opts.previousBudgetFinancial.directory,
        db: financialDb,
      },
    } : {}),
    // The installer owns this signer in its protected secrets directory. Keeper reads the
    // exact file through the existing read-only installer-secrets mount; it is never copied.
    vaultConsoleSigningKeyFile: join(opts.secretsDir, "console-vault-signing-key"),
    ...(opts.modelPurposeConsoleSigningKeyFile ? { modelPurposeConsoleSigningKeyFile: opts.modelPurposeConsoleSigningKeyFile } : {}),
    ...(opts.modelPurposeRuntimeDir ? { modelPurposeRuntimeDir: opts.modelPurposeRuntimeDir } : {}),
    // Definitions resolved at runtime on neutral engine images (ADR-0015). "overlay" is the
    // older per-agent-image machinery; a fresh install is never that.
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
    // Preparation is an explicit host step. Never adopt an external token or widen mounts.
    credentials: {
      ...(opts.credentialAdministrator ? { administrator: opts.credentialAdministrator } : {}),
      slot: "notion:shared", binding: "NOTION_TOKEN_FILE", prepared: false,
      inventoryComplete: false, retainedConsumers: [],
    },
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
        creative: imageFor(manifest, "creative"),
      },
      proxyContainer: PROXY_CONTAINER,
      squidImage: imageFor(manifest, "lares-egress-proxy"),
      firewallImage: imageFor(manifest, "lares-firewall-helper"),
      adminDb: { ...db, database: "postgres", user: WORKFLOW_PROVISIONER_ROLE, passwordFile: workflowProvisionerPasswordFile },
      workflowTemplate: "empty_workflow",
      workflowOwner: WORKFLOW_OWNER_ROLE,
      runtime: {
        // Installation-only master switch. ON by default: the create-agent
        // review page lists the schedules an agent will run, and the owner approves that list
        // there. An installer re-run keeps whatever an earlier keeper.json said.
        schedulesLive: opts.previousSchedulesLive ?? true,
        databaseUrl: `postgres://${APP_DATABASE_ROLE}@${DB_HOST}:${DB_PORT}/${opts.pgDatabase}`,
        // Per-agent workflow databases hang off this server URL: `lifecycle.ts` sets the
        // pathname itself, one database per agent, so this one carries none.
        workflowServer: `postgres://${WORKFLOW_RUNTIME_ROLE}@${DB_HOST}:${DB_PORT}/`,
        gatewayUrl: opts.gatewayUrl,
        proxyUrl: PROXY_URL,
        passwordFile,
        workflowPasswordFile,
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
          environment: {
            ...tzEnvironment,
            ...(opts.deadlineCalendarFile ? { DEADLINE_CALENDAR_FILE: DEADLINE_CALENDAR_IN_CONTAINER } : {}),
          },
          mounts: opts.deadlineCalendarFile
            ? [{ source: opts.deadlineCalendarFile, target: DEADLINE_CALENDAR_IN_CONTAINER, readOnly: true }]
            : [],
          secrets: {
            EVE_ROUTE_PASSWORD_FILE: join(opts.secretsDir, "eve-route-password"),
          },
        },
        creative: {
          role: "creative",
          ownerId: opts.ownerId,
          environment: { ...tzEnvironment },
          mounts: [],
          secrets: {
            EVE_ROUTE_PASSWORD_FILE: join(opts.secretsDir, "eve-route-password"),
          },
        },
      },
    },
  };
}
