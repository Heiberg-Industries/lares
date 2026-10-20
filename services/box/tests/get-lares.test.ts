// get-lares.sh and the `lares` wrapper, driven with `curl` and `docker` stubs on PATH and a temp
// --prefix. The docker stub "unpacks" a fake engine tree (stub install/update/rollback scripts that
// log their arguments, plus the REAL get-lares.sh and lares) so the real wrapper logic runs end to end.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, chmodSync, rmSync, existsSync,
  copyFileSync, readlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

vi.setConfig({ testTimeout: 30_000 });

const OPS = join(dirname(fileURLToPath(import.meta.url)), "..", "ops");
const GET = join(OPS, "get-lares.sh");
const RC11 = "2026-10-19-rc.11";
const RC12 = "2026-10-20-rc.12";
const KEEPER = `ghcr.io/example/lares-keeper@sha256:${"b".repeat(64)}`;
const KEEPER12 = `ghcr.io/example/lares-keeper@sha256:${"c".repeat(64)}`;

const releaseJson = (name: string, keeper: string) =>
  JSON.stringify({ release: name, images: { "lares-keeper": keeper, caddy: `docker.io/library/caddy@sha256:${"d".repeat(64)}` }, migrations: {}, breaking: [] });

let dir: string, bin: string, prefix: string, log: string, served: string, fake: string;

function stub(name: string, body: string) {
  const p = join(bin, name);
  writeFileSync(p, `#!/usr/bin/env bash\nprintf '%s %s\\n' "${name}" "$*" >> "$STUB_LOG"\n${body}\n`);
  chmodSync(p, 0o755);
}
function script(path: string, body: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!/usr/bin/env bash\nprintf '%s %s\\n' "$(basename "$0")" "$*" >> "$STUB_LOG"\n${body}\n`);
  chmodSync(path, 0o755);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lares-getlares-"));
  bin = join(dir, "bin"); mkdirSync(bin);
  prefix = join(dir, "root"); mkdirSync(prefix);
  served = join(dir, "served"); mkdirSync(served);
  fake = join(dir, "fake-engine/services/box/ops");
  log = join(dir, "stubs.log"); writeFileSync(log, "");
  writeFileSync(join(served, `${RC11}.json`), releaseJson(RC11, KEEPER));
  writeFileSync(join(served, `${RC12}.json`), releaseJson(RC12, KEEPER12));
  // the fake engine: stub scripts, plus the real ones under test
  script(join(fake, "install.sh"), 'if [ -n "${FAIL_INSTALL:-}" ]; then exit 1; fi');
  script(join(fake, "update.sh"), 'if [ -n "${FAIL_UPDATE:-}" ]; then exit 1; fi');
  script(join(fake, "rollback.sh"), "exit 0");
  script(join(fake, "restore.sh"), "exit 0");
  script(join(fake, "setup-backups.sh"), "exit 0");
  writeFileSync(join(fake, "backup.sh"), "# new backup script\n");
  copyFileSync(GET, join(fake, "get-lares.sh")); chmodSync(join(fake, "get-lares.sh"), 0o755);
  copyFileSync(join(OPS, "lares"), join(fake, "lares")); chmodSync(join(fake, "lares"), 0o755);
  copyFileSync(join(OPS, "engine-run.sh"), join(fake, "engine-run.sh"));
  // curl: serves <served>/<basename of url>, or fails
  stub("curl",
    'out=""; url=""; while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2;; http*) url="$1"; shift;; *) shift;; esac; done\n' +
    '[ -z "${FAIL_CURL:-}" ] || exit 22\nf="$SERVED/$(basename "$url")"\n[ -f "$f" ] || exit 22\ncp "$f" "$out"');
  // docker: pull may fail; the unpack `run` copies the fake engine into the directory mounted at /out
  stub("docker",
    'case "$1" in\n  info|compose) exit 0 ;;\n  pull) [ -z "${FAIL_PULL:-}" ] || { echo "denied" >&2; exit 1; }; exit 0 ;;\n' +
    '  run) out=""; a=("$@"); for ((i=0;i<${#a[@]};i++)); do [ "${a[i]}" = -v ] && case "${a[i+1]}" in *:/out) out="${a[i+1]%:/out}";; esac; done\n' +
    '       if [ -n "$out" ]; then [ -z "${FAIL_UNPACK:-}" ] || exit 1; n=${a[${#a[@]}-2]}; d=${a[${#a[@]}-1]}\n' +
    '         mkdir -p "$out/$n"; cp -R "$FAKE_ENGINE/." "$out/$n/"; echo "$d" > "$out/$n/services/box/engine-image"; fi; exit 0 ;;\nesac\nexit 0');
  stub("id", 'echo "${FAKE_UID:-0}"');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const baseEnv = (extra: Record<string, string> = {}) => ({
  PATH: `${bin}:/usr/bin:/bin`, STUB_LOG: log, SERVED: served, FAKE_ENGINE: join(dir, "fake-engine"),
  LARES_PREFIX: prefix, HOME: dir, TMPDIR: dir, ...extra,
});
function run(file: string, args: string[], extra: Record<string, string> = {}) {
  try {
    const stdout = execFileSync("/bin/bash", [file, ...args], { encoding: "utf8", env: baseEnv(extra), stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, stdout, stderr: "" };
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string };
    return { code: err.status, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}
const get = (args: string[], extra: Record<string, string> = {}) => run(GET, ["--prefix", prefix, ...args], extra);
const lares = (args: string[], extra: Record<string, string> = {}) => run(join(prefix, "usr/local/bin/lares"), args, extra);
const calls = () => readFileSync(log, "utf8").split("\n").filter(Boolean);
const root = () => join(prefix, "opt/lares");
const current = () => readlinkSync(join(root(), "current"));
/** What is on disk under the prefix (the temp directory itself holds the stubs and logs, not the prefix). */
const prefixEntries = () => readdirSync(prefix);

describe("get-lares.sh", () => {
  it("downloads the named release, pulls its keeper by digest, unpacks it and hands over to install.sh", () => {
    const r = get(["--release", RC11]);
    expect(r.code, r.stderr).toBe(0);
    const c = calls();
    expect(c.find((l) => l.startsWith("curl "))).toContain(`https://raw.githubusercontent.com/Heiberg-Industries/lares/main/releases/${RC11}.json`);
    expect(c).toContain(`docker pull ${KEEPER}`);
    const unpack = c.find((l) => l.startsWith("docker run "))!;
    expect(unpack).toContain("--network none");
    expect(unpack).toMatch(new RegExp(`${RC11} ${KEEPER}$`));
    const rel = join(root(), "releases", RC11);
    expect(readFileSync(join(rel, "release.json"), "utf8")).toBe(releaseJson(RC11, KEEPER));
    const inst = c.find((l) => l.startsWith("install.sh "))!;
    expect(inst).toContain(`--release ${rel}/release.json`);
    expect(inst).toContain(`--prefix ${prefix}`);
    expect(current()).toBe(`releases/${RC11}`);
    expect(readlinkSync(join(prefix, "usr/local/bin/lares"))).toBe(join(root(), "current/services/box/ops/lares"));
  });

  it("passes every other argument on to install.sh unchanged", () => {
    const r = get(["--release", RC11, "--yes", "--domain", "example.com"]);
    expect(r.code, r.stderr).toBe(0);
    expect(calls().find((l) => l.startsWith("install.sh "))).toMatch(/--yes --domain example\.com$/);
  });

  it("with a failed pull says so plainly and writes nothing", () => {
    const r = get(["--release", RC11], { FAIL_PULL: "1" });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/could not download the Lares engine image/);
    expect(r.stderr).toMatch(/nothing was changed/i);
    expect(prefixEntries()).toEqual([]);
    expect(calls().some((l) => l.startsWith("install.sh "))).toBe(false);
  });

  it("with a failed download of the release file writes nothing", () => {
    const r = get(["--release", RC11], { FAIL_CURL: "1" });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/could not download the release file/);
    expect(prefixEntries()).toEqual([]);
  });

  it("is safe to run again", () => {
    expect(get(["--release", RC11]).code).toBe(0);
    const r = get(["--release", RC11]);
    expect(r.code, r.stderr).toBe(0);
    expect(current()).toBe(`releases/${RC11}`);
    expect(readdirSync(join(root(), "releases"))).toEqual([RC11]);
    expect(calls().filter((l) => l.startsWith("install.sh ")).length).toBe(2);
  });

  it("does not switch to the release when install.sh fails", () => {
    const r = get(["--release", RC11], { FAIL_INSTALL: "1" });
    expect(r.code).not.toBe(0);
    expect(existsSync(join(root(), "current"))).toBe(false);
    expect(existsSync(join(prefix, "usr/local/bin/lares"))).toBe(false);
  });

  it("--dry-run changes nothing under the prefix and still asks install.sh for a dry run", () => {
    const r = get(["--release", RC11, "--dry-run"]);
    expect(r.code, r.stderr).toBe(0);
    expect(prefixEntries()).toEqual([]);
    expect(calls().find((l) => l.startsWith("install.sh "))).toContain("--dry-run");
  });

  it("accepts only a full, exact release name", () => {
    for (const bad of ["rc.11", "latest", "../2026-10-19-rc.11", "2026-10-19-rc.11.json", "2026-10-19-rc.11/x"]) {
      const r = get(["--release", bad]);
      expect(r.code, bad).toBe(64);
      expect(r.stderr, bad).toMatch(/full release name/);
    }
    expect(calls()).toEqual([]);
  });

  it("refuses a release file whose own name differs, or whose keeper is not a ghcr.io digest", () => {
    writeFileSync(join(served, `${RC11}.json`), releaseJson(RC12, KEEPER));
    expect(get(["--release", RC11]).stderr).toMatch(/names itself/);
    writeFileSync(join(served, `${RC11}.json`), releaseJson(RC11, "ghcr.io/example/lares-keeper:latest"));
    expect(get(["--release", RC11]).stderr).toMatch(/digest/);
    writeFileSync(join(served, `${RC11}.json`), releaseJson(RC11, `docker.io/example/lares-keeper@sha256:${"b".repeat(64)}`));
    expect(get(["--release", RC11]).stderr).toMatch(/digest/);
    expect(calls().some((l) => l.startsWith("docker pull"))).toBe(false);
    expect(prefixEntries()).toEqual([]);
  });

  it("--release-file uses a local file and downloads nothing", () => {
    const f = join(dir, "local.json"); writeFileSync(f, releaseJson(RC11, KEEPER));
    const r = get(["--release-file", f]);
    expect(r.code, r.stderr).toBe(0);
    expect(calls().some((l) => l.startsWith("curl "))).toBe(false);
  });

  it("reports every problem in one pass, and writes nothing", () => {
    stub("docker", "exit 1");
    const r = get(["--release", RC11], { FAKE_UID: "1000" });
    expect(r.code).toBe(77);
    expect(r.stderr).toMatch(/root/);
    expect(r.stderr).toMatch(/docker/);
    expect(prefixEntries()).toEqual([]);
  });

  it("--fetch-only unpacks and stops before install.sh", () => {
    const r = get(["--release", RC11, "--fetch-only"]);
    expect(r.code, r.stderr).toBe(0);
    expect(existsSync(join(root(), "releases", RC11, "release.json"))).toBe(true);
    expect(existsSync(join(root(), "current"))).toBe(false);
    expect(calls().some((l) => l.startsWith("install.sh "))).toBe(false);
  });
});

describe("lares", () => {
  beforeEach(() => { expect(get(["--release", RC11]).code).toBe(0); writeFileSync(log, ""); });
  const names = () => calls().map((l) => l.split(" ")[0]);

  it("update fetches the release, runs update.sh then install.sh --yes, and only then switches current", () => {
    const r = lares(["update", "--release", RC12, "--yes"]);
    expect(r.code, r.stderr).toBe(0);
    const rel = join(root(), "releases", RC12);
    const c = calls();
    const u = c.findIndex((l) => l.startsWith("update.sh "));
    const i = c.findIndex((l) => l.startsWith("install.sh "));
    expect(u).toBeGreaterThanOrEqual(0);
    expect(i).toBeGreaterThan(u);
    expect(c[u]).toBe(`update.sh --release ${rel}/release.json --yes`);
    expect(c[i]).toBe(`install.sh --yes --release ${rel}/release.json`);
    expect(c).toContain(`docker pull ${KEEPER12}`);
    expect(current()).toBe(`releases/${RC12}`);
  });

  it("still updates when the unpacked get-lares.sh has no exec bit", () => {
    chmodSync(join(root(), "releases", RC11, "services/box/ops/get-lares.sh"), 0o644);
    const r = lares(["update", "--release", RC12]);
    expect(r.code, r.stderr).toBe(0);
    expect(current()).toBe(`releases/${RC12}`);
  });

  it("does not switch current when update.sh fails, and does not run install.sh", () => {
    const r = lares(["update", "--release", RC12], { FAIL_UPDATE: "1" });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/still on/i);
    expect(names()).not.toContain("install.sh");
    expect(current()).toBe(`releases/${RC11}`);
  });

  it("does not switch current when install.sh fails", () => {
    const r = lares(["update", "--release", RC12], { FAIL_INSTALL: "1" });
    expect(r.code).not.toBe(0);
    expect(names()).toContain("update.sh");
    expect(current()).toBe(`releases/${RC11}`);
  });

  it("does not touch the installation when the new release cannot be fetched", () => {
    const r = lares(["update", "--release", RC12], { FAIL_PULL: "1" });
    expect(r.code).not.toBe(0);
    expect(names()).not.toContain("update.sh");
    expect(current()).toBe(`releases/${RC11}`);
  });

  it("says when backup scripts on this server differ from the new release's, and leaves them alone", () => {
    writeFileSync(join(root(), "backup.sh"), "# old copy\n");
    const r = lares(["update", "--release", RC12]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/backup scripts.*older/i);
    expect(readFileSync(join(root(), "backup.sh"), "utf8")).toBe("# old copy\n");
  });

  it("maps rollback, restore and backups to the scripts of the current release", () => {
    expect(lares(["rollback", "--yes"]).code).toBe(0);
    expect(lares(["restore", "--snapshot", "latest"]).code).toBe(0);
    expect(lares(["backups", "--dry-run"]).code).toBe(0);
    const c = calls();
    expect(c).toContain("rollback.sh --yes");
    expect(c).toContain("restore.sh --snapshot latest");
    expect(c).toContain("setup-backups.sh --dry-run");
  });

  it("doctor runs the engine's doctor in a container of the current engine image", () => {
    const r = lares(["doctor"]);
    expect(r.code, r.stderr).toBe(0);
    const d = calls().find((l) => l.startsWith("docker run "))!;
    expect(d).toContain(KEEPER);
    expect(d).toContain("/app/services/box/bin/doctor.ts");
    expect(d).toContain(`${prefix}/etc/lares/secrets:${prefix}/etc/lares/secrets:ro`);
    expect(d).toContain("DATABASE_PASSWORD_FILE=");
    expect(d).not.toMatch(/PGPASSWORD/);
  });

  it("refuses an unknown command, a missing or short release name, and a user who is not root", () => {
    expect(lares(["frobnicate"]).code).toBe(64);
    expect(lares(["update"]).code).toBe(64);
    expect(lares(["update", "--release", "rc.12"]).code).toBe(64);
    expect(lares(["doctor"], { FAKE_UID: "1000" }).code).toBe(77);
  });
});
