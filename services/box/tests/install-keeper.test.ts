// W8F-F7b + first-conversation follow-up — the keeper is configured and started from the same
// release, with any first-agent name and role bound to the real owner.
//
// WHY ITS OWN FILE, and not more cases in tests/install-stack.test.ts. That file is F7a's, and
// its whole fixture is a release naming the FOUR images the stack needs; every case in it
// reads or asserts against that shape. This step needs three more (`lares-keeper`,
// `lares-egress-proxy`, `lares-firewall-helper`) plus the three role images, and its cases run
// the installer all the way through the database and the owner rather than stopping at the
// model check. Widening F7a's fixture to carry ten images would change what every one of its
// cases is testing; a second file with its own release keeps each one honest.
//
// SAME DISCIPLINE AS install-stack.test.ts: every host command is a logging stub on PATH,
// `pnpm` hands only the box's own renderers to the real pnpm so the release is read and the
// files written by the REAL lib/keeper-config.ts, and every write lands in a temp --prefix. No
// Docker, no network, no server.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, rmSync, statSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, "..", "ops", "install.sh");
const COMMITTED_KEEPER_COMPOSE = join(here, "..", "compose.lares-keeper.yaml");

const REAL_PNPM = execFileSync("/bin/sh", ["-c", "command -v pnpm"], { encoding: "utf8" }).trim();

const D = (n: string) => `example.invalid/lares-${n}@sha256:${"a".repeat(64)}`;

/** Every image a whole installation needs: the stack's four, the keeper's three, the roles' three. */
const IMAGES: Record<string, string> = {
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
};

const release = (images: Record<string, string> = IMAGES) =>
  JSON.stringify({
    release: "2026-10-01",
    images,
    migrations: { box: "087_update_history.sql" },
    breaking: [],
  });

let dir: string, binDir: string, prefix: string, log: string, releaseFile: string;

function stub(name: string, body = "exit 0") {
  const p = join(binDir, name);
  // Real psql consumes piped SQL. Exiting early can SIGPIPE the producer under pipefail.
  // Query-mode calls use -tAc and must not consume the installer's prompt input.
  if (name === "docker") {
    body = `case "$*" in *" -tAc "*) ;; *" psql "*) cat >/dev/null ;; esac\n${body}`;
  }
  writeFileSync(p, `#!/usr/bin/env bash\nprintf '%s %s\\n' "${name}" "$*" >> "$STUB_LOG"\n${body}\n`);
  chmodSync(p, 0o755);
}

const answers =
  ["lares.example.invalid", "owner@example.invalid", "A Name", "sk-disposable-fixture-only"].join("\n") + "\n";

function run(args: string[] = ["--release", ""], input = answers) {
  try {
    const stdout = execFileSync("/bin/bash", [SCRIPT, "--yes", ...args], {
      input,
      encoding: "utf8",
      env: {
        PATH: `${binDir}:${process.env.PATH ?? "/usr/bin:/bin"}`,
        STUB_LOG: log, LARES_PREFIX: prefix, HOME: process.env.HOME ?? dir,
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
  prefix = join(dir, "root"); mkdirSync(prefix);
  log = join(dir, "stubs.log"); writeFileSync(log, "");
  releaseFile = join(dir, "release.json"); writeFileSync(releaseFile, release());
  for (const name of ["docker", "systemctl", "useradd", "groupadd", "chown", "chmod", "ufw", "curl", "openssl"]) stub(name);
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
  it("writes role defaults that bind any first-agent name to the owner just created", () => {
    expect(install().code).toBe(0);
    const config = readKeeperConfig();
    // The owner id derive_owner_id produced from the answered address — the real one, not a
    // placeholder this step invented for itself.
    expect(config.lifecycle.bindings).toBeUndefined();
    expect(Object.keys(config.lifecycle.defaultBindings)).toEqual([
      "chief-of-staff",
      "travel",
      "creative",
    ]);
    for (const binding of Object.values(config.lifecycle.defaultBindings) as any[]) {
      expect(binding.ownerId).toBe("owner");
    }
    expect(config.lifecycle.defaultBindings["chief-of-staff"].secrets).toEqual({
      EVE_SAGA_ROUTE_PASSWORD_FILE: join(prefix, "etc", "lares", "secrets", "eve-route-password"),
    });
    for (const role of ["travel", "creative"]) {
      expect(config.lifecycle.defaultBindings[role].secrets).toEqual({
        EVE_ROUTE_PASSWORD_FILE: join(prefix, "etc", "lares", "secrets", "eve-route-password"),
      });
    }
    // Every image out of the release file this run was given.
    expect(config.lifecycle.imageByRole["chief-of-staff"]).toBe(D("chief-of-staff"));
    expect(config.lifecycle.squidImage).toBe(D("egress-proxy"));
    expect(config.lifecycle.firewallImage).toBe(D("firewall-helper"));
    // The same database, network and secrets this installation actually has.
    expect(config.db.database).toBe("lares_state");
    expect(config.lifecycle.network).toBe("lares-network");
    expect(config.secretsDir).toBe(join(prefix, "srv", "lares", "secrets"));
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
  });

  it("refuses a linked keeper-managed secret root", () => {
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
    const owner = at(/pnpm .*first-owner/);
    const up = at(/docker compose --env-file \S+ -f \S+compose\.lares-keeper\.yaml up -d/);
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
    expect(Object.keys(env).sort()).toEqual([...required].sort());
    expect(env.LARES_KEEPER_IMAGE).toBe(D("keeper"));
    expect(env.LARES_SQUID_IMAGE).toBe(D("egress-proxy"));
    expect(env.LARES_KEEPER_CONFIG).toBe(keeperConfigPath());
    expect(env.LARES_NETWORK).toBe("lares-network");
    expect(env.LARES_ROOT).toBe(join(prefix, "srv", "lares"));
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
    const expand = (s: string) => s.replace(/\$\{([A-Z_]+)(?::\?[^}]*)?\}/g, (_, name) => {
      const value = env[name];
      expect(value, `${name} is used by compose.lares-keeper.yaml and set nowhere`).toBeTruthy();
      return value!;
    });

    // What the keeper container can see: the TARGET side of each of its own volumes. Checking
    // targets rather than sources also keeps this file's "mount keeper-owned roots at the SAME
    // absolute path" rule honest — a mount that renamed a directory on the way in would move
    // the path out from under the keeper and this would say so.
    const mounted = (doc.services["lares-keeper"].volumes as string[])
      .map((v) => expand(v).split(":")[1]!);

    /** Every absolute path the rendered configuration names, wherever it sits in the tree. */
    const paths: string[] = [];
    const walk = (value: unknown) => {
      if (typeof value === "string") { if (value.startsWith("/")) paths.push(value); }
      else if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === "object") Object.values(value).forEach(walk);
    };
    walk(readKeeperConfig());
    expect(paths.length).toBeGreaterThan(5);

    for (const path of paths) {
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

  it("installs the keeper's own compose file at the path it brings up, unchanged", () => {
    expect(install().code).toBe(0);
    const installed = join(prefix, "opt", "lares", "compose.lares-keeper.yaml");
    expect(existsSync(installed)).toBe(true);
    expect(readFileSync(installed, "utf8")).toBe(readFileSync(COMMITTED_KEEPER_COMPOSE, "utf8"));
    expect(calls()).toMatch(new RegExp(`docker compose --env-file \\S+ -f ${installed} up -d`));
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
    stub("docker", 'printf "%s %s\\n" "docker" "$*" >> "$STUB_LOG"\ncase "$*" in *lares-keeper.yaml*) echo "docker: no such image" >&2; exit 1 ;; esac\nexit 0');
    const r = install();
    expect(r.code).toBe(78);
    expect(r.stderr).toMatch(/left exactly as it is/);
    // The configuration it already wrote is one of the things left alone.
    expect(existsSync(keeperConfigPath())).toBe(true);
  });
});
