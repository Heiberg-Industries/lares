// The keeper is configured and started from the same
// release, with any first-agent name and role bound to the real owner.
//
// WHY ITS OWN FILE, and not more cases in tests/install-stack.test.ts. That file covers the stack step, and
// its whole fixture is a release naming the FOUR images the stack needs; every case in it
// reads or asserts against that shape. This step needs three more (`lares-keeper`,
// `lares-egress-proxy`, `lares-firewall-helper`) plus the three role images, and its cases run
// the installer all the way through the database and the owner rather than stopping at the
// database setup. Widening that fixture to carry ten images would change what every one of its
// cases is testing; a second file with its own release keeps each one honest.
//
// SAME DISCIPLINE AS install-stack.test.ts: every host command is a logging stub on PATH,
// `pnpm` hands only the box's own renderers to the real pnpm so the release is read and the
// files written by the REAL lib/keeper-config.ts, and every write lands in a temp --prefix. No
// Docker, no network, no server.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, rmSync, statSync, realpathSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { ENGINE_IMAGE, engineDockerPrelude } from "./helpers/engine-docker.js";

const here = dirname(fileURLToPath(import.meta.url));
// Each case launches the real renderer twice through a shell fixture. CI runs
// this suite alongside other packages, so allow for process startup contention.
vi.setConfig({ testTimeout: 20_000 });
const SCRIPT = join(here, "..", "ops", "install.sh");
const KEEPER_VAULT_ROOTS = join(here, "..", "ops", "keeper-vault-roots.py");
const COMMITTED_KEEPER_COMPOSE = join(here, "..", "compose.lares-keeper.yaml");
const COMMITTED_KEEPER_VAULT_COMPOSE = join(here, "..", "compose.lares-keeper-vault.yaml");
const MAINTENANCE_CUSTODY = join(here, "..", "ops", "maintenance-custody.py");

const REAL_PNPM = execFileSync("/bin/sh", ["-c", "command -v pnpm"], { encoding: "utf8" }).trim();

const D = (n: string) => `example.invalid/lares-${n}@sha256:${"a".repeat(64)}`;

/** Every image a whole installation needs: the stack's four, the keeper's three, the roles' two. */
const IMAGES: Record<string, string> = {
  db: D("db"),
  console: D("console"),
  "lares-gateway": D("gateway"),
  caddy: D("caddy"),
  "lares-keeper": D("keeper"),
  "lares-egress-proxy": D("egress-proxy"),
  "lares-firewall-helper": D("firewall-helper"),
  "chief-of-staff": D("chief-of-staff"),
  creative: D("creative"),
};

const release = (images: Record<string, string> = IMAGES) =>
  JSON.stringify({
    release: "2026-10-01",
    images,
    migrations: { box: "001_baseline.sql" },
    breaking: [],
  });

/** Prepare disposable, test-owned custody before a fixture creates existing-install evidence. */
function prepareFreshCustody() {
  execFileSync("python3", [MAINTENANCE_CUSTODY, "prepare-fresh", prefix, "172.30.0.0/24", "--confirm-fresh"], {
    env: { ...process.env, LARES_MAINTENANCE_TESTING: "1", LARES_SUBNET: "172.30.0.0/24" },
  });
}

let dir: string, binDir: string, prefix: string, log: string, releaseFile: string;

function stub(name: string, body = "exit 0") {
  const p = join(binDir, name);
  // Real psql consumes piped SQL. Exiting early can SIGPIPE the producer under pipefail.
  // Query-mode calls use -tAc and must not consume the installer's prompt input.
  if (name === "docker") {
    body = `case "$*" in *" -tAc "*) ;; *" psql "*) cat >/dev/null ;; esac\n${body}`;
  }
  writeFileSync(p, `#!/usr/bin/env bash\nprintf '%s %s\\n' "${name}" "$*" >> "$STUB_LOG"\n${name === "docker" ? engineDockerPrelude() : ""}${body}\n`);
  chmodSync(p, 0o755);
}

const answers =
  ["lares.example.invalid", "owner@example.invalid", "A Name", "sk-disposable-fixture-only"].join("\n") + "\n";

function run(args: string[] = ["--release", ""], input = answers, extraEnv: Record<string, string> = {}) {
  try {
    const stdout = execFileSync("/bin/bash", [SCRIPT, "--yes", ...args], {
      input,
      encoding: "utf8",
      env: {
        LARES_ENGINE_IMAGE: ENGINE_IMAGE, PATH: `${binDir}:${process.env.PATH ?? "/usr/bin:/bin"}`,
        STUB_LOG: log, LARES_PREFIX: prefix, HOME: process.env.HOME ?? dir,
        LARES_MAINTENANCE_TESTING: "1",
        ...extraEnv,
      },
    });
    return { code: 0, stdout, stderr: "" };
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string };
    return { code: err.status, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

const install = () => run(["--release", releaseFile]);
const calls = () => readFileSync(log, "utf8");
function at(re: RegExp): number {
  const m = re.exec(calls());
  return m ? m.index : -1;
}

const keeperConfigPath = () => join(prefix, "etc", "lares", "keeper.json");
const keeperEnvPath = () => join(prefix, "etc", "lares", "keeper.env");
const readKeeperConfig = () => JSON.parse(readFileSync(keeperConfigPath(), "utf8"));

/** The compose env file, read the way `docker compose --env-file` reads it. */
function keeperEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(keeperEnvPath(), "utf8").split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    out[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lares-install-keeper-"));
  binDir = join(dir, "bin"); mkdirSync(binDir);
  prefix = join(dir, "root"); mkdirSync(prefix); prefix = realpathSync(prefix);
  log = join(dir, "stubs.log"); writeFileSync(log, "");
  releaseFile = join(dir, "release.json"); writeFileSync(releaseFile, release());
  for (const name of ["docker", "systemctl", "useradd", "groupadd", "chown", "chmod", "ufw", "curl", "openssl"]) stub(name);
  stub("stat", 'case "$*" in *database-password*) echo 0:600 ;; *) echo 0:700 ;; esac');
  stub("lares-doctor");
  // Only the box's own renderers run for real; migrate and first-owner are logged and skipped.
  stub("pnpm", `case "$*" in *render-stack*|*render-keeper-config*) exec ${REAL_PNPM} "$@" ;; esac\nexit 0`);
  stub("id", "echo 0");
  stub("uname", "echo Linux");
  stub("free", 'echo "Mem: 8192 1024 7168"');
  stub("df", 'echo "/dev/x 100000000 1000000 99000000 1% /"');
  stub("ss", "exit 1");
  stub("lsb_release", "echo 24.04");
  stub("getent", 'if [ "$1" = "hosts" ]; then echo "203.0.113.10 $2"; fi');
  stub("hostname", 'if [ "$1" = "-I" ]; then echo "203.0.113.10"; fi');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("the keeper the installer configures and starts", () => {
  it("normalizes an empty or root host prefix without probing live host directories", () => {
    expect(execFileSync("python3", [KEEPER_VAULT_ROOTS, "path", "", "/srv/vault"], { encoding: "utf8" })).toBe("/srv/vault\n");
    expect(execFileSync("python3", [KEEPER_VAULT_ROOTS, "path", "/", "/var/lib/lares-vault-git"], { encoding: "utf8" })).toBe("/var/lib/lares-vault-git\n");
  });

  it("passes the canonical root prefix to the admission identity validator", () => {
    const shellValue = execFileSync("/bin/bash", ["-c", 'PREFIX=""; printf %s "${PREFIX:-/}"'], { encoding: "utf8" });
    expect(shellValue).toBe("/");
    expect(readFileSync(SCRIPT, "utf8")).toContain('"${PREFIX:-/}"; then');
  });

  it("writes role defaults that bind any first-agent name to the owner just created", () => {
    expect(install().code).toBe(0);
    const config = readKeeperConfig();
    // The owner id derive_owner_id produced from the answered address — the real one, not a
    // placeholder this step invented for itself.
    expect(config.lifecycle.bindings).toBeUndefined();
    expect(Object.keys(config.lifecycle.defaultBindings)).toEqual([
      "chief-of-staff",
      "creative",
    ]);
    for (const binding of Object.values(config.lifecycle.defaultBindings) as any[]) {
      expect(binding.ownerId).toBe("owner");
    }
    expect(config.lifecycle.defaultBindings["chief-of-staff"].secrets).toEqual({
      EVE_ROUTE_PASSWORD_FILE: join(prefix, "etc", "lares", "secrets", "eve-route-password"),
    });
    expect(config.lifecycle.defaultBindings.creative.secrets).toEqual({
      EVE_ROUTE_PASSWORD_FILE: join(prefix, "etc", "lares", "secrets", "eve-route-password"),
    });
    // Every image out of the release file this run was given.
    expect(config.lifecycle.imageByRole["chief-of-staff"]).toBe(D("chief-of-staff"));
    expect(config.lifecycle.squidImage).toBe(D("egress-proxy"));
    expect(config.lifecycle.firewallImage).toBe(D("firewall-helper"));
    // The same database, network and secrets this installation actually has.
    expect(config.db.database).toBe("lares_state");
    expect(config.lifecycle.network).toBe("lares-network");
    expect(config.lifecycle.reservedAddresses).toEqual(["172.30.0.254"]);
    expect(readFileSync(join(prefix, "srv", "lares", "egress", "squid.conf"), "utf8"))
      .toBe("http_port 8888\nhttp_access deny all\n");
    expect(config.credentials).toEqual({ administrator: "owner@example.invalid", slot: "notion:shared", binding: "NOTION_TOKEN_FILE", prepared: false, inventoryComplete: false, retainedConsumers: [] });
    expect(config.secretsDir).toBe(join(prefix, "srv", "lares", "secrets"));
    expect(existsSync(join(config.secretsDir, "notion-token"))).toBe(false);
    expect(config.agentsDir).toBe(join(prefix, "srv", "lares", "agents"));
  });

  it("leaves the keeper's configuration readable by root alone", () => {
    expect(install().code).toBe(0);
    const mode = statSync(keeperConfigPath()).mode & 0o777;
    expect(
      mode,
      `keeper.json is mode ${mode.toString(8)}. It names every path this installation keeps its ` +
        "secrets at, and the only process that reads it is the keeper container, which " +
        "compose.lares-keeper.yaml runs as `user: '0:0'` — so nothing but root needs it. " +
        "Fix: install.sh's run_keeper chmods it 0600, and bin/render-keeper-config.ts does too.",
    ).toBe(0o600);
  });

  it("creates the keeper-managed secret root as a root-only directory", () => {
    expect(install().code).toBe(0);
    const path = join(prefix, "srv", "lares", "secrets");
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o700);
    expect(calls()).toContain(`chmod 0700 ${path}`);
    expect(calls()).toContain(`chown 0:0 ${path}`);
  }, 20_000);

  it("refuses a linked keeper-managed secret root", () => {
    prepareFreshCustody();
    const root = join(prefix, "srv", "lares");
    const outside = join(dir, "outside");
    mkdirSync(root, { recursive: true });
    mkdirSync(outside);
    symlinkSync(outside, join(root, "secrets"));
    const r = install();
    expect(r.code).toBe(78);
    expect(r.stderr).toMatch(/symbolic link/i);
    expect(existsSync(keeperConfigPath())).toBe(false);
  });

  it("brings the keeper up only after the owner it binds the agent to exists", () => {
    expect(install().code).toBe(0);
    const owner = at(/first-owner\.ts --apply/);
    const up = at(/docker compose --env-file \S+ up -d/);
    expect(owner, "the owner was never created").toBeGreaterThan(-1);
    expect(
      owner,
      "the keeper was configured before the owner existed. Its first-agent role defaults carry " +
        "the owner's id, so starting it first binds the agent to nothing. Fix: in install.sh's " +
        "dispatch block, run_keeper goes after run_first_owner.",
    ).toBeLessThan(up);
  });

  it("gives the keeper's compose file every variable it refuses to start without", () => {
    expect(install().code).toBe(0);
    const env = keeperEnv();
    // Every `:?` variable compose.lares-keeper.yaml names. A missing one is not a default —
    // `docker compose` fails on it, loudly, with nothing brought up.
    const required = new Set(
      [...readFileSync(COMMITTED_KEEPER_COMPOSE, "utf8").matchAll(/\$\{([A-Z_]+):\?/g)].map((m) => m[1]!),
    );
    for (const name of required) {
      expect(env[name], `${name} is named by compose.lares-keeper.yaml and set nowhere`).toBeTruthy();
    }
    // Exactly those, and nothing else — counted from both files rather than written down here,
    // so adding a mandatory variable to the compose file moves this test on its own, and a
    // variable the env file sets that nothing needs is caught too.
    const vaultRequired = new Set(
      [...readFileSync(COMMITTED_KEEPER_VAULT_COMPOSE, "utf8").matchAll(/\$\{([A-Z_]+):\?/g)].map((m) => m[1]!),
    );
    const optional = new Set(
      [...`${readFileSync(COMMITTED_KEEPER_COMPOSE, "utf8")}\n${readFileSync(COMMITTED_KEEPER_VAULT_COMPOSE, "utf8")}`.matchAll(/\$\{([A-Z_]+):-/g)].map((m) => m[1]!),
    );
    expect(Object.keys(env).sort()).toEqual([...new Set([...required, ...vaultRequired, ...optional, "COMPOSE_FILE"])].sort());
    expect(env.LARES_KEEPER_IMAGE).toBe(D("keeper"));
    expect(env.LARES_SQUID_IMAGE).toBe(D("egress-proxy"));
    expect(env.LARES_KEEPER_CONFIG).toBe(keeperConfigPath());
    expect(env.LARES_NETWORK).toBe("lares-network");
    expect(env.LARES_ROOT).toBe(join(prefix, "srv", "lares"));
    expect(env.LARES_VAULT_WORKING_ROOT).toBe(`"${join(prefix, "srv", "vault")}"`);
    expect(env.LARES_VAULT_BARE_ROOT).toBe(`"${join(prefix, "var", "lib", "lares-vault-git")}"`);
    expect(env.COMPOSE_FILE).toBe(`"${join(prefix, "opt", "lares", "compose.lares-keeper.yaml")}:${join(prefix, "opt", "lares", "compose.lares-keeper-vault.yaml")}"`);
  });

  it("renders the validated receipt identity into the exact read-only Keeper admission bind", () => {
    expect(install().code).toBe(0);
    const receipt = JSON.parse(readFileSync(join(prefix, "var/lib/lares-maintenance/custody/preparation.json"), "utf8"));
    const env = keeperEnv();
    const admission = join(prefix, "var/lib/lares-maintenance/admission");
    expect(env.LARES_MAINTENANCE_ADMISSION_DIR).toBe(admission);
    expect(env.LARES_MAINTENANCE_INSTALLATION_ID).toBe(receipt.installationId);
    expect(env.LARES_MAINTENANCE_EPOCH).toBe(String(receipt.epoch));
    const compose = parse(readFileSync(COMMITTED_KEEPER_COMPOSE, "utf8")) as any;
    const keeper = compose.services["lares-keeper"];
    expect(keeper.entrypoint).toEqual([
      "/usr/local/lib/lares/maintenance-admission-v1", "/run/lares-maintenance/admission",
      "${LARES_MAINTENANCE_INSTALLATION_ID:?validated installation id required}",
      "${LARES_MAINTENANCE_EPOCH:?validated maintenance epoch required}", "--",
    ]);
    const mounts = keeper.volumes.filter((mount: any) => mount?.target === "/run/lares-maintenance/admission");
    expect(mounts).toEqual([{
      type: "bind", source: "${LARES_MAINTENANCE_ADMISSION_DIR:?validated admission directory required}",
      target: "/run/lares-maintenance/admission", read_only: true, bind: { create_host_path: false },
    }]);
  });

  it("starts egress through the fixed guard with only the receipt-bound admission child", () => {
    expect(install().code).toBe(0);
    const env = keeperEnv();
    const receipt = JSON.parse(readFileSync(join(prefix, "var/lib/lares-maintenance/custody/preparation.json"), "utf8"));
    const compose = parse(readFileSync(COMMITTED_KEEPER_COMPOSE, "utf8")) as any;
    const proxy = compose.services["lares-egress-proxy"];
    expect(proxy.container_name).toBe("lares-egress-proxy");
    expect(proxy.entrypoint).toEqual([
      "/usr/bin/python3", "-I", "/usr/local/lib/lares/maintenance-admission.py",
    ]);
    expect(proxy.command).toEqual(["squid", "-N", "-f", "/config/squid.conf"]);
    expect(proxy.environment).toEqual({
      LARES_MAINTENANCE_INSTALLATION_ID: "${LARES_MAINTENANCE_INSTALLATION_ID:?validated installation id required}",
      LARES_MAINTENANCE_EPOCH: "${LARES_MAINTENANCE_EPOCH:?validated maintenance epoch required}",
    });
    expect(env.LARES_MAINTENANCE_INSTALLATION_ID).toBe(receipt.installationId);
    expect(env.LARES_MAINTENANCE_EPOCH).toBe(String(receipt.epoch));
    expect(proxy.init).toBe(true);
    expect(proxy.restart).toBe("unless-stopped");
    expect(proxy.tmpfs).toEqual(["/run:rw,nosuid,nodev,noexec,size=1m,mode=0755"]);
    expect(proxy.networks).toEqual({
      "lares-network": { ipv4_address: "${LARES_PROXY_ADDRESS:?reserved proxy address}" },
    });
    expect(proxy.volumes).toEqual([
      "${LARES_EGRESS_DIR:?absolute egress directory}:/config:ro",
      {
        type: "bind",
        source: "${LARES_MAINTENANCE_ADMISSION_DIR:?validated admission directory required}",
        target: "/run/lares-maintenance/admission",
        read_only: true,
        bind: { create_host_path: false },
      },
    ]);
    expect(JSON.stringify(proxy.volumes)).not.toMatch(/custody|preparation\.json|lares-maintenance:\/run/);
  });

  // THE DEFECT THIS CATCHES, AND WHY NO OTHER TEST HERE COULD. `bin/keeper.ts` does
  // `loadKeeperConfig()` and then `keeperPool(config.db)` as its first two statements, and
  // `keeperPool` reads `db.passwordFile` EAGERLY — `readFileSync` inside the Pool constructor,
  // not on first query. If that path is not inside something compose mounts into the container,
  // the keeper throws "keeper: database credentials unavailable" and exits, `restart:
  // unless-stopped` restarts it for ever, and `docker compose up -d` still exits 0 — so
  // run_keeper says "the keeper is up" about a container that cannot start. `adminDb` is the
  // same file one line later.
  //
  // BOTH SIDES ARE DERIVED, never restated: the paths come out of the keeper.json this run
  // actually wrote, and the mounts out of compose.lares-keeper.yaml's own volumes, with its
  // `${…:?}` variables resolved from the env file this run actually rendered. A path added to
  // keeper.json later is checked by this test without anybody remembering to add it here.
  it("keeps every path it tells the keeper to read inside something the container mounts", () => {
    expect(install().code).toBe(0);
    const env = keeperEnv();
    const doc = parse(readFileSync(COMMITTED_KEEPER_COMPOSE, "utf8")) as any;

    /** `${NAME:?why}` → the value the rendered env file gives NAME. */
    const expand = (s: string) => s.replace(/\$\{([A-Z_]+)(?::([?-][^}]*))?\}/g, (_, name, fallback) => {
      const value = env[name];
      if (value) return value;
      if (typeof fallback === "string" && fallback.startsWith("-")) return fallback.slice(1);
      expect(value, `${name} is used by compose.lares-keeper.yaml and set nowhere`).toBeTruthy();
      return value!;
    });

    // What the keeper container can see: the TARGET side of each of its own volumes. Checking
    // targets rather than sources also keeps this file's "mount keeper-owned roots at the SAME
    // absolute path" rule honest — a mount that renamed a directory on the way in would move
    // the path out from under the keeper and this would say so.
    const mounted = (doc.services["lares-keeper"].volumes as Array<string | { target: string }>)
      .map((v) => typeof v === "string" ? expand(v).split(":")[1]! : expand(v.target));

    /** Every absolute path the rendered configuration names, wherever it sits in the tree. */
    const paths: string[] = [];
    const walk = (value: unknown) => {
      if (typeof value === "string") { if (value.startsWith("/")) paths.push(value); }
      else if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === "object") Object.values(value).forEach(walk);
    };
    const config = readKeeperConfig();
    walk(config);
    expect(paths.length).toBeGreaterThan(5);

    // The in-container side of a runtime binding is a path inside the AGENT's container, not the
    // keeper's. This set also records configuration paths passed to Docker as host-side bind
    // sources, which the keeper itself does not open.
    const chief = readKeeperConfig().lifecycle.defaultBindings["chief-of-staff"];
    const keeperHostMountSources = new Set<string>();
    const admissionHostDirectory = config.lifecycle.maintenanceAdmission.hostDirectory;
    const admissionMounts = doc.services["lares-keeper"].volumes.filter((mount: any) =>
      mount && typeof mount === "object" && mount.target === "/run/lares-maintenance/admission",
    );
    expect(admissionMounts).toEqual([{
      type: "bind",
      source: "${LARES_MAINTENANCE_ADMISSION_DIR:?validated admission directory required}",
      target: "/run/lares-maintenance/admission",
      read_only: true,
      bind: { create_host_path: false },
    }]);
    expect(expand(admissionMounts[0].source)).toBe(admissionHostDirectory);
    keeperHostMountSources.add(admissionHostDirectory);
    if (config.modelPurposeRuntimeDir) {
      // This is a host path passed to Docker when Keeper renders the chief's Compose file. It
      // need not exist inside Keeper at the same absolute path; the keeper compose mounts the
      // host socket root at /run/lares, while the role compose uses this exact host source.
      expect(config.modelPurposeRuntimeDir).toBe(join(env.LARES_SOCKET_DIR!, "model-purpose"));
      expect(mounted).toContain("/run/lares");
      const keeperModelPurposeDir = join("/run/lares", "model-purpose");
      expect(config.modelPurposeRuntimeDir).not.toBe(keeperModelPurposeDir);
      expect(join(config.modelPurposeRuntimeDir, "gateway.sock")).not.toBe(join(keeperModelPurposeDir, "gateway.sock"));
      keeperHostMountSources.add(config.modelPurposeRuntimeDir);
    }
    const agentSide = new Set<string>([
      ...chief.mounts.map((m: { target: string }) => m.target),
      ...(chief.environment.DEADLINE_CALENDAR_FILE ? [chief.environment.DEADLINE_CALENDAR_FILE] : []),
    ]);

    for (const path of paths) {
      if (agentSide.has(path) || keeperHostMountSources.has(path)) continue;
      // `/app/...` is the keeper's OWN image (rolesDir, templatesDir) — inside the container by
      // construction, never a host path, so no mount can or should cover it.
      if (path.startsWith("/app/")) continue;
      expect(
        mounted.some((m) => path === m || path.startsWith(`${m}/`)),
        `keeper.json names ${path}, and compose.lares-keeper.yaml mounts none of ` +
          `${JSON.stringify(mounted)} that contains it. The keeper reads its own configuration ` +
          "from inside the container, so a path no mount covers is a file it cannot open — and " +
          "db.passwordFile is read eagerly at startup, so the keeper crash-loops while " +
          "`docker compose up -d` still exits 0. Fix: mount that directory into the " +
          "lares-keeper service at the same absolute path, and give run_keeper the variable.",
      ).toBe(true);
    }
  });

  it("mounts staged gateway-budget sources as exact read-only Keeper files only", () => {
    const keeper = parse(readFileSync(COMMITTED_KEEPER_COMPOSE, "utf8")) as any;
    const volumes = keeper.services["lares-keeper"].volumes as Array<string | Record<string, unknown>>;
    const key = volumes.find(value => typeof value !== "string" && String(value.source).includes("GATEWAY_BUDGET_SERVICE_KEY_FILE")) as Record<string, any>;
    const policy = volumes.find(value => typeof value !== "string" && String(value.source).includes("NATIVE_POLICY_FILE")) as Record<string, any>;
    expect(key).toMatchObject({
      type: "bind",
      source: "${LARES_GATEWAY_BUDGET_SERVICE_KEY_FILE:-/dev/null}",
      target: "${LARES_GATEWAY_BUDGET_SERVICE_KEY_TARGET:-/run/secrets/gateway-budget-unused-key}",
      read_only: true,
      bind: { create_host_path: false },
    });
    expect(policy).toMatchObject({
      type: "bind",
      source: "${LARES_NATIVE_POLICY_FILE:-/dev/null}",
      target: "${LARES_NATIVE_POLICY_TARGET:-/etc/lares/native-policy-unused.json}",
      read_only: true,
      bind: { create_host_path: false },
    });
    expect(Object.keys(keeper.services)).toEqual(["lares-keeper", "lares-egress-proxy"]);
  });

  it("installs the keeper's own compose file at the path it brings up, unchanged", () => {
    expect(install().code).toBe(0);
    const installed = join(prefix, "opt", "lares", "compose.lares-keeper.yaml");
    expect(existsSync(installed)).toBe(true);
    expect(readFileSync(installed, "utf8")).toBe(readFileSync(COMMITTED_KEEPER_COMPOSE, "utf8"));
    expect(keeperEnv().COMPOSE_FILE).toBe(`"${installed}:${join(prefix, "opt", "lares", "compose.lares-keeper-vault.yaml")}"`);
    expect(calls()).toMatch(/docker compose --env-file \S+ up -d/);
  });

  it("clears an inherited COMPOSE_FILE before applying the saved Keeper selection", () => {
    stub("docker", 'case "$*" in *"compose --env-file"*) if [ -n "${COMPOSE_FILE:-}" ]; then echo "inherited COMPOSE_FILE reached Compose" >&2; exit 19; fi ;; esac\nexit 0');
    const r = run(["--release", releaseFile], answers, { COMPOSE_FILE: "/untrusted/override.yaml" });
    expect(r.code, r.stderr).toBe(0);
    expect(keeperEnv().COMPOSE_FILE).toBe(`"${join(prefix, "opt", "lares", "compose.lares-keeper.yaml")}:${join(prefix, "opt", "lares", "compose.lares-keeper-vault.yaml")}"`);
    expect(r.stderr).not.toContain("inherited COMPOSE_FILE reached Compose");
  });

  it("activates exact Vault mounts only from a validated published inventory", () => {
    expect(install().code).toBe(0);
    const inventory = join(prefix, "srv", "lares", "installation", "vault-storage.json");
    const workingRoot = join(prefix, "srv", "vault"), bareRoot = join(prefix, "var", "lib", "lares-vault-git");
    const installed = join(prefix, "opt", "lares", "compose.lares-keeper-vault.yaml");
    expect(existsSync(inventory)).toBe(true);
    expect(existsSync(workingRoot)).toBe(true);
    expect(existsSync(bareRoot)).toBe(true);
    expect(readFileSync(installed, "utf8")).toBe(readFileSync(COMMITTED_KEEPER_VAULT_COMPOSE, "utf8"));
    expect(keeperEnv().LARES_VAULT_WORKING_ROOT).toBe(`"${workingRoot}"`);
    expect(keeperEnv().LARES_VAULT_BARE_ROOT).toBe(`"${bareRoot}"`);
    expect(at(/vault-storage\.ts verify-plan/)).toBeLessThan(at(/docker compose --env-file \S+ up -d/));

    const optional = parse(readFileSync(COMMITTED_KEEPER_VAULT_COMPOSE, "utf8")) as any;
    const volumes = optional.services["lares-keeper"].volumes;
    expect(volumes).toEqual([
      { type: "bind", source: "${LARES_VAULT_WORKING_ROOT:?prepared Vault working root required}", target: "/srv/vault", bind: { create_host_path: false } },
      { type: "bind", source: "${LARES_VAULT_BARE_ROOT:?prepared Vault bare root required}", target: "/var/lib/lares-vault-git", bind: { create_host_path: false } },
    ]);
    const base = parse(readFileSync(COMMITTED_KEEPER_COMPOSE, "utf8")) as any;
    expect(base.services["lares-keeper"].volumes.join("\n")).not.toMatch(/\/srv\/vault|lares-vault-git/);
  });

  it("refuses by name when the release names no image the keeper needs, and starts nothing", () => {
    const { "lares-firewall-helper": _drop, ...images } = IMAGES;
    writeFileSync(releaseFile, release(images));
    const r = install();
    expect(r.code).toBe(78);
    // The engine's own sentence (release-manifest.ts's imageFor), not a restatement in shell.
    expect(r.stderr).toMatch(/no image for "lares-firewall-helper"/);
    expect(existsSync(keeperConfigPath())).toBe(false);
    expect(at(/docker compose \S*.*compose\.lares-keeper\.yaml up -d/)).toBe(-1);
    // Everything earlier survives, so a re-run with a complete release resumes.
    expect(existsSync(join(prefix, "opt", "lares", "compose.yaml"))).toBe(true);
    expect(existsSync(join(prefix, "etc", "lares", "secrets", "token-enc-key"))).toBe(true);
  });

  it("says what is left untouched when the keeper does not come up", () => {
    stub("docker", 'printf "%s %s\\n" "docker" "$*" >> "$STUB_LOG"\ncase "$*" in *"--env-file"*" up -d"*) echo "docker: no such image" >&2; exit 1 ;; esac\nexit 0');
    const r = install();
    expect(r.code).toBe(78);
    expect(r.stderr).toMatch(/left exactly as it is/);
    // The configuration it already wrote is one of the things left alone.
    expect(existsSync(keeperConfigPath())).toBe(true);
  });

  describe("re-running the installer", () => {
    const calendar = () => join(prefix, "srv", "lares", "installation", "deadline-calendar.json");
    const IN_CONTAINER = "/srv/lares/installation/deadline-calendar.json";
    const GOOGLE = {
      principal: "owner",
      tokenKeyFile: "/etc/lares/secrets/token-enc-key",
      clients: {
        work: {
          clientIdFile: "/etc/lares/secrets/google-client-id-work",
          clientSecretFile: "/etc/lares/secrets/google-client-secret-work",
        },
      },
    };
    /** docker reports a running keeper only when asked which containers the keeper's compose has. */
    const keeperIsRunning = () =>
      stub("docker", 'case "$*" in *" ps -q lares-keeper"*) echo abc123 ;; esac\nexit 0');
    const recreates = () => (calls().match(/up -d --force-recreate lares-keeper/g) ?? []).length;
    const putCalendar = () => {
      mkdirSync(dirname(calendar()), { recursive: true });
      writeFileSync(calendar(), "[]");
    };

    it("binds the calendar for the chief of staff only when the file is there", () => {
      prepareFreshCustody();
      putCalendar();
      expect(install().code).toBe(0);
      const { defaultBindings } = readKeeperConfig().lifecycle;
      expect(defaultBindings["chief-of-staff"].mounts).toEqual([
        { source: calendar(), target: IN_CONTAINER, readOnly: true },
      ]);
      // OWNER_HOME_TZ is whatever zone the test host reports (none on some hosts);
      // keeper-config.test.ts pins how it is passed on.
      const { OWNER_HOME_TZ: _chiefTz, ...chiefEnv } = defaultBindings["chief-of-staff"].environment;
      const { OWNER_HOME_TZ: _creativeTz, ...creativeEnv } = defaultBindings.creative.environment;
      expect(chiefEnv).toEqual({ DEADLINE_CALENDAR_FILE: IN_CONTAINER });
      expect(defaultBindings.creative.mounts).toEqual([]);
      expect(creativeEnv).toEqual({});
    });

    it("warns and binds nothing when the calendar is a link", () => {
      prepareFreshCustody();
      mkdirSync(dirname(calendar()), { recursive: true });
      writeFileSync(join(dir, "elsewhere.json"), "[]");
      symlinkSync(join(dir, "elsewhere.json"), calendar());
      const r = install();
      expect(r.code, r.stderr).toBe(0);
      expect(r.stdout + r.stderr).toMatch(/not a plain file/);
      expect(readKeeperConfig().lifecycle.defaultBindings["chief-of-staff"].mounts).toEqual([]);
    });

    it("keeps the Google settings and does not restart an unchanged keeper", () => {
      expect(install().code).toBe(0);
      const config = readKeeperConfig();
      config.lifecycle.runtime.google = GOOGLE;
      writeFileSync(keeperConfigPath(), JSON.stringify(config, null, 2) + "\n");
      keeperIsRunning();
      expect(install().code).toBe(0);
      expect(readKeeperConfig().lifecycle.runtime.google).toEqual(GOOGLE);
      // The Google block is carried over, so the re-run renders exactly the file already there.
      expect(recreates()).toBe(0);
    });

    it("preserves explicit Microsoft-only runtime settings on installer rerun", () => {
      expect(install().code).toBe(0);
      const config=readKeeperConfig();
      const microsoft={tenantIdFile:"/srv/secrets/ms-tenant",clientIdFile:"/srv/secrets/ms-id",clientSecretFile:"/srv/secrets/ms-secret",tokenKeyFile:"/srv/secrets/token-key"};
      config.lifecycle.runtime.microsoft=microsoft;
      writeFileSync(keeperConfigPath(),JSON.stringify(config,null,2)+"\n");keeperIsRunning();
      expect(install().code).toBe(0);expect(readKeeperConfig().lifecycle.runtime.microsoft).toEqual(microsoft);expect(recreates()).toBe(0);
    });

    it("restarts a running keeper when its settings changed", () => {
      expect(install().code).toBe(0);
      keeperIsRunning();
      putCalendar();
      expect(install().code).toBe(0);
      expect(recreates()).toBe(1);
      expect(at(/--force-recreate lares-keeper/)).toBeLessThan(
        calls().lastIndexOf("docker compose --env-file "),
      );
    });

    it("does not recreate a keeper that is not running", () => {
      expect(install().code).toBe(0);
      putCalendar();
      expect(install().code).toBe(0);
      expect(recreates()).toBe(0);
    });

    it("refuses to overwrite a keeper.json it cannot read, and leaves it as it was", () => {
      expect(install().code).toBe(0);
      writeFileSync(keeperConfigPath(), "{ not json");
      const r = install();
      expect(r.code).not.toBe(0);
      expect(r.stderr).toMatch(/not valid JSON/);
      expect(readFileSync(keeperConfigPath(), "utf8")).toBe("{ not json");
    });
  });
});
