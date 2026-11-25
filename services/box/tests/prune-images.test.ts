// prune-images.sh, driven with a `docker` stub on PATH: which images it removes, and which it must never touch.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = new URL("../ops/prune-images.sh", import.meta.url).pathname;
const digest = (n: number) => `sha256:${String(n).repeat(64).slice(0, 64)}`;
const ref = (name: string, n: number) => `registry.example.org/lares/${name}@${digest(n)}`;

let dir: string;
let releases: string;
let log: string;

function release(name: string, images: Record<string, string>): string {
  mkdirSync(join(releases, name), { recursive: true });
  writeFileSync(join(releases, name, "release.json"), JSON.stringify({ release: name, images }));
  return join(releases, name, "release.json");
}

/** The docker stub: `images` is what `docker image ls` lists (repo@digest id), `used` the image ids containers use. */
function docker(images: string[], used: string[], extra = ""): void {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  const stub = join(bin, "docker");
  writeFileSync(stub, `#!/bin/bash
echo "docker $*" >> "${log}"
${extra}
case "$1 $2" in
  "ps -a") ${used.length ? "echo c1" : ":"} ;;
  "inspect --format") ${used.map((id) => `echo ${id}`).join("; ") || ":"} ;;
  "image ls") cat <<'LIST'
${images.join("\n")}
LIST
  ;;
  "rmi "*) ;;
  *) [ "$1" = info ] && exit 1 ;;
esac
exit 0
`);
  chmodSync(stub, 0o755);
}

function run(args: string[]) {
  return execFileSync("/bin/bash", [SCRIPT, ...args], { encoding: "utf8", env: { PATH: `${join(dir, "bin")}:/usr/bin:/bin`, HOME: dir } });
}
const removed = () => readFileSync(log, "utf8").split("\n").filter((l) => l.startsWith("docker rmi ")).map((l) => l.slice("docker rmi ".length));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "prune-"));
  releases = join(dir, "releases");
  log = join(dir, "log");
  writeFileSync(log, "");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("prune-images.sh", () => {
  it("keeps the two kept releases, removes older release images, and never touches an image no release names", () => {
    release("r1", { engine: ref("engine", 1), console: ref("console", 1) });
    release("r2", { engine: ref("engine", 2), console: ref("console", 1) });
    const previous = release("r3", { engine: ref("engine", 3), console: ref("console", 3) });
    const current = release("r4", { engine: ref("engine", 4), console: ref("console", 3) });
    docker([
      `${ref("engine", 1)} idA`, `${ref("engine", 2)} idB`, `${ref("engine", 3)} idC`, `${ref("engine", 4)} idD`,
      `${ref("console", 1)} idE`, `${ref("console", 3)} idF`,
      `registry.example.org/other/tool@${digest(9)} idZ`,
    ], []);
    const out = run(["--releases-dir", releases, "--keep", current, "--keep", previous]);
    expect(removed().sort()).toEqual([ref("console", 1), ref("engine", 1), ref("engine", 2)].sort());
    expect(out).toMatch(/removed 3 old release image\(s\), freeing about \d+ MB/);
  });

  it("never removes an image a container is made from", () => {
    release("r1", { engine: ref("engine", 1) });
    const current = release("r2", { engine: ref("engine", 2) });
    docker([`${ref("engine", 1)} idA`, `${ref("engine", 2)} idB`], ["idA"]);
    const out = run(["--releases-dir", releases, "--keep", current]);
    expect(removed()).toEqual([]);
    expect(out).toContain("no old release images to remove");
  });

  it("matches Docker Hub images even though Docker leaves out the docker.io/ prefix", () => {
    release("r1", { db: `docker.io/pgvector/pgvector@${digest(1)}` });
    const current = release("r2", { db: `docker.io/pgvector/pgvector@${digest(2)}` });
    docker([`docker.io/pgvector/pgvector@${digest(1)} idA`, `pgvector/pgvector@${digest(2)} idB`], []);
    run(["--releases-dir", releases, "--keep", current]);
    expect(removed()).toEqual([`pgvector/pgvector@${digest(1)}`]);
  });

  it("removes nothing in a dry run, and nothing when it cannot read the release files to keep", () => {
    release("r1", { engine: ref("engine", 1) });
    const current = release("r2", { engine: ref("engine", 2) });
    docker([`${ref("engine", 1)} idA`, `${ref("engine", 2)} idB`], []);
    expect(run(["--releases-dir", releases, "--keep", current, "--dry-run"])).toContain("would be removed");
    expect(removed()).toEqual([]);
    expect(run(["--releases-dir", releases, "--keep", join(dir, "missing.json")])).toContain("no image was removed");
    expect(removed()).toEqual([]);
  });

  it("removes nothing when any one of the release files to keep cannot be read", () => {
    release("r1", { engine: ref("engine", 1) });
    const current = release("r2", { engine: ref("engine", 2) });
    mkdirSync(join(releases, "r0"), { recursive: true });
    writeFileSync(join(releases, "r0", "release.json"), "{ not json");
    docker([`${ref("engine", 1)} idA`, `${ref("engine", 2)} idB`], []);
    expect(run(["--releases-dir", releases, "--keep", current, "--keep", join(releases, "r0", "release.json")])).toContain("no image was removed");
    expect(removed()).toEqual([]);
  });

  it("carries on and exits 0 when one removal fails", () => {
    release("r1", { a: ref("a", 1), b: ref("b", 1) });
    const current = release("r2", { a: ref("a", 2), b: ref("b", 2) });
    docker([`${ref("a", 1)} idA`, `${ref("b", 1)} idB`], [], `case "$*" in "rmi ${ref("a", 1)}") exit 1;; esac`);
    const out = run(["--releases-dir", releases, "--keep", current]);
    expect(out).toContain(`could not remove ${ref("a", 1)}`);
    expect(removed()).toContain(ref("b", 1));
  });
});
