import { describe, it, expect } from "vitest";
import { parse } from "yaml";
import { renderStackCompose } from "../lib/stack-compose.js";
import type { ReleaseManifest } from "../lib/release-manifest.js";

const D = (n: string) => `example.invalid/lares-${n}@sha256:${"a".repeat(64)}`;

const MANIFEST: ReleaseManifest = {
  release: "2026-10-01",
  images: { db: D("db"), console: D("console"), "lares-gateway": D("gateway"), caddy: D("caddy") },
  migrations: { box: "087_update_history.sql" },
  breaking: [],
};

const OPTS = {
  secretsDir: "/etc/lares/secrets",
  socketDir: "/run/lares",
  gatewayConfigFile: "/etc/lares/litellm-config.yaml",
  gatewayStartScript: "/etc/lares/gateway-start.sh",
  caddyfile: "/etc/lares/Caddyfile",
  caddyDataDir: "/var/lib/lares/caddy",
  dbDataDir: "/var/lib/lares/postgres",
  network: "lares-network",
  subnet: "172.30.0.0/24",
  domain: "example.invalid",
  consoleAllowedEmails: "owner@example.invalid",
  modelAlias: "lares-brain",
  pgUser: "lares",
  pgDatabase: "lares_state",
};

describe("the generated stack compose file", () => {
  it("names every service by digest, and nothing else", () => {
    const doc = parse(renderStackCompose(MANIFEST, OPTS)) as any;
    expect(doc.services.db.image).toBe(D("db"));
    expect(doc.services.console.image).toBe(D("console"));
    expect(doc.services["lares-gateway"].image).toBe(D("gateway"));
    expect(doc.services.caddy.image).toBe(D("caddy"));
  });

  it("refuses when the manifest names no image for a service this file needs", () => {
    const { console: _drop, ...images } = MANIFEST.images;
    expect(() => renderStackCompose({ ...MANIFEST, images }, OPTS)).toThrow(/console/);
  });

  it("publishes the database port to loopback only, matching run_database's own PGHOST default", () => {
    const doc = parse(renderStackCompose(MANIFEST, OPTS)) as any;
    expect(doc.services.db.ports).toEqual(["127.0.0.1:5432:5432"]);
    expect(doc.services["lares-gateway"].ports).toEqual(["127.0.0.1:4000:4000"]);
  });

  it("publishes nothing else — only caddy opens a port beyond loopback (owner decision C2: this engine never touches a firewall, so a port it does not publish here can never be reached from outside)", () => {
    const doc = parse(renderStackCompose(MANIFEST, OPTS)) as any;
    for (const [name, svc] of Object.entries(doc.services) as [string, any][]) {
      if (name === "db" || name === "lares-gateway") continue;
      if (name === "caddy") { expect(svc.ports).toEqual(["80:80", "443:443"]); continue; }
      expect(svc.ports ?? []).toEqual([]);
    }
  });

  it("mounts the database password under the name agents already use, never the other spelling", () => {
    const doc = parse(renderStackCompose(MANIFEST, OPTS)) as any;
    expect(doc.secrets["database-password"].file).toBe("/etc/lares/secrets/database-password");
    expect(doc.services.db.environment.POSTGRES_PASSWORD_FILE).toBe("/run/secrets/database-password");
    expect(doc.services.db.secrets).toContain("database-password");
  });

  it("gives the console every secret it actually reads, or it cannot reach the database or an account", () => {
    const doc = parse(renderStackCompose(MANIFEST, OPTS)) as any;
    const env = doc.services.console.environment;
    // services/console/lib/db.ts reads PGPASSWORD_FILE, never DATABASE_URL.
    expect(env.PGPASSWORD_FILE).toBe("/run/secrets/database-password");
    expect(env.PGHOST).toBe("db");
    expect(env.PGDATABASE).toBe(OPTS.pgDatabase);
    expect(env.PGUSER).toBe(OPTS.pgUser);
    expect(env.LARES_CONFIGURED_MODEL_ALIAS).toBe(OPTS.modelAlias);
    expect(env.CONSOLE_ALLOWED_EMAILS).toBe(OPTS.consoleAllowedEmails);
    expect(env.CONSOLE_OAUTH_REDIRECT).toBe("https://example.invalid/api/auth/callback");
    expect(doc.services.console.env_file).toEqual([
      { path: "/etc/lares/console-oauth.env", required: false },
    ]);
    expect(doc.services.console.volumes).toContain("/run/lares:/run/lares");
    expect(env.DATABASE_URL).toBeUndefined();
    // services/console/lib/accounts.ts throws without it when an account is connected.
    expect(env.TOKEN_ENC_KEY_FILE).toBe("/run/secrets/token-enc-key");
    for (const name of [
      "database-password",
      "token-enc-key",
      "console-session-secret",
      "eve-route-password",
    ]) {
      expect(doc.services.console.secrets).toContain(name);
      expect(doc.secrets[name].file).toBe(`${OPTS.secretsDir}/${name}`);
    }
  });

  it("turns the gateway's local cost map on, so it loads costs without a network fetch at start", () => {
    const doc = parse(renderStackCompose(MANIFEST, OPTS)) as any;
    expect(doc.services["lares-gateway"].environment.LITELLM_LOCAL_MODEL_COST_MAP).toBe("True");
  });

  it("brings every service back after a reboot — a stack that does not restart is not a stack", () => {
    const doc = parse(renderStackCompose(MANIFEST, OPTS)) as any;
    for (const svc of Object.values(doc.services) as any[]) {
      expect(svc.restart).toBe("unless-stopped");
    }
  });

  it("names no installation anywhere in the rendered text", () => {
    const text = renderStackCompose(MANIFEST, OPTS);
    for (const banned of ["bendik", "heiberg", "lares-agent", "saga", "marcel", "calliope"]) {
      expect(text.toLowerCase()).not.toContain(banned);
    }
  });

  it("defines the network itself — it is not external, unlike compose.lares-keeper.yaml's", () => {
    const doc = parse(renderStackCompose(MANIFEST, OPTS)) as any;
    expect(doc.networks[OPTS.network].external).toBeUndefined();
    expect(doc.networks[OPTS.network].ipam.config[0].subnet).toBe(OPTS.subnet);
  });

  // Compose names a network it creates "<project>_<key>" unless the definition carries its own
  // `name:`. compose.lares-keeper.yaml joins this same network with `external: true` +
  // `name: ${LARES_NETWORK:?existing network}`, and services/keeper/lib/docker.ts's inventory
  // runs a LITERAL `docker network inspect <network>` — so a project prefix here is three
  // places disagreeing about one name, and the keeper throws "Network unavailable".
  it("names the network itself, so compose does not project-prefix what the keeper looks up literally", () => {
    const doc = parse(renderStackCompose(MANIFEST, OPTS)) as any;
    expect(doc.networks[OPTS.network].name).toBe(OPTS.network);
  });

  // services/box/ops/Caddyfile opens with `{$LARES_DOMAIN}` — Caddy's OWN substitution, read
  // from the Caddy process's environment inside the container. Unset, it substitutes to empty,
  // the site block has no address, and Caddy does not start.
  it("gives Caddy the domain in its own environment, or its site block has no address", () => {
    const doc = parse(renderStackCompose(MANIFEST, OPTS)) as any;
    expect(doc.services.caddy.environment.LARES_DOMAIN).toBe(OPTS.domain);
  });

  // images/gateway-runtime/start.sh refuses outright — `: "${MODEL_PROVIDER_KEY_FILE:?...}"`,
  // then the same for GATEWAY_MASTER_KEY_FILE — unless both names are set. Both point at the
  // mounted secret paths, which mirror the on-disk names exactly.
  // F7a-2 writes this file (bin/render-stack.ts); this file only mounts it, read-only, where
  // the gateway's own start script points LiteLLM (gateway-start-script.test.ts).
  it("mounts the generated gateway config where the gateway container reads it", () => {
    const doc = parse(renderStackCompose(MANIFEST, OPTS)) as any;
    expect(doc.services["lares-gateway"].volumes)
      .toContain(`${OPTS.gatewayConfigFile}:/etc/litellm/config.yaml:ro`);
  });

  // F7c — ONE PLACE NAMES THE CONFIG PATH, and it is the start script. Until this slice the
  // service carried `command: ["--config", "/etc/litellm/config.yaml"]` AND the script ended
  // `exec litellm --config /etc/litellm/config.yaml`: two spellings of one path, and once the
  // script is the entrypoint the compose one is argv handed to a script that never reads `$@`.
  // Silently dead, and free to drift from the path this same file mounts the config at.
  it("makes the engine's own start script the entrypoint and lets it alone name the config path", () => {
    const doc = parse(renderStackCompose(MANIFEST, OPTS)) as any;
    const gateway = doc.services["lares-gateway"];
    const mount = (gateway.volumes as string[]).find((v) => v.startsWith(`${OPTS.gatewayStartScript}:`));
    expect(mount, "the gateway's start script is not mounted into the container at all").toBeTruthy();
    const [, target, mode] = String(mount).split(":");
    // The two strings that must agree or the container starts nothing: what the volume mounts
    // the script AT, and what the entrypoint EXECUTES. Asserted against each other, never
    // against a literal transcribed twice.
    expect(gateway.entrypoint).toEqual([target]);
    expect(mode, "the start script is mounted writable").toBe("ro");
    expect(
      gateway.command,
      "the compose `command:` is back — it is argv to a start script that ignores $@, so it " +
        "is a second, dead spelling of the config path the script already names",
    ).toBeUndefined();
  });

  it("gives the gateway file-only credentials and its own database coordinates", () => {
    const doc = parse(renderStackCompose(MANIFEST, OPTS)) as any;
    const env = doc.services["lares-gateway"].environment;
    expect(env.MODEL_PROVIDER_KEY_FILE).toBe("/run/secrets/model-provider-key");
    expect(env.GATEWAY_MASTER_KEY_FILE).toBe("/run/secrets/gateway-master-key");
    expect(env.DATABASE_PASSWORD_FILE).toBe("/run/secrets/database-password");
    expect(env.PGHOST).toBe("db");
    expect(env.PGPORT).toBe("5432");
    expect(env.PGDATABASE).toBe("litellm");
    expect(env.PGUSER).toBe(OPTS.pgUser);
    expect(env.DATABASE_URL).toBeUndefined();
    expect(doc.services["lares-gateway"].secrets).toEqual(
      expect.arrayContaining(["model-provider-key", "gateway-master-key", "database-password"]),
    );
    expect(doc.services["lares-gateway"].depends_on).toContain("db");
  });
});
