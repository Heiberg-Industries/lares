// The file the keeper boots from, rendered from the same release the installer was
// given, with every possible first role bound to the real owner.
//
// THE SCHEMA THIS PARSES AGAINST IS THE KEEPER'S OWN, AND IT IS `configSchema`, NOT
// `lifecycleSchema`. An earlier version of this test asserted only that `lifecycleSchema.parse(...)`
// did not throw — which would have passed on a file `loadKeeperConfig` refuses to boot from:
// `/etc/lares/keeper.json` is a `.strict()` object with eleven more required top-level fields
// (mode, project, dir, files, agentsDir, retiredDir, secretsDir, rolesDir, templatesDir,
// backupDir, db) and `lifecycle` as an OPTIONAL nested one. So this writes the rendered object
// to a real file and hands it to `loadKeeperConfig`, the function the keeper container itself
// calls at startup. Nothing here runs Docker, reaches a network, or names a real registry,
// domain or person.
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadKeeperConfig } from "../../keeper/lib/config.js";
import { main as renderConfigCommand } from "../bin/render-keeper-config.js";
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
    creative: D("creative"),
  },
  migrations: { box: "001_baseline.sql" },
  breaking: [],
};

/** The real defaults the installer uses (`lares_app`, `lares_state`),
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
  pgDatabase: "lares_state",
  gatewayUrl: "http://lares-gateway:4000",
  ownerId: "fixture-owner",
  publicDoorOrigin: "https://lares.example.com",
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

describe("fresh install settings", () => {
  it("writes the public door origin the keeper reads", () => {
    const config = renderKeeperConfig(MANIFEST, OPTS);
    expect(config.publicDoorOrigin).toBe("https://lares.example.com");
    expect(config.designatedOwnerId).toBe(OPTS.ownerId);
    expect(config.vaultConsoleSigningKeyFile).toBe("/etc/lares/secrets/console-vault-signing-key");
    expect(config.modelPurposeConsoleSigningKeyFile).toBeUndefined();
    expect(loadAsKeeperWould(config).publicDoorOrigin).toBe("https://lares.example.com");
  });

  it("preserves a separately configured model-purpose signer path", () => {
    const config = renderKeeperConfig(MANIFEST, { ...OPTS, modelPurposeConsoleSigningKeyFile: "/etc/lares/secrets/console-model-purpose-signing-key", modelPurposeRuntimeDir: "/run/lares/model-purpose" });
    expect(config.modelPurposeConsoleSigningKeyFile).toBe("/etc/lares/secrets/console-model-purpose-signing-key");
    expect(config.modelPurposeRuntimeDir).toBe("/run/lares/model-purpose");
    expect(loadAsKeeperWould(config).modelPurposeConsoleSigningKeyFile).toBe(config.modelPurposeConsoleSigningKeyFile);
  });

  it("turns schedules on by default and keeps an earlier value", () => {
    expect(renderKeeperConfig(MANIFEST, OPTS).lifecycle!.runtime.schedulesLive).toBe(true);
    expect(renderKeeperConfig(MANIFEST, { ...OPTS, previousSchedulesLive: false }).lifecycle!.runtime.schedulesLive).toBe(false);
    expect(renderKeeperConfig(MANIFEST, { ...OPTS, previousSchedulesLive: true }).lifecycle!.runtime.schedulesLive).toBe(true);
  });

  it("hands the owner's time zone to both roles, and nothing when it is unknown", () => {
    const withTz = renderKeeperConfig(MANIFEST, { ...OPTS, ownerHomeTz: "Europe/Berlin" }).lifecycle!.defaultBindings!;
    expect(withTz["chief-of-staff"]!.environment).toEqual({ OWNER_HOME_TZ: "Europe/Berlin" });
    expect(withTz.creative!.environment).toEqual({ OWNER_HOME_TZ: "Europe/Berlin" });
    expect(() => loadAsKeeperWould(renderKeeperConfig(MANIFEST, { ...OPTS, ownerHomeTz: "Europe/Berlin" }))).not.toThrow();
    expect(renderKeeperConfig(MANIFEST, OPTS).lifecycle!.defaultBindings!.creative!.environment).toEqual({});
  });

  it("the command keeps a schedules value an earlier keeper.json held, and writes origin and zone", () => {
    const f = mkdtempSync(join(tmpdir(), "keeper-rerun-")); dirs.push(f);
    const release = join(f, "release.json");
    writeFileSync(release, JSON.stringify(MANIFEST));
    const out = join(f, "keeper.json.partial"), env = join(f, "keeper.env"), live = join(f, "keeper.json");
    const args = [release, out, env, live, "lares", "/srv/lares", "/srv/lares/agents", "/srv/lares/retired", "/srv/lares/backup", "/srv/lares/egress", "/etc/lares/secrets", "/run/lares", "/run/lares-host", "lares-network", "172.30.0.0/24", "172.30.0.2", "http://lares-gateway:4000", "lares_state", "fixture-owner", "owner@example.invalid", "lares.example.com", "Europe/Berlin"];
    expect(renderConfigCommand(args, () => {})).toBe(0);
    const first = JSON.parse(readFileSync(out, "utf8"));
    expect(first.publicDoorOrigin).toBe("https://lares.example.com");
    expect(first.lifecycle.runtime.schedulesLive).toBe(true);
    first.lifecycle.runtime.schedulesLive = false;
    writeFileSync(live, JSON.stringify(first));
    expect(renderConfigCommand(args, () => {})).toBe(0);
    expect(JSON.parse(readFileSync(out, "utf8")).lifecycle.runtime.schedulesLive).toBe(false);
  });
});

describe("the deadline calendar", () => {
  const CALENDAR = "/srv/lares/installation/deadline-calendar.json";

  it("is not bound at all when no calendar file is given", () => {
    const chief = renderKeeperConfig(MANIFEST, OPTS).lifecycle!.defaultBindings!["chief-of-staff"]!;
    expect(chief.environment).toEqual({});
    expect(chief.mounts).toEqual([]);
  });

  it("gives the chief of staff a read-only mount and the setting that names it, and passes the keeper's own check", () => {
    const config = renderKeeperConfig(MANIFEST, { ...OPTS, deadlineCalendarFile: CALENDAR });
    const bindings = config.lifecycle!.defaultBindings!;
    expect(bindings["chief-of-staff"]!.mounts).toEqual([{ source: CALENDAR, target: CALENDAR, readOnly: true }]);
    expect(bindings["chief-of-staff"]!.environment).toEqual({ DEADLINE_CALENDAR_FILE: CALENDAR });
    expect(() => loadAsKeeperWould(config)).not.toThrow();
  });

  it("never gives the creative agent the calendar", () => {
    const config = renderKeeperConfig(MANIFEST, { ...OPTS, deadlineCalendarFile: CALENDAR });
    const creative = config.lifecycle!.defaultBindings!.creative!;
    expect(creative.environment).toEqual({});
    expect(creative.mounts).toEqual([]);
  });
});

describe("the generated keeper configuration", () => {
  it("is one the keeper's own loader accepts, not merely a lifecycle block", () => {
    const config = renderKeeperConfig(MANIFEST, OPTS);
    expect(config.designatedOwnerId).toBe(OPTS.ownerId);
    expect(() => loadAsKeeperWould(config)).not.toThrow();
    // Survives the round trip unchanged: nothing in it is defaulted in by the schema.
    expect(loadAsKeeperWould(config)).toEqual(config);
  });

  it("refuses a role default stored under a different role key", () => {
    const config = renderKeeperConfig(MANIFEST, OPTS);
    config.lifecycle!.defaultBindings!.creative!.role = "chief-of-staff";
    expect(() => loadAsKeeperWould(config)).toThrow(/keeper: invalid configuration in .*lifecycle\.defaultBindings\.creative/);
  });

  it("binds an arbitrary first-agent name to the real owner and shared route password by role", () => {
    const config = renderKeeperConfig(MANIFEST, OPTS);
    expect(config.lifecycle!.bindings).toBeUndefined();
    expect(Object.keys(config.lifecycle!.defaultBindings!)).toEqual([
      "chief-of-staff",
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
      EVE_ROUTE_PASSWORD_FILE: "/etc/lares/secrets/eve-route-password",
    });
    expect(config.lifecycle!.defaultBindings!.creative!.secrets).toEqual({
      EVE_ROUTE_PASSWORD_FILE: "/etc/lares/secrets/eve-route-password",
    });
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
        creative: D("creative"),
    });
    expect(lifecycle.squidImage).toBe(D("egress-proxy"));
    expect(lifecycle.firewallImage).toBe(D("firewall-helper"));
  });

  it("refuses by name when the manifest names no image for something it needs", () => {
    for (const missing of [
      "chief-of-staff",
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
    expect(config.db).toEqual({host:"db",port:5432,database:"lares_state",user:"lares_app",passwordFile:"/etc/lares/secrets/database-password"});
    expect(config.lifecycle!.adminDb).toMatchObject({database:"postgres",user:"lares_workflow_provisioner",passwordFile:"/etc/lares/secrets/workflow-provisioner-password"});
    expect(config.lifecycle!.workflowOwner).toBe("lares_workflow_owner");
    expect(config.lifecycle!.runtime.databaseUrl).toBe("postgres://lares_app@db:5432/lares_state");
    expect(config.lifecycle!.runtime.workflowServer).toBe("postgres://lares_workflow@db:5432/");
    expect(config.lifecycle!.runtime.workflowPasswordFile).toBe("/etc/lares/secrets/workflow-password");
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
    // `docker.ts`'s inventory runs a LITERAL `docker network inspect <network>`, and the stack renderer made
    // renderStackCompose emit the network's own `name:`, so this string is the created network.
    expect(config.lifecycle!.network).toBe("lares-network");
    expect(config.lifecycle!.reservedAddresses).toEqual(["172.30.0.2"]);
    expect(config.lifecycle!.egress.internalNetworks).toEqual(["172.30.0.0/24"]);
  });
});

it("exposes an explicit administrator and unprepared Notion slot without adopting an external token", () => {
  const config = renderKeeperConfig(MANIFEST, { ...OPTS, credentialAdministrator: "owner@example.invalid" });
  expect(loadAsKeeperWould(config).credentials).toEqual({
    administrator: "owner@example.invalid", slot: "notion:shared", binding: "NOTION_TOKEN_FILE",
    prepared: false, inventoryComplete: false, retainedConsumers: [],
  });
  expect(config.secretsDir).toBe("/srv/lares/secrets");
  expect(Object.values(config.lifecycle!.defaultBindings!).every(b => !b!.secrets.NOTION_TOKEN_FILE)).toBe(true);
  expect(renderKeeperConfig(MANIFEST, OPTS).credentials!.administrator).toBeUndefined();
});

it("renderer rejects ambiguous or malformed administrator emails before writing files", () => {
  for (const administrator of ["a..b@example.com", ".a@example.com", "one@example.invalid,two@example.invalid", ""]) {
    const f=mkdtempSync(join(tmpdir(),"keeper-admin-render-"));dirs.push(f);
    const out=join(f,"keeper.json"),env=join(f,"keeper.env");
    const args=[join(f,"missing-release.json"),out,env,out,"lares","/srv/lares","/srv/lares/agents","/srv/lares/retired","/srv/lares/backup","/srv/lares/egress","/etc/lares/secrets","/run/lares","/run/lares-host","lares-network","172.30.0.0/24","172.30.0.2","http://lares-gateway:4000","lares_state","fixture-owner",administrator,"lares.example.com","Europe/Berlin"];
    const messages:string[]=[];
    expect(renderConfigCommand(args,message=>messages.push(message))).toBe(1);
    expect(messages).toEqual(["Configure one credential administrator email; nothing was written"]);
    // The unreadable release would throw if validation happened after writing began.
  }
});

describe('optional prepared financial custody',()=>{
  const binding={directory:'/var/lib/lares/budget-financial',db:{host:'db',port:5432,database:'lares_state',user:'lares_financial',passwordFile:'/etc/lares/secrets/financial-database-password'}} as const;
  it('starts unbound and preserves only an explicitly supplied prior binding',()=>{
    expect(renderKeeperConfig(MANIFEST,OPTS).budgetFinancial).toBeUndefined();
    const config=renderKeeperConfig(MANIFEST,{...OPTS,previousBudgetFinancial:binding});
    expect(config.budgetFinancial).toEqual(binding);expect(loadAsKeeperWould(config).budgetFinancial).toEqual(binding);
  });
  it('preserves prepared binding across a real renderer rerun and refuses invalid prior binding before writing',()=>{
    const f=mkdtempSync(join(tmpdir(),'keeper-financial-rerun-'));dirs.push(f);
    const release=join(f,'release.json'),out=join(f,'keeper.partial'),env=join(f,'keeper.env'),live=join(f,'keeper.json');
    writeFileSync(release,JSON.stringify(MANIFEST));
    const args=[release,out,env,live,'lares','/srv/lares','/srv/lares/agents','/srv/lares/retired','/srv/lares/backup','/srv/lares/egress','/etc/lares/secrets','/run/lares','/run/lares-host','lares-network','172.30.0.0/24','172.30.0.2','http://lares-gateway:4000','lares_state','fixture-owner','owner@example.invalid','lares.example.com',''];
    writeFileSync(live,JSON.stringify({...renderKeeperConfig(MANIFEST,OPTS),budgetFinancial:binding}));
    expect(renderConfigCommand(args,()=>{})).toBe(0);expect(JSON.parse(readFileSync(out,'utf8')).budgetFinancial).toEqual(binding);
    const before=readFileSync(out),beforeEnv=readFileSync(env);
    for(const budgetFinancial of [null,{directory:'/etc/lares/budget-financial'},{...binding,reset:true},{directory:binding.directory}]){
      writeFileSync(live,JSON.stringify({...renderKeeperConfig(MANIFEST,OPTS),budgetFinancial}));
      expect(()=>renderConfigCommand(args,()=>{})).toThrow();expect(readFileSync(out)).toEqual(before);expect(readFileSync(env)).toEqual(beforeEnv);
    }
  });
});
