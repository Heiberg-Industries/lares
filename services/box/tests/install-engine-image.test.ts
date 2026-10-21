// The box's own programs (migrate, the renderers, first-owner, doctor) run in a throwaway
// container of the engine image, never on the host. This file pins how install.sh asks for that:
// which image, with what flags, with which mounts, and that no secret ever travels in argv.
//
// Two harnesses, both with every host command a logging stub on PATH and a temp `--prefix`:
//   (a) the docker stub only LOGS the `docker run` it is given (and answers the engine's
//       placeholders), so the assertions are about the argv install.sh built;
//   (b) the docker stub TRANSLATES the call (tests/helpers/engine-docker.ts) into this
//       checkout's real tsx, so the rendered compose.yaml and keeper.json are real files.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, chmodSync, rmSync, existsSync, copyFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ENGINE_IMAGE, engineDockerPrelude } from "./helpers/engine-docker.js";

vi.setConfig({ testTimeout: 30_000 });

const here = dirname(fileURLToPath(import.meta.url));
const BOX = join(here, "..");
const SCRIPT = join(BOX, "ops", "install.sh");

const D = (n: string) => `example.invalid/lares-${n}@sha256:${"a".repeat(64)}`;
const IMAGES: Record<string, string> = {
  db: D("db"), console: D("console"), "lares-gateway": D("gateway"), caddy: D("caddy"),
  "lares-keeper": D("keeper"), "lares-egress-proxy": D("egress-proxy"),
  "lares-firewall-helper": D("firewall-helper"), "chief-of-staff": D("chief-of-staff"), creative: D("creative"),
};
const release = (images = IMAGES) =>
  JSON.stringify({ release: "2026-10-01", images, migrations: { box: "001_baseline.sql" }, breaking: [] });

let dir: string, binDir: string, prefix: string, log: string, releaseFile: string;

function stub(name: string, body = "exit 0", runner: "pnpm" | "tsx" = "pnpm") {
  const p = join(binDir, name);
  const engine = name === "docker" ? engineDockerPrelude(runner) : "";
  writeFileSync(p, `#!/usr/bin/env bash\nprintf '%s %s\\n' "${name}" "$*" >> "$STUB_LOG"\n${engine}${body}\n`);
  chmodSync(p, 0o755);
}

// Read a piped psql's SQL as the real one does: install.sh runs `printf 'CREATE DATABASE …' |
// docker compose exec -T db psql …` under pipefail, so a stub that exits without reading lets the
// printf die of SIGPIPE whenever it loses the race (only under load), and the install stops.
const READS_PIPED_PSQL = 'case "$*" in *"exec -T db psql"*) cat >/dev/null ;; esac\nexit 0';

const answers = ["lares.example.invalid", "owner@example.invalid", "A Name", "sk-disposable-fixture-only"].join("\n") + "\n";

function run(args: string[], env: Record<string, string> = {}, input = answers) {
  // spawnSync keeps stderr on success as well as on failure, so a failed assertion can show it.
  const r = spawnSync("/bin/bash", [SCRIPT, "--yes", ...args], {
    input,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      PATH: `${binDir}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      STUB_LOG: log, LARES_PREFIX: prefix, HOME: dir, ...env,
    },
  });
  return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** Run the installer and require success; a failure shows the installer's own stderr. */
function ok(r: ReturnType<typeof run>) {
  expect(r.code, `install.sh exited ${r.code}; stderr:\n${r.stderr}`).toBe(0);
  return r;
}

const calls = () => readFileSync(log, "utf8");
/** Every `docker run …` the installer made, one string per call. */
const engineRuns = () => calls().split("\n").filter((l) => l.startsWith("docker run "));
const programOf = (line: string) => [...line.matchAll(/\/app\/services\/box\/(\S+)/g)].pop()![1]!.replace(/^bin\//, "");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lares-install-engine-"));
  binDir = join(dir, "bin"); mkdirSync(binDir);
  prefix = join(dir, "root"); mkdirSync(prefix);
  log = join(dir, "stubs.log"); writeFileSync(log, "");
  releaseFile = join(dir, "release.json"); writeFileSync(releaseFile, release());
  for (const name of ["systemctl", "useradd", "groupadd", "chown", "chmod", "ufw", "curl", "openssl", "lares-doctor"]) stub(name);
  // (a): the docker stub logs the engine's `docker run`, and lets the placeholder pnpm answer.
  stub("docker", READS_PIPED_PSQL);
  stub("pnpm",
    `case "$3" in render-stack) printf 'services:\\n  db: {}\\n' > "$5"; exit 0 ;; ` +
    `render-keeper-config) printf '{}\\n' > "$5"; printf 'LARES_KEEPER_IMAGE=placeholder\\n' > "$6"; exit 0 ;; esac\nexit 0`);
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

describe("what install.sh asks the engine image to run", () => {
  it("runs all six helpers in the named image, in the same order as before", () => {
    ok(run(["--release", releaseFile], { LARES_ENGINE_IMAGE: ENGINE_IMAGE }));
    const runs = engineRuns();
    expect(runs.map(programOf)).toEqual([
      "render-stack.ts", "migrate.ts", "installation-settings.ts", "first-owner.ts",
      "first-organisation.ts", "render-keeper-config.ts",
    ]);
    for (const line of runs) {
      expect(line).toContain(ENGINE_IMAGE);
      // The sandbox: host network, root inside, read-only filesystem, no capabilities, no Docker socket.
      expect(line).toContain("--network host --user 0:0 --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges");
      expect(line).not.toContain("docker.sock");
      expect(line).toContain("--entrypoint /app/services/box/node_modules/.bin/tsx");
    }
  });

  it("hands the database password over as a file, never as a value", () => {
    ok(run(["--release", releaseFile], { LARES_ENGINE_IMAGE: ENGINE_IMAGE }));
    const secrets = join(prefix, "etc", "lares", "secrets");
    const dbRuns = engineRuns().filter((l) => /migrate|installation-settings|first-owner|first-organisation/.test(programOf(l)));
    expect(dbRuns).toHaveLength(4);
    for (const line of dbRuns) {
      expect(line).toContain(`-e DATABASE_PASSWORD_FILE=${secrets}/database-password`);
      expect(line).toContain(`-v ${secrets}:${secrets}:ro`);
      expect(line).not.toContain("PGPASSWORD");
    }
    // No secret value appears anywhere in anything any stub was given, stdin included.
    const text = calls();
    for (const name of readdirSync(secrets)) {
      const value = readFileSync(join(secrets, name), "utf8").trim();
      if (value.length >= 8) expect(text, `the value of ${name} reached a command line`).not.toContain(value);
    }
    expect(text).not.toContain("sk-disposable-fixture-only");
  });

  it("mounts only paths under --prefix (plus the secrets read-only), each at the same path inside", () => {
    ok(run(["--release", releaseFile], { LARES_ENGINE_IMAGE: ENGINE_IMAGE }));
    const mounts = engineRuns().flatMap((l) => [...l.matchAll(/ -v (\S+)/g)].map((m) => m[1]!));
    expect(mounts.length).toBeGreaterThan(0);
    for (const m of mounts) {
      const [from, to, mode] = m.split(":");
      expect(to, m).toBe(from);
      expect(from!.startsWith(prefix) || from === releaseFile, m).toBe(true);
      expect(["ro", undefined], m).toContain(mode);
    }
    const render = engineRuns().find((l) => l.includes("render-stack"))!;
    expect(render).toContain(`-v ${join(prefix, "opt", "lares")}:${join(prefix, "opt", "lares")} `);
    expect(render).toContain(`-v ${releaseFile}:${releaseFile}:ro`);
  });

  it("mounts the installation's deadline calendar for the renderers only when it exists", () => {
    ok(run(["--release", releaseFile], { LARES_ENGINE_IMAGE: ENGINE_IMAGE }));
    expect(engineRuns().join("\n")).not.toMatch(/ -v \S*srv\/lares\/installation/);
    const installation = join(prefix, "srv", "lares", "installation");
    mkdirSync(installation, { recursive: true });
    writeFileSync(join(installation, "deadline-calendar.json"), "{}\n");
    writeFileSync(log, "");
    ok(run(["--release", releaseFile], { LARES_ENGINE_IMAGE: ENGINE_IMAGE }));
    for (const line of engineRuns().filter((l) => /render-/.test(l))) {
      expect(line).toContain(`-v ${installation}:${installation}:ro`);
    }
  });

  it("falls back to doctor in the engine image only when no lares-doctor is on PATH", () => {
    rmSync(join(binDir, "lares-doctor"));
    // Not a stub on PATH: the model check must reach the engine image.
    ok(run(["--release", releaseFile], { LARES_ENGINE_IMAGE: ENGINE_IMAGE }));
    const doctor = engineRuns().find((l) => programOf(l) === "doctor.ts");
    expect(doctor, "the model check never reached the engine image").toBeDefined();
    expect(doctor).toContain("--test-model --model-only");
    expect(doctor).toContain(`--key-file ${join(prefix, "etc", "lares", "secrets", "gateway-master-key")}`);
    expect(doctor).toContain(`-v ${join(prefix, "etc", "lares", "secrets")}:${join(prefix, "etc", "lares", "secrets")}:ro`);
  });

  it("keeps a lares-doctor on PATH ahead of the engine image", () => {
    ok(run(["--release", releaseFile], { LARES_ENGINE_IMAGE: ENGINE_IMAGE }));
    expect(engineRuns().map(programOf)).not.toContain("doctor.ts");
    expect(calls()).toMatch(/^lares-doctor --test-model/m);
  });
});

describe("which engine image is used", () => {
  const OTHER = `example.invalid/lares-keeper@sha256:${"b".repeat(64)}`;
  const FROM_FILE = `example.invalid/lares-keeper@sha256:${"c".repeat(64)}`;
  let boxDir: string;

  beforeEach(() => {
    // A box directory the way unpack-engine.sh lays one out, without the image file yet.
    boxDir = join(dir, "engine", "services", "box");
    mkdirSync(boxDir, { recursive: true });
    copyFileSync(join(BOX, "compose.lares-keeper.yaml"), join(boxDir, "compose.lares-keeper.yaml"));
    mkdirSync(join(dir, "engine", "services", "creative", "sql"), { recursive: true });
    copyFileSync(join(BOX, "..", "creative", "sql", "001-eve-workflow.sql"), join(dir, "engine", "services", "creative", "sql", "001-eve-workflow.sql"));
  });

  const images = () => engineRuns().map((l) => /--entrypoint \S+ (\S+) /.exec(l)![1]);

  it("prefers LARES_ENGINE_IMAGE, then the engine-image file, then the release file", () => {
    writeFileSync(join(boxDir, "engine-image"), `${FROM_FILE}\n`);
    ok(run(["--release", releaseFile], { LARES_BOX_DIR: boxDir, LARES_ENGINE_IMAGE: OTHER }));
    expect(new Set(images())).toEqual(new Set([OTHER]));

    writeFileSync(log, "");
    rmSync(join(prefix), { recursive: true, force: true }); mkdirSync(prefix);
    ok(run(["--release", releaseFile], { LARES_BOX_DIR: boxDir }));
    expect(new Set(images())).toEqual(new Set([FROM_FILE]));

    writeFileSync(log, "");
    rmSync(join(prefix), { recursive: true, force: true }); mkdirSync(prefix);
    rmSync(join(boxDir, "engine-image"));
    ok(run(["--release", releaseFile], { LARES_BOX_DIR: boxDir }));
    expect(new Set(images())).toEqual(new Set([D("keeper")]));
  });

  it("refuses a tag, in the same one-pass list as the other problems", () => {
    stub("free", 'echo "Mem: 1024 512 512"');
    const r = run(["--dry-run", "--release", releaseFile], { LARES_ENGINE_IMAGE: "example.invalid/lares-keeper:latest" });
    expect(r.code).toBe(78);
    expect(r.stderr).toMatch(/engine image is not known/);
    expect(r.stderr).toMatch(/memory/i);
    expect(existsSync(join(prefix, "etc"))).toBe(false);
  });

  it("reports a missing local image by its digest and what to do", () => {
    stub("docker", 'case "$*" in "image inspect"*) exit 1 ;; esac\nexit 0');
    const r = run(["--dry-run", "--release", releaseFile], { LARES_ENGINE_IMAGE: OTHER });
    expect(r.code).toBe(78);
    expect(r.stderr).toContain(`not on this box: ${OTHER}`);
    expect(r.stderr).toContain(`docker image pull ${OTHER}`);
    expect(engineRuns()).toEqual([]);
  });

  it("finds the image in the release file alone, with nothing else configured", () => {
    ok(run(["--dry-run", "--release", releaseFile]));
    expect(calls()).toContain(`image inspect ${D("keeper")}`);
  });
});

describe("the renderers, run for real through the translated call", () => {
  it("writes a real compose.yaml and keeper.json, and installs the gateway start script from /app", () => {
    stub("docker", READS_PIPED_PSQL, "tsx");
    ok(run(["--release", releaseFile], { LARES_ENGINE_IMAGE: ENGINE_IMAGE }));
    const compose = readFileSync(join(prefix, "opt", "lares", "compose.yaml"), "utf8");
    expect(compose).toContain(D("console"));
    expect(compose).toContain(D("caddy"));
    const keeper = JSON.parse(readFileSync(join(prefix, "etc", "lares", "keeper.json"), "utf8"));
    expect(keeper.lifecycle.imageByRole["chief-of-staff"]).toBe(D("chief-of-staff"));
    expect(readFileSync(join(prefix, "etc", "lares", "gateway-start.sh"), "utf8"))
      .toBe(readFileSync(join(BOX, "..", "..", "images", "gateway-runtime", "start.sh"), "utf8"));
    // The same run went through the engine image for every helper, and the renderer was given
    // the folder keeper.json lives in (it reads the previous file there and writes beside it).
    expect(engineRuns()).toHaveLength(6);
    const keeperRun = engineRuns().find((l) => l.includes("render-keeper-config"))!;
    expect(keeperRun).toContain(`-v ${join(prefix, "etc", "lares")}:${join(prefix, "etc", "lares")} `);
  });
});
