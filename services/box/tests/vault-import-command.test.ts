import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const image = `example.invalid/keeper@sha256:${"a".repeat(64)}`;
const planId = "b".repeat(64);
let root: string, ops: string, bin: string, notes: string, record: string;

const lares = (...args: string[]) => spawnSync("bash", [join(ops, "lares"), ...args], {
  encoding: "utf8", env: { ...process.env, LARES_PREFIX: root, PATH: `${bin}:${process.env.PATH}`, TMPDIR: root },
});
const stub = (name: string, body: string) => { writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`); chmodSync(join(bin, name), 0o755); };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lares-vault-cmd-"));
  const release = join(root, "opt", "lares", "releases", "r1");
  ops = join(release, "services", "box", "ops");
  bin = join(root, "bin");
  record = join(root, "docker-args.txt");
  mkdirSync(ops, { recursive: true });
  mkdirSync(bin);
  symlinkSync(release, join(root, "opt", "lares", "current"));
  for (const name of ["lares", "engine-run.sh"]) copyFileSync(join(here, "..", "ops", name), join(ops, name));
  writeFileSync(join(release, "release.json"), JSON.stringify({ images: { "lares-keeper": image } }));
  mkdirSync(join(root, "srv", "lares", "installation"), { recursive: true });
  writeFileSync(join(root, "srv", "lares", "installation", "vault-storage.json"), JSON.stringify({
    areas: [{ relativePath: "vault/private/aaa", origin: "/var/lib/lares-vault-git/aaa.git" }, { relativePath: "vault/shared/bbb", origin: "/var/lib/lares-vault-git/bbb.git" }],
  }));
  notes = join(root, "my-notes");
  mkdirSync(notes);
  writeFileSync(join(notes, "a.md"), "hello\n");
  symlinkSync("/etc/hosts", join(notes, "link.md"));
  stub("id", "echo 0");
  stub("chown", "exit 0");
  // The stand-in container records its arguments and what the scratch copy looked like while it ran.
  stub("docker", `printf '%s\\n' "$@" > "${record}"\nfor a in "$@"; do case "$a" in */source) ls -a "$a" > "${record}.listing"; echo "$a" > "${record}.source";; esac; done`);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("lares vault import", () => {
  it("explains itself and refuses bad usage without touching anything", () => {
    for (const args of [["vault"], ["vault", "import"], ["vault", "export", notes], ["vault", "import", notes, "--surprise"], ["vault", "import", notes, "--apply"],
      ["vault", "import", notes, "--confirm", planId], ["vault", "import", notes, "--apply", "--confirm", "short"], ["vault", "import", notes, "--origin", "third_party"],
      ["vault", "import", notes, "--shared"], ["vault", "import", join(root, "missing")], ["vault", "import", notes, "--map", join(root, "missing.json")]]) {
      const result = lares(...args);
      expect(result.status, args.join(" ")).toBe(64);
    }
    expect(lares("vault").stderr).toContain("lares vault import <folder>");
    symlinkSync(notes, join(root, "alias"));
    expect(lares("vault", "import", join(root, "alias")).status).toBe(64);
    expect(existsSync(record)).toBe(false);
  });

  it("refuses when the Vault setup is unfinished or missing", () => {
    writeFileSync(join(root, "srv", "lares", "installation", "vault-storage.pending.json"), "{}");
    const pending = lares("vault", "import", notes);
    expect(pending.status).toBe(78);
    expect(pending.stderr).toContain("not finished");
    rmSync(join(root, "srv", "lares", "installation", "vault-storage.pending.json"));
    rmSync(join(root, "srv", "lares", "installation", "vault-storage.json"));
    const missing = lares("vault", "import", notes);
    expect(missing.status).toBe(78);
    expect(missing.stderr).toContain("no Vault yet");
    expect(existsSync(record)).toBe(false);
  });

  it("previews from a private copy as the runtime user with only the two areas writable, then removes the copy", () => {
    const map = join(root, "rules.json");
    writeFileSync(map, "{}");
    const result = lares("vault", "import", notes, "--map", map, "--shared", "Team", "--skip", "*.tmp", "--origin", "owner", "--include-conversations");
    expect(result.status, result.stderr).toBe(0);
    const args = readFileSync(record, "utf8").split("\n");
    const at = args.indexOf("/app/services/box/bin/vault-import.ts");
    expect(args[at + 1]).toBe("preview");
    expect(args).toContain("10001:10001");
    expect(args).toContain(`${root}/srv/vault/private/aaa:${root}/srv/vault/private/aaa`);
    expect(args).toContain(`${root}/var/lib/lares-vault-git/bbb.git:${root}/var/lib/lares-vault-git/bbb.git`);
    expect(args.join("\n")).toContain("--label\nmy-notes");
    expect(args.join("\n")).toContain("--shared\nTeam\n--skip\n*.tmp\n--origin\nowner\n--include-conversations");
    expect(args.join("\n")).not.toContain("--confirm");
    const copiedMap = args[args.indexOf("--map") + 1]!;
    expect(copiedMap.endsWith("/map.json")).toBe(true);
    expect(copiedMap).not.toBe(map);
    expect(readFileSync(`${record}.listing`, "utf8")).toContain("a.md");
    expect(readFileSync(`${record}.listing`, "utf8")).toContain("link.md");
    const scratch = dirname(readFileSync(`${record}.source`, "utf8").trim());
    expect(existsSync(scratch)).toBe(false);
    expect(lstatSync(join(notes, "link.md")).isSymbolicLink()).toBe(true);
  });

  it("passes the confirmed plan through on --apply", () => {
    const result = lares("vault", "import", notes, "--apply", "--confirm", planId);
    expect(result.status, result.stderr).toBe(0);
    const args = readFileSync(record, "utf8").split("\n");
    expect(args[args.indexOf("/app/services/box/bin/vault-import.ts") + 1]).toBe("apply");
    expect(args.join("\n")).toContain(`--confirm\n${planId}`);
  });

  it("passes the engine's refusal code back", () => {
    stub("docker", "exit 78");
    expect(lares("vault", "import", notes).status).toBe(78);
  });
});
