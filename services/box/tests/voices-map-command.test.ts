// `lares voices map` on the host: argument checks, and what it hands the engine container.
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const image = `example.invalid/keeper@sha256:${"a".repeat(64)}`;
let root: string, ops: string, bin: string, record: string, secret: string;

const lares = (...args: string[]) => spawnSync("bash", [join(ops, "lares"), ...args], {
  encoding: "utf8", env: { ...process.env, LARES_PREFIX: root, PATH: `${bin}:${process.env.PATH}`, TMPDIR: root },
});
const stub = (name: string, body: string) => { writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`); chmodSync(join(bin, name), 0o755); };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lares-voices-cmd-"));
  const release = join(root, "opt", "lares", "releases", "r1");
  ops = join(release, "services", "box", "ops");
  bin = join(root, "bin");
  record = join(root, "docker-args.txt");
  mkdirSync(ops, { recursive: true });
  mkdirSync(bin);
  symlinkSync(release, join(root, "opt", "lares", "current"));
  for (const name of ["lares", "engine-run.sh"]) copyFileSync(join(here, "..", "ops", name), join(ops, name));
  writeFileSync(join(release, "release.json"), JSON.stringify({ images: { "lares-keeper": image } }));
  secret = join(root, "etc", "lares", "secrets", "database-password");
  mkdirSync(dirname(secret), { recursive: true });
  writeFileSync(secret, "not-a-real-password\n");
  stub("id", "echo 0");
  stub("docker", `printf '%s\\n' "$@" > "${record}"`);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("lares voices map", () => {
  it("explains itself and refuses bad usage without starting anything", () => {
    for (const args of [["voices"], ["voices", "list"], ["voices", "map", "--surprise"], ["voices", "map", "--map"],
      ["voices", "map", "--map", "no-equals-sign"], ["voices", "map", "--map", "=acct-1"], ["voices", "map", "--map", "owner@example.invalid="]]) {
      expect(lares(...args).status, args.join(" ")).toBe(64);
    }
    expect(lares("voices").stderr).toContain("lares voices map [--map <mailbox>=<account id>]... [--apply]");
    expect(lares("voices", "map", "--surprise").stderr).toContain("I do not know the option --surprise for voices map. Nothing was changed.");
    expect(existsSync(record)).toBe(false);
  });

  it("refuses when the server has no database password file", () => {
    rmSync(secret);
    const result = lares("voices", "map");
    expect(result.status).toBe(78);
    expect(result.stderr).toContain("this server has no database password file");
    expect(existsSync(record)).toBe(false);
  });

  it("runs the report in the engine image as the application login, with only the password file mounted", () => {
    const result = lares("voices", "map");
    expect(result.status, result.stderr).toBe(0);
    const args = readFileSync(record, "utf8").split("\n").filter(Boolean);
    expect(args).toContain(image);
    expect(args).toContain(`${secret}:${secret}:ro`);
    expect(args).toContain(`DATABASE_PASSWORD_FILE=${secret}`);
    expect(args).toContain("PGUSER=lares_app");
    const at = args.indexOf("/app/services/box/bin/voice-mapping.ts");
    expect(at).toBeGreaterThan(0);
    expect(args.slice(at + 1)).toEqual([]);
  });

  it("passes --map and --apply through unchanged", () => {
    const result = lares("voices", "map", "--map", "owner@example.invalid=acct-1", "--apply", "--map", "b@example.invalid=acct-2");
    expect(result.status, result.stderr).toBe(0);
    const args = readFileSync(record, "utf8").split("\n").filter(Boolean);
    const at = args.indexOf("/app/services/box/bin/voice-mapping.ts");
    expect(args.slice(at + 1)).toEqual(["--map", "owner@example.invalid=acct-1", "--apply", "--map", "b@example.invalid=acct-2"]);
  });

  it("passes the engine's refusal code back", () => {
    stub("docker", "exit 78");
    expect(lares("voices", "map", "--apply").status).toBe(78);
  });
});
