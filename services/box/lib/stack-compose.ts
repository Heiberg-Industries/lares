/**
 * The neutral stack: one compose file, rendered from the release manifest. Names no
 * installation — every image comes from `imageFor(manifest, service)`, which already refuses
 * by name when the manifest names none. The keeper's own agents are a separate file (F7 brings
 * both up together); this file never mentions the keeper.
 */
import { stringify } from "yaml";
import { execFileSync } from "node:child_process";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { imageFor, type ReleaseManifest } from "./release-manifest.js";

export interface StackComposeOptions {
  /** Absolute path to the secrets directory ($PREFIX/etc/lares/secrets). */
  readonly secretsDir: string;
  /** Exact regular-file custody path selected by render-stack, absent when Vault signing
   *  custody is not prepared. Omission keeps ordinary console startup independent of Vault. */
  readonly consoleVaultSigningKeyFile?: string | null;
  /** Dedicated optional Console model-purpose signer. Independent of Vault custody. */
  readonly consoleModelPurposeSigningKeyFile?: string | null;
  /** Host directory shared with keeper for the console's private Unix socket. */
  readonly socketDir: string;
  /** Host-owned Preferences store, writable by the console's uid 10001. */
  readonly tasteDir: string;
  /** Absolute path to the generated LiteLLM config file (F4 writes it; F1 only mounts it). */
  readonly gatewayConfigFile: string;
  /** Absolute path the gateway's own start script is installed at on the host. The file itself
   *  is COMMITTED (`images/gateway-runtime/start.sh`); `bin/render-stack.ts` installs a
   *  byte-identical copy there and this only mounts it, as the container's entrypoint. */
  readonly gatewayStartScript: string;
  /** Absolute path the Caddyfile is installed at on the host. The file itself is COMMITTED,
   *  not generated (`services/box/ops/Caddyfile` — Caddy's own `{$LARES_DOMAIN}` substitution
   *  instead of a renderer); `install.sh`'s `run_stack` copies it there, and this only mounts
   *  it. */
  readonly caddyfile: string;
  /** Absolute path to a directory Caddy may write its own state into (certificates, OCSP). */
  readonly caddyDataDir: string;
  /** Absolute path to a directory Postgres may write its data files into. */
  readonly dbDataDir: string;
  /** Root-owned external PostgreSQL authentication custody directory. */
  readonly databaseAuthDir: string;
  readonly network: string; // e.g. "lares-network" — created by this file, NOT external
  readonly subnet: string; // e.g. "172.30.0.0/24"
  /** The domain the installation answers on (LARES_DOMAIN). It reaches Caddy through the
   *  caddy service's OWN environment, because the Caddyfile substitutes it from the Caddy
   *  process's environment inside the container — not from the host's, and not from compose. */
  readonly domain: string;
  /** Installation-owned comma-separated console allow-list. */
  readonly consoleAllowedEmails: string;
  /** Canonical owner identity used by the console's owner-scoped tools. */
  readonly ownerId: string;
  /** Owner clock selected during installation. */
  readonly ownerHomeTz: string;
  /** The only purpose alias the on-box gateway config actually defines. */
  readonly modelAlias: string;
  readonly pgDatabase: string;
  /** Host path of the installation's deadline calendar when the file exists, else null. When
   *  set, the console gets the file read-only at the same path the engine documents and
   *  `DEADLINE_CALENDAR_FILE` naming it; the setting alone would point at a file the container
   *  cannot see. Never a directory mount: Docker would invent a missing source. */
  readonly deadlineCalendarFile: string | null;
}

export interface DatabaseBootstrapComposeOptions {
  /** Absolute root-only credential path, outside every container's ordinary mounts. */
  readonly operatorPasswordFile: string;
  readonly dbDataDir: string;
  readonly databaseAuthDir: string;
  readonly network: string;
  readonly subnet: string;
}


/** The installer validates the strict host receipt; renderers additionally refuse a missing,
 *  symlinked or non-regular external auth input before writing Compose output. */
export function assertDatabaseAuthDirectory(path: string, prefix: string, subnet: string): void {
  if (!isAbsolute(path) || /[\n\r\0]/.test(path))
    throw new Error("Database authentication directory path must be absolute");
  const normalizedPrefix = prefix || "/";
  if (!isAbsolute(normalizedPrefix) || resolve(normalizedPrefix) !== normalizedPrefix)
    throw new Error("Database authentication prefix must be absolute and normalized");
  const expected = join(normalizedPrefix, "var/lib/lares-maintenance/postgres-auth");
  if (path !== expected)
    throw new Error("Database authentication directory must name this installation's protected custody");
  if (process.getuid?.() !== 0 && process.env.LARES_MAINTENANCE_TESTING !== "1")
    throw new Error("Database authentication custody validation requires root");
  const checker = join(dirname(fileURLToPath(import.meta.url)), "..", "ops", "maintenance-custody.py");
  const args = [checker, "validate", normalizedPrefix, subnet];
  if (process.getuid?.() !== 0 && process.env.LARES_MAINTENANCE_TESTING === "1") args.push("--test-owner");
  execFileSync("python3", args, { stdio: "pipe" });
}

/** Where the deadline calendar sits inside the console container (docs/install.md, section 7). */
export const DEADLINE_CALENDAR_IN_CONTAINER = "/srv/lares/installation/deadline-calendar.json";

/** Renders the ENTIRE stack: db, console, lares-gateway, caddy. Refuses (throws
 *  ReleaseManifestInvalid, re-thrown from imageFor) if the manifest names no image for one of
 *  them. Never mentions the keeper — F7 appends that service with a second file. */
export function renderStackCompose(manifest: ReleaseManifest, opts: StackComposeOptions): string {
  if (!isAbsolute(opts.databaseAuthDir) || /[\n\r\0]/.test(opts.databaseAuthDir))
    throw new Error("Database authentication directory path must be absolute");
  const secret = (name: string) => ({ file: `${opts.secretsDir}/${name}` });
  const consoleVaultSigningKeyFile = opts.consoleVaultSigningKeyFile ?? null;
  const consoleModelPurposeSigningKeyFile = opts.consoleModelPurposeSigningKeyFile ?? null;
  if (consoleVaultSigningKeyFile !== null && (!isAbsolute(consoleVaultSigningKeyFile) || /[\n\r\0]/.test(consoleVaultSigningKeyFile)))
    throw new Error("Console Vault signing-key path must be absolute");
  if (consoleVaultSigningKeyFile !== null && consoleVaultSigningKeyFile !== join(opts.secretsDir, "console-vault-signing-key"))
    throw new Error("Console Vault signing-key path must name its custody file");
  if (consoleModelPurposeSigningKeyFile !== null && (!isAbsolute(consoleModelPurposeSigningKeyFile) || /[\n\r\0]/.test(consoleModelPurposeSigningKeyFile)))
    throw new Error("Console model-purpose signing-key path must be absolute");
  if (consoleModelPurposeSigningKeyFile !== null && consoleModelPurposeSigningKeyFile !== join(opts.secretsDir, "console-model-purpose-signing-key"))
    throw new Error("Console model-purpose signing-key path must name its custody file");
  // Where the gateway's start script is executed inside the container. Named ONCE and used
  // twice below (the mount target and the entrypoint) so the two can never drift — a mismatch
  // between them is a container whose entrypoint does not exist, which Docker reports long
  // after `up -d` has already exited 0. The name mirrors the console image's own
  // `/usr/local/bin/lares-console-start`.
  const startScriptInContainer = "/usr/local/bin/lares-gateway-start";

  const services: Record<string, unknown> = {
    db: {
      image: imageFor(manifest, "db"),
      restart: "unless-stopped",
      command: ["postgres", "-c", "hba_file=/run/lares-auth/pg_hba.conf"],
      volumes: [`${opts.dbDataDir}:/var/lib/postgresql/data`, { type: "bind", source: opts.databaseAuthDir, target: "/run/lares-auth", read_only: true, bind: { create_host_path: false } }],
      ports: ["127.0.0.1:5432:5432"],
      networks: [opts.network],
    },
    console: {
      image: imageFor(manifest, "console"),
      restart: "unless-stopped",
      // Google sign-in credentials are installation-owned. Compose reads this
      // root-only file when present; no credential value enters the stack file.
      env_file: [{ path: join(dirname(opts.secretsDir), "console-oauth.env"), required: false }],
      volumes: [
        `${opts.socketDir}:/run/lares`,
        `${opts.tasteDir}:/srv/taste`,
        ...(opts.deadlineCalendarFile ? [`${opts.deadlineCalendarFile}:${DEADLINE_CALENDAR_IN_CONTAINER}:ro`] : []),
      ],
      secrets: [
        "console-session-secret",
        ...(consoleVaultSigningKeyFile ? ["console-vault-signing-key"] : []),
        ...(consoleModelPurposeSigningKeyFile ? ["console-model-purpose-signing-key"] : []),
        "eve-route-password",
        "database-password",
        "token-enc-key",
      ],
      // The console does NOT read DATABASE_URL — `services/console/lib/db.ts` builds its pool
      // from PGHOST/PGPORT/PGDATABASE/PGUSER and reads the password from PGPASSWORD_FILE. Its
      // own defaults already say `db` / 5432, but they are stated here so this file, not a
      // default buried in the image, decides where the console looks.
      environment: {
        LARES_CONFIGURED_MODEL_ALIAS: opts.modelAlias,
        CONSOLE_ALLOWED_EMAILS: opts.consoleAllowedEmails,
        AGENT_OWNER_USER_ID: opts.ownerId,
        OWNER_HOME_TZ: opts.ownerHomeTz,
        CONSOLE_OAUTH_REDIRECT: `https://${opts.domain}/api/auth/callback`,
        LARES_PUBLIC_DOOR_ORIGIN: `https://${opts.domain}`,
        CONSOLE_SESSION_SECRET_FILE: "/run/secrets/console-session-secret",
        ...(consoleVaultSigningKeyFile ? { CONSOLE_VAULT_SIGNING_KEY_FILE: "/run/secrets/console-vault-signing-key" } : {}),
        ...(consoleModelPurposeSigningKeyFile ? { CONSOLE_MODEL_PURPOSE_SIGNING_KEY_FILE: "/run/secrets/console-model-purpose-signing-key" } : {}),
        EVE_ROUTE_PASSWORD_FILE: "/run/secrets/eve-route-password",
        // The console encrypts the Google refresh token with the SAME key the agents decrypt
        // with (`services/console/lib/accounts.ts` → readSecret("TOKEN_ENC_KEY")); without it,
        // connecting an account throws.
        TOKEN_ENC_KEY_FILE: "/run/secrets/token-enc-key",
        PGHOST: "db",
        PGPORT: "5432",
        PGDATABASE: opts.pgDatabase,
        PGUSER: "lares_app",
        PGPASSWORD_FILE: "/run/secrets/database-password",
        NODE_ENV: "production",
        ...(opts.deadlineCalendarFile ? { DEADLINE_CALENDAR_FILE: DEADLINE_CALENDAR_IN_CONTAINER } : {}),
      },
      depends_on: ["db"],
      networks: [opts.network],
    },
    "lares-gateway": {
      image: imageFor(manifest, "lares-gateway"),
      restart: "unless-stopped",
      // The installer runs on the host and proves one model completion before migrations.
      // Keep this diagnostic route private to the host; agents use the Compose service name.
      ports: ["127.0.0.1:4000:4000"],
      // Virtual keys are persisted by LiteLLM, not represented in config.yaml. The gateway has
      // its own login and password file; it never receives the app or operator credentials.
      secrets: ["gateway-key", "gateway-master-key", "model-provider-key", "gateway-database-password"],
      volumes: [
        `${opts.gatewayConfigFile}:/etc/litellm/config.yaml:ro`,
        `${opts.gatewayStartScript}:${startScriptInContainer}:ro`,
        `${opts.gatewayStartScript}.admission_contract.py:/opt/lares-gateway/admission_contract.py:ro`,
        `${opts.gatewayStartScript}.lares_gateway.py:/opt/lares-gateway/lares_gateway.py:ro`,
        `${opts.gatewayConfigFile}.profile.json:/etc/litellm/profile.json:ro`,
      ],
      // THE ENGINE SHIPS NO GATEWAY IMAGE, AND MAY NOT. The obvious way to give LiteLLM our
      // start script is a thin image FROM the official one — and that is ruled out: the
      // official image carries its own `enterprise/` tree (upstream Dockerfile,
      // `COPY --from=builder /app/enterprise /app/enterprise`), whose licence says in as many
      // words "it is forbidden to copy, merge, publish, distribute, sublicense, and/or sell
      // the Software". Pushing a derived image to our registry, which every installation
      // pulls from, is exactly that. It would also break the one supply-chain control the
      // project decided to keep: LiteLLM
      // signs its images with cosign from v1.83.0, and a derived image is not the artefact
      // upstream signed, so nothing downstream could verify it. So the release manifest names
      // the UPSTREAM digest, and the script reaches the container as a read-only bind mount
      // used as the entrypoint. Same file, no redistribution, signature chain intact.
      //
      // THE IMAGE MUST BE THE DEFAULT (ROOT) LITELLM VARIANT, NOT `-non_root`. Checked live
      // against the registry on 2026-09-21, reading each image's own config blob:
      // `ghcr.io/berriai/litellm` is `User: "root"`, `ghcr.io/berriai/litellm-non_root` is
      // `User: "65534"` (a uid only, so gid 0). The secrets below are `0440 root:$LARES_
      // RUNTIME_GID` (see install.sh), and compose's file-secrets are bind
      // mounts that preserve the host's owner and mode — the long-syntax `uid`/`gid`/`mode`
      // keys are swarm-only and silently ignored here. uid 65534 / gid 0 matches neither the
      // owner nor the group, and 0440 grants nothing to other: a non-root LiteLLM gets EACCES
      // on its own credentials, start.sh exits 78, and `docker compose up -d` still exits 0 —
      // the silent-start failure this track has already fixed three times. Root reads them by
      // ownership. Saying it plainly rather than leaving it implied: this container runs as
      // root, and what makes that acceptable is that it publishes no port, sits on the
      // fleet's own network, and reads a config that names no secret value.
      // (The alternative — `-non_root` plus `user: "65534:<runtime gid>"` here — needs that
      // gid plumbed through bin/render-stack.ts, and is a separate decision, not this one.)
      entrypoint: [startScriptInContainer],
      // NO `command:`. It used to read `["--config", "/etc/litellm/config.yaml"]`, which is
      // argv handed to the entrypoint above — a script that never reads `$@`. One path, one
      // place: `images/gateway-runtime/start.sh` ends `exec litellm --config
      // /etc/litellm/config.yaml`, and that is the only spelling of it. Upstream's own
      // `Cmd: ["--port", "4000"]` goes the same way, harmlessly: 4000 is litellm's default
      // port, which is what `GATEWAY_URL` (http://lares-gateway:4000) already expects.
      environment: {
        // LiteLLM documents this as an env-only switch (not a config.yaml key): loading its
        // bundled cost map instead of fetching one over the network at start.
        LITELLM_LOCAL_MODEL_COST_MAP: "True",
        LARES_GATEWAY_PROFILE_FILE: "/etc/litellm/profile.json",
        // Admission URL/service key/endpoint identity are deliberately NOT provisioned.
        // Until an operator supplies the real authority, this runtime fails closed.
        // `images/gateway-runtime/start.sh` reads both files and exports their contents as the
        // two `os.environ/…` names the LiteLLM config refers to. It refuses to start at all
        // (`: "${MODEL_PROVIDER_KEY_FILE:?…}"`) unless both names are set here, so these are
        // not optional hints — they are the whole of how the gateway gets its credentials.
        // The paths mirror the on-disk secret names exactly, as every other service's do.
        MODEL_PROVIDER_KEY_FILE: "/run/secrets/model-provider-key",
        GATEWAY_MASTER_KEY_FILE: "/run/secrets/gateway-master-key",
        DATABASE_PASSWORD_FILE: "/run/secrets/gateway-database-password",
        PGHOST: "db",
        PGPORT: "5432",
        PGDATABASE: "litellm",
        PGUSER: "lares_gateway",
      },
      depends_on: ["db"],
      networks: [opts.network],
    },
    caddy: {
      image: imageFor(manifest, "caddy"),
      restart: "unless-stopped",
      // The Caddyfile opens with `{$LARES_DOMAIN}` — Caddy's own environment substitution,
      // resolved inside this container from THIS environment. Without it the site block has
      // no address and Caddy does not start.
      environment: {
        LARES_DOMAIN: opts.domain,
      },
      volumes: [`${opts.caddyfile}:/etc/caddy/Caddyfile:ro`, `${opts.caddyDataDir}:/data`],
      ports: ["80:80", "443:443"],
      depends_on: ["console"],
      networks: [opts.network],
    },
  };

  const secrets: Record<string, unknown> = {
    "database-password": secret("database-password"),
    "console-session-secret": secret("console-session-secret"),
    ...(consoleVaultSigningKeyFile ? { "console-vault-signing-key": { file: consoleVaultSigningKeyFile } } : {}),
    ...(consoleModelPurposeSigningKeyFile ? { "console-model-purpose-signing-key": { file: consoleModelPurposeSigningKeyFile } } : {}),
    "eve-route-password": secret("eve-route-password"),
    "gateway-key": secret("gateway-key"),
    "gateway-master-key": secret("gateway-master-key"),
    "model-provider-key": secret("model-provider-key"),
    "gateway-database-password": secret("gateway-database-password"),
    "token-enc-key": secret("token-enc-key"),
  };

  // `name:` is not decoration. Without it Compose calls the network it creates
  // "<project>_<key>" (a compose file in /opt/lares becomes `lares_lares-network`), while
  // `compose.lares-keeper.yaml` joins it as `external: true` + `name: ${LARES_NETWORK}` and
  // `services/keeper/lib/docker.ts` runs a LITERAL `docker network inspect <network>`. Naming
  // it here is what makes those three agree on one string.
  const networks = {
    [opts.network]: {
      name: opts.network,
      driver: "bridge",
      ipam: { config: [{ subnet: opts.subnet }] },
    },
  };

  return stringify({ services, secrets, networks });
}

/** One-shot first-init stack. install.sh removes this container before starting the normal
 *  stack, whose database service has no operator secret mount. */
export function renderDatabaseBootstrapCompose(manifest: ReleaseManifest, opts: DatabaseBootstrapComposeOptions): string {
  if (!isAbsolute(opts.operatorPasswordFile) || /[\n\r\0]/.test(opts.operatorPasswordFile))
    throw new Error("Database operator password path must be absolute");
  if (!isAbsolute(opts.databaseAuthDir) || /[\n\r\0]/.test(opts.databaseAuthDir))
    throw new Error("Database authentication directory path must be absolute");
  const services = {
    db: {
      image: imageFor(manifest, "db"),
      restart: "unless-stopped",
      command: ["postgres", "-c", "hba_file=/run/lares-auth/pg_hba.conf"],
      environment: {
        POSTGRES_DB: "postgres",
        POSTGRES_USER: "lares_operator",
        POSTGRES_PASSWORD_FILE: "/run/secrets/operator-password",
      },
      secrets: ["operator-password"],
      volumes: [`${opts.dbDataDir}:/var/lib/postgresql/data`, { type: "bind", source: opts.databaseAuthDir, target: "/run/lares-auth", read_only: true, bind: { create_host_path: false } }],
      ports: ["127.0.0.1:5432:5432"],
      networks: [opts.network],
    },
  };
  const secrets = { "operator-password": { file: opts.operatorPasswordFile } };
  const networks = {
    [opts.network]: {
      name: opts.network,
      driver: "bridge",
      ipam: { config: [{ subnet: opts.subnet }] },
    },
  };
  return stringify({ services, secrets, networks });
}
