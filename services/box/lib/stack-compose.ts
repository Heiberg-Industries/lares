/**
 * The neutral stack: one compose file, rendered from the release manifest. Names no
 * installation — every image comes from `imageFor(manifest, service)`, which already refuses
 * by name when the manifest names none. The keeper's own agents are a separate file (F7 brings
 * both up together); this file never mentions the keeper.
 */
import { stringify } from "yaml";
import { dirname, join } from "node:path";
import { imageFor, type ReleaseManifest } from "./release-manifest.js";

export interface StackComposeOptions {
  /** Absolute path to the secrets directory ($PREFIX/etc/lares/secrets). */
  readonly secretsDir: string;
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
  readonly network: string; // e.g. "lares-network" — created by this file, NOT external
  readonly subnet: string; // e.g. "172.30.0.0/24"
  /** The domain the installation answers on (LARES_DOMAIN). It reaches Caddy through the
   *  caddy service's OWN environment, because the Caddyfile substitutes it from the Caddy
   *  process's environment inside the container — not from the host's, and not from compose. */
  readonly domain: string;
  /** Owner allow-list entry written by the installer, never a built-in identity. */
  readonly ownerEmail: string;
  /** The only purpose alias the on-box gateway config actually defines. */
  readonly modelAlias: string;
  readonly pgUser: string;
  readonly pgDatabase: string;
}

/** Renders the ENTIRE stack: db, console, lares-gateway, caddy. Refuses (throws
 *  ReleaseManifestInvalid, re-thrown from imageFor) if the manifest names no image for one of
 *  them. Never mentions the keeper — F7 appends that service with a second file. */
export function renderStackCompose(manifest: ReleaseManifest, opts: StackComposeOptions): string {
  const secret = (name: string) => ({ file: `${opts.secretsDir}/${name}` });
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
      environment: {
        POSTGRES_DB: opts.pgDatabase,
        POSTGRES_USER: opts.pgUser,
        POSTGRES_PASSWORD_FILE: "/run/secrets/database-password",
      },
      secrets: ["database-password"],
      volumes: [`${opts.dbDataDir}:/var/lib/postgresql/data`],
      ports: ["127.0.0.1:5432:5432"],
      networks: [opts.network],
    },
    console: {
      image: imageFor(manifest, "console"),
      restart: "unless-stopped",
      // Google sign-in credentials are installation-owned. Compose reads this
      // root-only file when present; no credential value enters the stack file.
      env_file: [{ path: join(dirname(opts.secretsDir), "console-oauth.env"), required: false }],
      secrets: [
        "console-session-secret",
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
        CONSOLE_ALLOWED_EMAILS: opts.ownerEmail,
        CONSOLE_OAUTH_REDIRECT: `https://${opts.domain}/api/auth/callback`,
        CONSOLE_SESSION_SECRET_FILE: "/run/secrets/console-session-secret",
        EVE_ROUTE_PASSWORD_FILE: "/run/secrets/eve-route-password",
        // The console encrypts the Google refresh token with the SAME key the agents decrypt
        // with (`services/console/lib/accounts.ts` → readSecret("TOKEN_ENC_KEY")); without it,
        // connecting an account throws.
        TOKEN_ENC_KEY_FILE: "/run/secrets/token-enc-key",
        PGHOST: "db",
        PGPORT: "5432",
        PGDATABASE: opts.pgDatabase,
        PGUSER: opts.pgUser,
        PGPASSWORD_FILE: "/run/secrets/database-password",
        NODE_ENV: "production",
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
      // Virtual keys are persisted by LiteLLM, not represented in config.yaml. The gateway
      // therefore needs its own database and the same file-only database credential discipline
      // as every other service in this stack. install.sh creates the `litellm` database before
      // it starts this service; the entrypoint turns these non-secret coordinates plus the
      // mounted password file into DATABASE_URL without ever putting the password in Compose.
      secrets: ["gateway-key", "gateway-master-key", "model-provider-key", "database-password"],
      volumes: [
        `${opts.gatewayConfigFile}:/etc/litellm/config.yaml:ro`,
        `${opts.gatewayStartScript}:${startScriptInContainer}:ro`,
      ],
      // THE ENGINE SHIPS NO GATEWAY IMAGE, AND MAY NOT. The obvious way to give LiteLLM our
      // start script is a thin image FROM the official one — and that is ruled out: the
      // official image carries its own `enterprise/` tree (upstream Dockerfile,
      // `COPY --from=builder /app/enterprise /app/enterprise`), whose licence says in as many
      // words "it is forbidden to copy, merge, publish, distribute, sublicense, and/or sell
      // the Software". Pushing a derived image to our registry, which every installation
      // pulls from, is exactly that. It would also break the one supply-chain control the
      // project decided to keep (docs/research/2026-09-18-prelaunch/08-litellm-okf.md): LiteLLM
      // signs its images with cosign from v1.83.0, and a derived image is not the artefact
      // upstream signed, so nothing downstream could verify it. So the release manifest names
      // the UPSTREAM digest, and the script reaches the container as a read-only bind mount
      // used as the entrypoint. Same file, no redistribution, signature chain intact.
      //
      // THE IMAGE MUST BE THE DEFAULT (ROOT) LITELLM VARIANT, NOT `-non_root`. Checked live
      // against the registry on 2026-09-21, reading each image's own config blob:
      // `ghcr.io/berriai/litellm` is `User: "root"`, `ghcr.io/berriai/litellm-non_root` is
      // `User: "65534"` (a uid only, so gid 0). The secrets below are `0440 root:$LARES_
      // RUNTIME_GID` (owner decision A1, install.sh), and compose's file-secrets are bind
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
        // `images/gateway-runtime/start.sh` reads both files and exports their contents as the
        // two `os.environ/…` names the LiteLLM config refers to. It refuses to start at all
        // (`: "${MODEL_PROVIDER_KEY_FILE:?…}"`) unless both names are set here, so these are
        // not optional hints — they are the whole of how the gateway gets its credentials.
        // The paths mirror the on-disk secret names exactly, as every other service's do.
        MODEL_PROVIDER_KEY_FILE: "/run/secrets/model-provider-key",
        GATEWAY_MASTER_KEY_FILE: "/run/secrets/gateway-master-key",
        DATABASE_PASSWORD_FILE: "/run/secrets/database-password",
        PGHOST: "db",
        PGPORT: "5432",
        PGDATABASE: "litellm",
        PGUSER: opts.pgUser,
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
    "eve-route-password": secret("eve-route-password"),
    "gateway-key": secret("gateway-key"),
    "gateway-master-key": secret("gateway-master-key"),
    "model-provider-key": secret("model-provider-key"),
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
