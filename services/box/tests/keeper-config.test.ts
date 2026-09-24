// W8F-F7b — the file the keeper boots from, rendered from the same release the installer was
// given, with every possible first role bound to the real owner.
//
// THE SCHEMA THIS PARSES AGAINST IS THE KEEPER'S OWN, AND IT IS `configSchema`, NOT
// `lifecycleSchema`. The slice's original test asserted only that `lifecycleSchema.parse(...)`
// did not throw — which would have passed on a file `loadKeeperConfig` refuses to boot from:
// `/etc/lares/keeper.json` is a `.strict()` object with eleven more required top-level fields
// (mode, project, dir, files, agentsDir, retiredDir, secretsDir, rolesDir, templatesDir,
// backupDir, db) and `lifecycle` as an OPTIONAL nested one. So this writes the rendered object
// to a real file and hands it to `loadKeeperConfig`, the function the keeper container itself
// calls at startup. Nothing here runs Docker, reaches a network, or names a real registry,
// domain or person.
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadKeeperConfig } from "../../keeper/lib/config.js";
import { renderKeeperConfig, AGENTS_COMPOSE_FILE } from "../lib/keeper-config.js";
import type { KeeperConfigOptions } from "../lib/keeper-config.js";
import type { ReleaseManifest } from "../lib/release-manifest.js";

const D = (n: string) => `example.invalid/lares-${n}@sha256:${"a".repeat(64)}`;

/** Every image this configuration names, and nothing else. `lares-egress-proxy` and
 *  `lares-firewall-helper` are their OWN keys: `compose.lares-keeper.yaml` names
 *  `LARES_KEEPER_IMAGE` and `LARES_SQUID_IMAGE` as two separate variables, and
 *  `services/keeper/lib/docker.ts` runs `firewallImage` with `--entrypoint nft` — three
 *  different images, three manifest keys, matching the three images CI publishes
 *  (lares-keeper, lares-egress-proxy, lares-firewall-helper). */
const MANIFEST: ReleaseManifest = {
  release: "2026-10-01",
  images: {
    db: D("db"),
    console: D("console"),
    "lares-gateway": D("gateway"),
    caddy: D("caddy"),
    "lares-keeper": D("keeper"),
    "lares-egress-proxy": D("egress-proxy"),
    "lares-firewall-helper": D("firewall-helper"),
    "chief-of-staff": D("chief-of-staff"),
    travel: D("travel"),
    creative: D("creative"),
  },
  migrations: { box: "087_update_history.sql" },
  breaking: [],
};

/** The real defaults `ops/install.sh` uses (`${PGUSER:-lares}`, `${PGDATABASE:-lares_state}`),
 *  and an owner fixture that names nobody. */
const OPTS: KeeperConfigOptions = {
  project: "lares",
  network: "lares-network",
  subnet: "172.30.0.0/24",
  proxyAddress: "172.30.0.2",
  dir: "/srv/lares",
  agentsDir: "/srv/lares/agents",
  retiredDir: "/srv/lares/retired",
  backupDir: "/srv/lares/backup",
  egressDir: "/srv/lares/egress",
  secretsDir: "/etc/lares/secrets",
  pgUser: "lares",
  pgDatabase: "lares_state",
  gatewayUrl: "http://lares-gateway:4000",
  ownerId: "fixture-owner",
};

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Writes the rendered object exactly as `install.sh` will, and reads it back through the
 *  keeper's own loader — the one function whose refusal is a keeper that does not boot. */
function loadAsKeeperWould(config: unknown) {
  const dir = mkdtempSync(join(tmpdir(), "lares-keeper-config-"));
  dirs.push(dir);
  const file = join(dir, "keeper.json");
  writeFileSync(file, JSON.stringify(config));
  return loadKeeperConfig(file);
}

describe("the generated keeper configuration", () => {
  it("is one the keeper's own loader accepts, not merely a lifecycle block", () => {
    const config = renderKeeperConfig(MANIFEST, OPTS);
    expect(() => loadAsKeeperWould(config)).not.toThrow();
    // Survives the round trip unchanged: nothing in it is defaulted in by the schema.
    expect(loadAsKeeperWould(config)).toEqual(config);
  });

  it("refuses a role default stored under a different role key", () => {
    const config = renderKeeperConfig(MANIFEST, OPTS);
    config.lifecycle!.defaultBindings!.creative!.role = "travel";
    expect(() => loadAsKeeperWould(config)).toThrow("keeper: invalid or unreadable configuration");
  });

  it("binds an arbitrary first-agent name to the real owner and shared route password by role", () => {
    const config = renderKeeperConfig(MANIFEST, OPTS);
    expect(config.lifecycle!.bindings).toBeUndefined();
    expect(Object.keys(config.lifecycle!.defaultBindings!)).toEqual([
      "chief-of-staff",
      "travel",
      "creative",
    ]);
    // The owner travels as `ownerId`, NOT as an environment override: `AGENT_OWNER_USER_ID` is
    // outside `environmentKeys`, and services/keeper/tests/runtime-bindings.test.ts already
    // asserts that a binding trying to set it is refused.
    for (const binding of Object.values(config.lifecycle!.defaultBindings!)) {
      expect(binding!.ownerId).toBe("fixture-owner");
      expect(binding!.environment).toEqual({});
      // The keeper mounts `${agentsDir}/${name}:/definition:ro` itself (compose-agents.ts), so
      // no definition folder is carried here.
      expect(binding!.mounts).toEqual([]);
    }
    expect(config.lifecycle!.defaultBindings!["chief-of-staff"]!.secrets).toEqual({
      EVE_SAGA_ROUTE_PASSWORD_FILE: "/etc/lares/secrets/eve-route-password",
    });
    for (const role of ["travel", "creative"] as const) {
      expect(config.lifecycle!.defaultBindings![role]!.secrets).toEqual({
        EVE_ROUTE_PASSWORD_FILE: "/etc/lares/secrets/eve-route-password",
      });
    }
    expect(config.secretsDir).toBe("/srv/lares/secrets");
  });

  it("gives the keeper the admin credential used to mint a key for any first-agent name", () => {
    const config = renderKeeperConfig(MANIFEST, OPTS);
    expect(config.lifecycle!.runtime.gatewayKeys).toEqual({});
    expect(config.lifecycle!.runtime.gatewayMasterKeyFile)
      .toBe("/etc/lares/secrets/gateway-master-key");
  });

  it("takes every image from the manifest, never a literal default", () => {
    const config = renderKeeperConfig(MANIFEST, OPTS);
    const lifecycle = config.lifecycle!;
    expect(lifecycle.imageByRole).toEqual({
      "chief-of-staff": D("chief-of-staff"),
      travel: D("travel"),
      creative: D("creative"),
    });
    expect(lifecycle.squidImage).toBe(D("egress-proxy"));
    expect(lifecycle.firewallImage).toBe(D("firewall-helper"));
  });

  it("refuses by name when the manifest names no image for something it needs", () => {
    for (const missing of [
      "chief-of-staff",
      "travel",
      "creative",
      "lares-egress-proxy",
      "lares-firewall-helper",
    ]) {
      const images = { ...MANIFEST.images };
      delete images[missing];
      expect(() => renderKeeperConfig({ ...MANIFEST, images }, OPTS)).toThrow(
        new RegExp(`no image for "${missing}"`),
      );
    }
  });

  it("points both databases at the internal service name, not the loopback-published port", () => {
    const config = renderKeeperConfig(MANIFEST, OPTS);
    for (const db of [config.db, config.lifecycle!.adminDb]) {
      expect(db.host).toBe("db");
      expect(db.port).toBe(5432);
      expect(db.database).toBe("lares_state");
      expect(db.user).toBe("lares");
      expect(db.passwordFile).toBe("/etc/lares/secrets/database-password");
    }
    expect(config.lifecycle!.runtime.databaseUrl).toBe("postgres://lares@db:5432/lares_state");
  });

  it("writes the agents' compose file inside the one directory the keeper container mounts", () => {
    const config = renderKeeperConfig(MANIFEST, OPTS);
    // `compose.lares-keeper.yaml` mounts ${LARES_ROOT} at the SAME absolute path and nothing
    // else of the host, so a compose file the keeper writes anywhere outside that root is a
    // file it cannot write. `dir` + `files` (docker.ts:8) and `composeFile` (docker.ts:47) are
    // two readings of the same file and must agree.
    expect(config.dir).toBe("/srv/lares");
    expect(config.files).toEqual([AGENTS_COMPOSE_FILE]);
    expect(config.lifecycle!.composeFile).toBe(join("/srv/lares", AGENTS_COMPOSE_FILE));
  });

  it("names the network the stack actually created, and reserves the proxy's address", () => {
    const config = renderKeeperConfig(MANIFEST, OPTS);
    // `docker.ts`'s inventory runs a LITERAL `docker network inspect <network>`, and F7a made
    // renderStackCompose emit the network's own `name:`, so this string is the created network.
    expect(config.lifecycle!.network).toBe("lares-network");
    expect(config.lifecycle!.reservedAddresses).toEqual(["172.30.0.2"]);
    expect(config.lifecycle!.egress.internalNetworks).toEqual(["172.30.0.0/24"]);
  });
});
