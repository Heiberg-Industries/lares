// W8F-F7a — the stack comes up BEFORE the model key is tested, and the release file the
// installer was given is the one it uses.
//
// THE ORDER IS THE POINT. Until this slice, the model check sat inside run_wizard and called
// http://lares-gateway:4000 before anything had started that container, so a fresh install
// always died with "the model key did not work" — naming the one thing that was not wrong. The
// order test below reads the shared stub log and asserts that `docker compose … up -d` is
// written there BEFORE `lares-doctor --test-model`. No Docker, no network, no server.
//
// UNLIKE THE OTHER INSTALLER TESTS, THE RENDER HERE IS NOT FAKED. `pnpm` is still a stub, but
// it hands the ONE call it is given for `render-stack` to the real pnpm, so the release file is
// read and the compose file written by the REAL services/box/{bin/render-stack,lib/release-
// manifest,lib/stack-compose}.ts — the same discipline tests/update-script.test.ts uses for its
// own release read. So "a release named by a tag is refused" is a test of the engine's own
// rule, and "the stack file is written" is a test of the real renderer, not of a stub restating
// either. Everything else that would touch this machine (docker, migrate, first-owner,
// lares-doctor, chown, …) is a logging stub, and every write lands in a temp --prefix.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, rmSync, statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const here = dirname(fileURLToPath(import.meta.url));
vi.setConfig({ testTimeout: 20_000 });
const SCRIPT = join(here, "..", "ops", "install.sh");
const COMMITTED_CADDYFILE = join(here, "..", "ops", "Caddyfile");
/** The gateway's start script, committed once and installed — never re-generated, never
 *  transcribed. Same repo-root resolution tests/gateway-start-script.test.ts already uses. */
const COMMITTED_GATEWAY_START = join(here, "..", "..", "..", "images", "gateway-runtime", "start.sh");

/** The pnpm this machine has, by absolute path — see the `pnpm` stub below. */
const REAL_PNPM = execFileSync("/bin/sh", ["-c", "command -v pnpm"], { encoding: "utf8" }).trim();

const D = (n: string) => `example.invalid/lares-${n}@sha256:${"a".repeat(64)}`;

/** A release this installer can actually bring up: every service the stack file needs. */
const GOOD_RELEASE = JSON.stringify({
  release: "2026-10-01",
  images: { db: D("db"), console: D("console"), "lares-gateway": D("gateway"), caddy: D("caddy") },
  migrations: { box: "087_update_history.sql" },
  breaking: [],
});

let dir: string, binDir: string, prefix: string, log: string, releaseFile: string;

/** A stub that logs its own name and argv, and exits 0 unless `body` says otherwise. */
function stub(name: string, body = "exit 0") {
  const p = join(binDir, name);
  writeFileSync(p, `#!/usr/bin/env bash\nprintf '%s %s\\n' "${name}" "$*" >> "$STUB_LOG"\n${body}\n`);
  chmodSync(p, 0o755);
}

const answers = ["lares.example.invalid", "owner@example.invalid", "A Name", "sk-disposable-fixture-only"].join("\n") + "\n";

/** Every run bakes in `--yes` (screen one is not what this file is about) and, unless the case
 *  is about the flag itself, `--release <fixture>`. The real PATH is kept on the end so the
 *  release read and the render run under the real `node`, exactly as they will on a box. */
function run(args: string[], input = answers, env: Record<string, string> = {}, cwd = process.cwd()) {
  try {
    const stdout = execFileSync("/bin/bash", [SCRIPT, "--yes", ...args], {
      input,
      cwd,
      encoding: "utf8",
      env: {
        PATH: `${binDir}:${process.env.PATH ?? "/usr/bin:/bin"}`,
        // HOME is this machine's real one, unlike the other installer tests, because the real
        // pnpm the stub hands render-stack to finds its own tooling under it. install.sh writes
        // nothing outside $PREFIX, so nothing of this installation can land there.
        STUB_LOG: log, LARES_PREFIX: prefix, HOME: process.env.HOME ?? dir, ...env,
      },
    });
    return { code: 0, stdout, stderr: "" };
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string };
    return { code: err.status, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

const calls = () => readFileSync(log, "utf8");
/** Where a call matching `re` first appears in the shared log, or -1 — the ordering primitive
 *  tests/update-script.test.ts already uses for the same job. */
function at(re: RegExp): number {
  const m = re.exec(calls());
  return m ? m.index : -1;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lares-install-stack-"));
  binDir = join(dir, "bin"); mkdirSync(binDir);
  prefix = join(dir, "root"); mkdirSync(prefix);
  log = join(dir, "stubs.log"); writeFileSync(log, "");
  releaseFile = join(dir, "release.json"); writeFileSync(releaseFile, GOOD_RELEASE);
  for (const name of ["docker", "systemctl", "useradd", "groupadd", "chown", "chmod", "ufw", "curl", "openssl"]) stub(name);
  // The installer pipes SQL to this command. Consume stdin so Bash pipefail
  // does not race the stub's exit while the writer is still sending the query.
  stub("docker", 'case "$*" in *"exec -T db psql"*) cat >/dev/null ;; esac\nexit 0');
  stub("lares-doctor");
  // `pnpm` reaches three of the box's own commands from this script: render-stack (this slice),
  // migrate and first-owner. Only the first is what this file is about, and only it runs for
  // real — through the pnpm this machine actually has, named by absolute path so the stub
  // ahead of it on PATH cannot call itself.
  // W8F-F7b added a fourth: run_keeper's `render-keeper-config` at the end of the install. This
  // file is about the stack, so that one gets a placeholder pair of files, not the real
  // renderer — tests/install-keeper.test.ts is where THAT one runs for real.
  stub("pnpm", `case "$*" in *render-keeper-config*) printf '{}\\n' > "$5"; printf 'LARES_KEEPER_IMAGE=placeholder\\n' > "$6"; exit 0 ;; *render-stack*) exec ${REAL_PNPM} "$@" ;; esac\nexit 0`);
  stub("id", "echo 0");                                   // running as root
  stub("uname", "echo Linux");
  stub("free", 'echo "Mem: 8192 1024 7168"');
  stub("df", 'echo "/dev/x 100000000 1000000 99000000 1% /"');
  stub("ss", "exit 1");                                   // nothing listening on 80/443
  stub("lsb_release", "echo 24.04");
  // DNS (owner decision C5): getent and hostname agree, so the fixture domain resolves here.
  stub("getent", 'if [ "$1" = "hosts" ]; then echo "203.0.113.10 $2"; fi');
  stub("hostname", 'if [ "$1" = "-I" ]; then echo "203.0.113.10"; fi');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("the release file the installer was given", () => {
  it("refuses, naming the flag, when a fresh install is given none", () => {
    const r = run([]);
    expect(r.code).toBe(64);
    expect(r.stderr).toMatch(/no --release file was given/);
    // Refused before the first secret: nothing of this installation exists yet.
    expect(existsSync(join(prefix, "etc", "lares", "secrets"))).toBe(false);
  });

  it("refuses, naming the path, when there is no release file there", () => {
    const missing = join(dir, "nowhere.json");
    const r = run(["--release", missing]);
    expect(r.code).toBe(64);
    expect(r.stderr).toContain(missing);
    expect(r.stderr).toMatch(/Nothing has been changed/);
    expect(existsSync(join(prefix, "etc", "lares", "secrets"))).toBe(false);
  });

  it("refuses through the release rules when an image is named by a tag, not a digest", () => {
    writeFileSync(releaseFile, JSON.stringify({
      release: "2026-10-01",
      images: { db: D("db"), console: "example.invalid/lares-console:latest",
        "lares-gateway": D("gateway"), caddy: D("caddy") },
      migrations: { box: "087_update_history.sql" },
      breaking: [],
    }));
    const r = run(["--release", releaseFile]);
    expect(r.code).toBe(78);
    // parseReleaseManifest's own sentence, not a restatement of it in shell.
    expect(r.stderr).toMatch(/must be named by digest/);
    expect(existsSync(join(prefix, "opt", "lares", "compose.yaml"))).toBe(false);
  });

  it("refuses by name when the release names no image for a service the stack needs", () => {
    writeFileSync(releaseFile, JSON.stringify({
      release: "2026-10-01",
      images: { db: D("db"), "lares-gateway": D("gateway"), caddy: D("caddy") },
      migrations: { box: "087_update_history.sql" },
      breaking: [],
    }));
    const r = run(["--release", releaseFile]);
    expect(r.code).toBe(78);
    expect(r.stderr).toMatch(/console/);
  });
});

describe("the stack the installer brings up", () => {
  it("reads a release path relative to the caller before pnpm changes directory", () => {
    const callerDir = join(here, "..", "..", "..");
    const fromCaller = relative(callerDir, releaseFile);
    expect(fromCaller).not.toMatch(/^\//);
    expect(run(["--release", fromCaller], answers, {}, callerDir).code).toBe(0);
    const composeFile = join(prefix, "opt", "lares", "compose.yaml");
    const doc = parse(readFileSync(composeFile, "utf8")) as any;
    expect(doc.services.console.image).toBe(D("console"));
  });

  it("writes the release's own stack file where run_database looks for it", () => {
    expect(run(["--release", releaseFile]).code).toBe(0);
    const composeFile = join(prefix, "opt", "lares", "compose.yaml");
    const doc = parse(readFileSync(composeFile, "utf8")) as any;
    expect(doc.services.db.image).toBe(D("db"));
    expect(doc.services.console.image).toBe(D("console"));
    expect(doc.services["lares-gateway"].image).toBe(D("gateway"));
    expect(doc.services.caddy.image).toBe(D("caddy"));
    // The answered domain crossed into the container that needs it.
    expect(doc.services.caddy.environment.LARES_DOMAIN).toBe("lares.example.invalid");
    // Every secret file is named under this installation's own prefix, not under /.
    expect(doc.secrets["database-password"].file)
      .toBe(join(prefix, "etc", "lares", "secrets", "database-password"));
  });

  it("installs the committed Caddyfile at the path the compose file mounts", () => {
    expect(run(["--release", releaseFile]).code).toBe(0);
    const composeFile = join(prefix, "opt", "lares", "compose.yaml");
    const doc = parse(readFileSync(composeFile, "utf8")) as any;
    const mounted = String(doc.services.caddy.volumes[0]).split(":")[0]!;
    expect(existsSync(mounted)).toBe(true);
    expect(readFileSync(mounted, "utf8")).toBe(readFileSync(COMMITTED_CADDYFILE, "utf8"));
  });

  // F7c — THE GATEWAY'S START SCRIPT REACHES THE CONTAINER WITHOUT RE-HOSTING LITELLM'S IMAGE.
  // Nothing builds a gateway image (and nothing may: the official LiteLLM image carries its
  // `enterprise/` tree, whose licence forbids publishing or distributing it — see
  // docs/research/2026-09-18-prelaunch/08-litellm-okf.md), so the script is installed on the
  // host and bind-mounted in as the entrypoint. Two strings have to agree for that to start at
  // all — the path the volume mounts it at and the path the entrypoint executes — and they are
  // asserted against each other here, out of the file the installer actually wrote.
  it("installs the committed gateway start script where the compose entrypoint executes it", () => {
    expect(run(["--release", releaseFile]).code).toBe(0);
    const doc = parse(readFileSync(join(prefix, "opt", "lares", "compose.yaml"), "utf8")) as any;
    const gateway = doc.services["lares-gateway"];
    const mount = (gateway.volumes as string[]).find((v) => v.startsWith(`${join(prefix, "etc", "lares", "gateway-start.sh")}:`));
    expect(mount, "the compose file mounts no start script into the gateway").toBeTruthy();
    const [source, target] = String(mount).split(":");
    expect(gateway.entrypoint, "the mounted path and the executed path have drifted apart")
      .toEqual([target]);
    expect(existsSync(source!), `${source} was never written`).toBe(true);
    expect(readFileSync(source!, "utf8")).toBe(readFileSync(COMMITTED_GATEWAY_START, "utf8"));
  });

  // The mode is not decoration: an entrypoint the container cannot execute is a gateway that
  // never starts, while `docker compose up -d` still exits 0. `chmod` is a logging stub in this
  // file, so a mode only install.sh set would be invisible here — bin/render-stack.ts chmods it
  // itself, exactly as it does the gateway config, which is what makes this assertion real.
  it("leaves the installed start script executable, not merely readable", () => {
    expect(run(["--release", releaseFile]).code).toBe(0);
    const mode = statSync(join(prefix, "etc", "lares", "gateway-start.sh")).mode & 0o777;
    expect(mode, `the installed start script is mode ${mode.toString(8)}, not 0755`).toBe(0o755);
  });

  it("brings the whole stack up, not only the database", () => {
    expect(run(["--release", releaseFile]).code).toBe(0);
    expect(calls()).toMatch(/docker compose -f \S+compose\.yaml up -d\s*$/m);
  });

  // F7a-2 — the defect this slice closes: nothing ever wrote the file the compose file mounts
  // into the gateway, so Docker created a DIRECTORY at that path and the gateway could never
  // read a config. render-stack now writes it too, from the same two settings the gateway's
  // own config renderer takes (services/box/lib/gateway-config.ts): LARES_MODEL_ALIAS and the
  // new LARES_MODEL, both written into $INSTALL_ENV by write_installation_env.
  it("writes the gateway's own configuration, naming the alias and model this installation settled on", () => {
    expect(run(["--release", releaseFile]).code).toBe(0);
    const gatewayConfig = join(prefix, "etc", "lares", "litellm-config.yaml");
    expect(existsSync(gatewayConfig)).toBe(true);
    const installEnv = readFileSync(join(prefix, "etc", "lares", "installation.env"), "utf8");
    const alias = /^LARES_MODEL_ALIAS=(.+)$/m.exec(installEnv)?.[1];
    const model = /^LARES_MODEL=(.+)$/m.exec(installEnv)?.[1];
    expect(alias, "LARES_MODEL_ALIAS was not written to installation.env").toBeTruthy();
    expect(model, "LARES_MODEL was not written to installation.env").toBeTruthy();
    const doc = parse(readFileSync(gatewayConfig, "utf8")) as any;
    expect(doc.model_list[0].model_name).toBe(alias);
    expect(doc.model_list[0].litellm_params.model).toBe(model);
  });

  // ADDED BY THE CONTROLLER during F7a-2's integration, with the mode itself corrected from
  // 0640 to 0644. This file is mounted into the gateway container to be read by LiteLLM, and
  // LiteLLM publishes a `-non_root` image variant (docs/research/2026-09-18-prelaunch/
  // 08-litellm-okf.md) — the image comes from the release manifest, so the engine does not get
  // to assume the process reading this runs as root. A root-owned 0640 config is unreadable to
  // an unprivileged LiteLLM, which fails exactly the way the missing file did: the gateway
  // never serves, and the model check blames the key. Nothing here is secret — the provider key
  // is an `os.environ/…` reference, never a value.
  it("leaves the gateway's configuration readable by an unprivileged LiteLLM, not only by root", () => {
    expect(run(["--release", releaseFile]).code).toBe(0);
    const mode = statSync(join(prefix, "etc", "lares", "litellm-config.yaml")).mode & 0o777;
    expect(
      mode & 0o004,
      `the gateway config is mode ${mode.toString(8)}, which a non-root LiteLLM cannot read. ` +
        "Fix: bin/render-stack.ts writes it 0644 — it names no secret value, only the alias " +
        "and the provider+model string.",
    ).not.toBe(0);
  });

  // THE ORDER IS THE POINT, same as the model-check test below: a container mounts this file
  // read-only at start, so a config written after `docker compose … up -d` is a config the
  // gateway never sees. render-stack writes both files inside one call, logged here as one
  // `pnpm … render-stack` line, so pinning that line against the stub log is pinning the write.
  it("writes the gateway's own configuration before the stack comes up", () => {
    expect(run(["--release", releaseFile]).code).toBe(0);
    const rendered = at(/pnpm .*render-stack/);
    const up = at(/docker compose -f \S+compose\.yaml up -d/);
    expect(rendered, "render-stack was never called").toBeGreaterThan(-1);
    expect(up, "the stack was never brought up").toBeGreaterThan(-1);
    expect(
      rendered,
      "the stack came up before the gateway's configuration was rendered. Fix: in " +
        "install.sh's run_stack, the render-stack call (which writes the gateway config as " +
        "well as the compose file) must stay before `docker compose … up -d`.",
    ).toBeLessThan(up);
  });

  // THE ORDER TEST. This is the defect the slice exists to close: the model check calls the
  // gateway by its compose service name, so it can only answer once the stack is up. A right
  // value checked too early is not something any other installer test can see.
  it("tests the model key only after the gateway it calls is running", () => {
    expect(run(["--release", releaseFile]).code).toBe(0);
    const up = at(/docker compose -f \S+compose\.yaml up -d/);
    const check = at(/lares-doctor .*--test-model/);
    expect(up, "the stack was never brought up").toBeGreaterThan(-1);
    expect(check, "the model key was never tested").toBeGreaterThan(-1);
    expect(
      up,
      "the model check ran before the stack was up. It calls the gateway by its compose " +
        "service name, so there is nothing there to answer it yet, and the install dies saying " +
        "the key is wrong when it is not. Fix: in install.sh's dispatch block, run_stack goes " +
        "before run_model_check.",
    ).toBeLessThan(check);
  });

  it("presents the gateway's master key to the check, never the model provider's own key", () => {
    // F4's config sets general_settings.master_key, so LiteLLM authenticates callers against
    // its master key or a DB-backed virtual key — never the Anthropic provider key. Before any
    // per-agent key has been minted, the master key is the only credential it will accept.
    expect(run(["--release", releaseFile]).code).toBe(0);
    const line = calls().split("\n").find((l) => l.includes("--test-model"))!;
    expect(line).toContain("gateway-master-key");
    expect(line).not.toContain("model-provider-key");
  });

  it("stops before the database when the stack cannot be brought up, and changes nothing else", () => {
    stub("docker", 'printf "%s %s\\n" "docker" "$*" >> "$STUB_LOG"\ncase "$*" in *"up -d"*) echo "docker: no such image" >&2; exit 1 ;; esac\nexit 0');
    const r = run(["--release", releaseFile]);
    expect(r.code).toBe(78);
    expect(at(/lares-doctor .*--test-model/)).toBe(-1);
    expect(calls()).not.toMatch(/pnpm -C .*migrate/);
    // Everything generated before this point survives, so a re-run resumes rather than restarts.
    expect(existsSync(join(prefix, "etc", "lares", "secrets", "token-enc-key"))).toBe(true);
  });
});
