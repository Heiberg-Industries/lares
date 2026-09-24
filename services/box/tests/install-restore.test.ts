// W8C-s3 — screen one: start fresh, or restore from a backup (owner decision C3).
//
// "Restore from a backup" NEVER restores anything in this slice. It checks the archive the
// way docs/runbooks/export-and-teardown.md section 4 checks it by hand — a readable tar,
// manifest.json present and parseable, every file it lists present with the right size and
// sha256 — reports what it found (counts only, never contents), prints the runbook's path and
// names the two steps nobody has rehearsed (5a: loading globals.sql, 5d: restoring a vault from
// a bundle), and stops. "Start fresh" falls straight through into the installer unchanged.
//
// The plan's own failing-test snippet (`.claude/plans/2026-09-20-prelaunch-wave-8.md`, W8C-s3)
// proves an archive is READABLE and stops there ("not really a tar" / "x" as the whole
// archive). The task this slice was actually built against asks for a stronger check: the
// archive must be a genuine, readable tar whose manifest.json really describes what's inside
// (right size, right sha256 per file) — a bogus one-line string can never satisfy that, so
// tests 3 and 4 below use a REAL crafted tar + manifest instead of the plan's placeholder
// strings. Tests 1 and 2 are otherwise as the plan states them. Extra tests beyond the plan's
// four cover the stronger bar directly: a tampered manifest, a hostile archive member (absolute
// path / "..") refused before a byte is extracted, and the non-interactive "no terminal, no
// --yes, no --restore" case that must refuse rather than hang.
//
// Every external command this script calls that could touch a real host (docker, systemctl,
// useradd, chown, ufw, curl, pnpm, openssl) is a logging stub on PATH ahead of everything else —
// the same pattern tests/install-preflight.test.ts and tests/install-secrets.test.ts already
// use. `tar` and `sha256sum`/`shasum` are the REAL system tools: they only ever read the
// archive and write into a temp directory this test also controls, never the real filesystem.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtempSync, mkdirSync, writeFileSync, chmodSync, readdirSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, "..", "ops", "install.sh");

let dir: string, binDir: string, prefix: string, log: string;

/** A stub that logs its own name and argv, and exits 0. */
function stub(name: string, body = "exit 0") {
  const p = join(binDir, name);
  writeFileSync(p, `#!/usr/bin/env bash\nprintf '%s %s\\n' "${name}" "$*" >> "$STUB_LOG"\n${body}\n`);
  chmodSync(p, 0o755);
}

function run(args: string[], env: Record<string, string> = {}) {
  try {
    const stdout = execFileSync("/bin/bash", [SCRIPT, ...args], {
      encoding: "utf8",
      timeout: 10_000, // a script that hangs waiting for input must fail fast, not hang the suite
      env: { PATH: `${binDir}:/usr/bin:/bin`, STUB_LOG: log, LARES_PREFIX: prefix, HOME: dir, ...env },
    });
    return { code: 0, stdout, stderr: "" };
  } catch (e) {
    const err = e as { status: number | null; signal?: string | null; stdout: string; stderr: string };
    return { code: err.status ?? -1, stdout: err.stdout ?? "", stderr: err.stderr ?? "", signal: err.signal ?? null };
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lares-install-restore-"));
  binDir = join(dir, "bin"); mkdirSync(binDir);
  prefix = join(dir, "root"); mkdirSync(prefix);
  log = join(dir, "stubs.log"); writeFileSync(log, "");
  for (const name of ["docker", "systemctl", "useradd", "groupadd", "chown", "ufw", "curl", "pnpm", "openssl"]) stub(name);
  stub("id", "echo 0");                                   // running as root
  stub("uname", "echo Linux");
  stub("free", 'echo "Mem: 8192 1024 7168"');
  stub("df", 'echo "/dev/x 100000000 1000000 99000000 1% /"');
  stub("ss", "exit 1");                                   // nothing listening on 80/443
  stub("lsb_release", "echo 24.04");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// --- a genuine tar builder, byte for byte -----------------------------------------------
// Deliberately NOT the system `tar` for the crafted-archive fixtures below: a hostile member
// ("../evil.txt", an absolute path) is exactly what a well-behaved `tar` refuses to CREATE, so
// the only way to prove install.sh refuses one on the way IN is to hand-write the bytes.
// Real (non-hostile) fixtures use this too, for one code path across every test.
function ustarHeader(name: string, size: number, link?: { type: "1" | "2"; target: string }): Buffer {
  const buf = Buffer.alloc(512);
  buf.write(name, 0, "utf8");
  buf.write("0000644\0", 100, "utf8");   // mode
  buf.write("0000000\0", 108, "utf8");   // uid
  buf.write("0000000\0", 116, "utf8");   // gid
  buf.write(`${size.toString(8).padStart(11, "0")}\0`, 124, "utf8"); // size
  buf.write("00000000000\0", 136, "utf8"); // mtime
  buf.write("        ", 148, "ascii");   // chksum placeholder: 8 spaces
  buf.write(link ? link.type : "0", 156, "ascii"); // typeflag: 0 file · 1 hard link · 2 symbolic link
  if (link) buf.write(link.target, 157, "utf8");   // linkname
  buf.write("ustar\0", 257, "ascii");    // magic
  buf.write("00", 263, "ascii");         // version
  let sum = 0;
  for (const b of buf) sum += b;
  buf.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
  return buf;
}
function makeTar(entries: { name: string; content: string; link?: { type: "1" | "2"; target: string } }[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    if (e.link) { parts.push(ustarHeader(e.name, 0, e.link)); continue; }
    const content = Buffer.from(e.content, "utf8");
    parts.push(ustarHeader(e.name, content.length), content);
    const pad = (512 - (content.length % 512)) % 512;
    if (pad) parts.push(Buffer.alloc(pad));
  }
  parts.push(Buffer.alloc(1024)); // two zero blocks: end of archive
  return Buffer.concat(parts);
}
function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** A genuine export archive: globals.sql, one dump, one vault bundle, one data tar, and a
 *  manifest.json in exactly the shape services/box/ops/export.sh writes — one file entry per
 *  line, engineVersion + date at the top. Every size and sha256 is computed from the real
 *  content, so this fixture is only as trustworthy as the content strings below, same as a
 *  real export is only as trustworthy as what it dumped. */
function genuineExportFiles() {
  return [
    { name: "./globals.sql", content: "-- roles\nCREATE ROLE lares;\n" },
    { name: "./lares.dump", content: "FAKE-PG-CUSTOM-DUMP-BYTES-lares" },
    { name: "./keeper.dump", content: "FAKE-PG-CUSTOM-DUMP-BYTES-keeper" },
    { name: "./brain.bundle", content: "FAKE-GIT-BUNDLE-BYTES-brain" },
    { name: "./lares.tar", content: "FAKE-DATA-TAR-BYTES-lares" },
  ];
}
function manifestFor(files: { name: string; content: string }[]): string {
  const lines = files.map((f) => {
    const size = Buffer.byteLength(f.content, "utf8");
    const name = f.name.replace(/^\.\//, "");
    return `    {"name": "${name}", "size": ${size}, "sha256": "${sha256(f.content)}"}`;
  });
  return [
    "{",
    '  "engineVersion": "2026.09.20-test",',
    '  "date": "2026-09-19T00:00:00Z",',
    '  "files": [',
    lines.join(",\n"),
    "  ]",
    "}",
    "",
  ].join("\n");
}
/** Writes a genuine, self-consistent archive and returns its path. */
function writeGenuineArchive(path: string, corrupt?: (files: { name: string; content: string }[]) => void) {
  const files = genuineExportFiles();
  const manifest = manifestFor(files); // computed from the UNCORRUPTED content on purpose —
  // corrupting content after the manifest is built is what makes an archive "tampered": the
  // manifest still claims the original size/sha256, but the bytes inside no longer match it.
  if (corrupt) corrupt(files);
  const tar = makeTar([...files, { name: "./manifest.json", content: manifest }]);
  writeFileSync(path, tar);
}

describe("screen one: start fresh, or restore from a backup", () => {
  it("passes a syntax check under this machine's bash", () => {
    expect(() => execFileSync("/bin/bash", ["-n", SCRIPT])).not.toThrow();
  });

  it("asks before anything else, and both answers are on screen one", () => {
    const r = run(["--dry-run"], { LARES_ASSUME_YES: "" });
    const firstScreen = r.stdout.split("\n").slice(0, 12).join("\n");
    expect(firstScreen).toMatch(/start fresh/i);
    expect(firstScreen).toMatch(/restore/i);
  });

  it("refuses a restore it cannot read, and never half-restores", () => {
    const r = run(["--restore", join(dir, "nope.tar"), "--yes"]);
    expect(r.code).toBe(78);
    expect(r.stderr).toMatch(/could not read/i);
    expect(readdirSync(prefix)).toEqual([]);
  });

  // Adapted from the plan's own snippet: the plan's archive was the bare string "not really a
  // tar", which only proves an unreadable-tar refusal (already covered above with a missing
  // file). The bar this slice was actually built to is stronger — manifest.json must be
  // present, parse, and match the archive's real files — so reaching "names the steps nobody
  // has rehearsed" needs a genuine archive, not a placeholder string.
  it("says plainly which two steps nobody has rehearsed", () => {
    const archive = join(dir, "export.tar");
    writeGenuineArchive(archive);
    const r = run(["--restore", archive, "--dry-run", "--yes"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/globals\.sql/);
    expect(r.stdout).toMatch(/bundle/);
    expect(r.stdout).toMatch(/not been rehearsed/i);
  });

  it("names the runbook rather than reprinting a procedure that could drift", () => {
    const archive = join(dir, "export.tar");
    writeGenuineArchive(archive);
    expect(run(["--restore", archive, "--dry-run", "--yes"]).stdout)
      .toContain("docs/runbooks/export-and-teardown.md");
  });

  it("reports what a genuine archive holds, as counts only — never contents", () => {
    const archive = join(dir, "export.tar");
    writeGenuineArchive(archive);
    const r = run(["--restore", archive, "--yes"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/2 database/i);
    expect(r.stdout).toMatch(/1 vault/i);
    expect(r.stdout).toMatch(/1 data directory/i);
    expect(r.stdout).toContain("2026.09.20-test");
    expect(r.stdout).toContain("2026-09-19T00:00:00Z");
    // Never the dump/bundle/tar bytes themselves.
    expect(r.stdout).not.toContain("FAKE-PG-CUSTOM-DUMP-BYTES-lares");
    expect(r.stdout).not.toContain("FAKE-GIT-BUNDLE-BYTES-brain");
    expect(r.stdout).not.toContain("FAKE-DATA-TAR-BYTES-lares");
  });

  it("refuses an archive whose contents do not match its own manifest, naming what's wrong", () => {
    const archive = join(dir, "tampered.tar");
    writeGenuineArchive(archive, (files) => {
      // Same LENGTH as the original, on purpose: this proves the checksum check catches a
      // tamper the size check alone would miss, not just that the two checks overlap.
      const dump = files.find((f) => f.name === "./lares.dump")!;
      expect(dump.content.length).toBe(31);
      dump.content = "TAMPERED-DUMP-BYTES-length-31!!";
      expect(dump.content.length).toBe(31);
    });
    const r = run(["--restore", archive, "--yes"]);
    expect(r.code).toBe(78);
    expect(r.stderr).toMatch(/lares\.dump/);
    expect(r.stderr).toMatch(/checksum/i);
    expect(readdirSync(prefix)).toEqual([]);
  });

  it("refuses an archive missing a file its own manifest lists", () => {
    const files = genuineExportFiles();
    const manifest = manifestFor(files); // manifest still names keeper.dump
    const withoutKeeper = files.filter((f) => f.name !== "./keeper.dump");
    const tar = makeTar([...withoutKeeper, { name: "./manifest.json", content: manifest }]);
    const archive = join(dir, "short.tar");
    writeFileSync(archive, tar);
    const r = run(["--restore", archive, "--yes"]);
    expect(r.code).toBe(78);
    expect(r.stderr).toMatch(/keeper\.dump/);
    expect(readdirSync(prefix)).toEqual([]);
  });

  it("refuses a hostile archive with a '..' path, before extracting a single byte", () => {
    const archive = join(dir, "hostile-dotdot.tar");
    writeFileSync(archive, makeTar([{ name: "../evil.txt", content: "gotcha" }]));
    const r = run(["--restore", archive, "--yes"]);
    expect(r.code).toBe(78);
    expect(r.stderr).toMatch(/\.\.\/evil\.txt/);
    expect(readdirSync(prefix)).toEqual([]);
    // Nowhere under this test's own temp tree did the hostile member land — proving the
    // refusal really happened before any extraction, not merely that the result was cleaned
    // up afterwards.
    expect(findAnywhere(dir, "evil.txt")).toBe(false);
  });

  it("refuses a hostile archive with an absolute path, before extracting a single byte", () => {
    const archive = join(dir, "hostile-absolute.tar");
    writeFileSync(archive, makeTar([{ name: "/etc/lares-evil", content: "gotcha" }]));
    const r = run(["--restore", archive, "--yes"]);
    expect(r.code).toBe(78);
    expect(r.stderr).toMatch(/\/etc\/lares-evil/);
    expect(readdirSync(prefix)).toEqual([]);
  });

  it("refuses an archive that holds a symbolic link — the classic way out of an extraction folder", () => {
    // `escape -> <a folder outside>` followed by `escape/evil.txt`: every NAME is innocent
    // (relative, no `..`), so only the member's TYPE can give it away.
    const outside = join(dir, "outside-the-check");
    const archive = join(dir, "hostile-symlink.tar");
    writeFileSync(archive, makeTar([
      { name: "escape", content: "", link: { type: "2", target: outside } },
      { name: "escape/evil.txt", content: "gotcha" },
    ]));
    const r = run(["--restore", archive, "--yes"]);
    expect(r.code).toBe(78);
    expect(r.stderr).toMatch(/not an ordinary file or folder/);
    expect(existsSync(join(outside, "evil.txt"))).toBe(false);
    expect(readdirSync(prefix)).toEqual([]);
  });

  it("refuses an archive that holds a hard link too", () => {
    const archive = join(dir, "hostile-hardlink.tar");
    writeFileSync(archive, makeTar([
      { name: "manifest.json", content: "{}" },
      { name: "alias", content: "", link: { type: "1", target: "manifest.json" } },
    ]));
    const r = run(["--restore", archive, "--yes"]);
    expect(r.code).toBe(78);
    expect(r.stderr).toMatch(/not an ordinary file or folder/);
  });

  it("does not hang with no terminal and neither --yes nor --restore — it refuses and says which flag to pass", () => {
    const r = run([]);
    expect(r.signal).toBeNull(); // not killed by the test's own timeout — it returned on its own
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/--yes/);
    expect(r.stderr).toMatch(/--restore/);
  });

  it("start fresh (--yes, no --restore) falls straight through into the installer, unchanged", () => {
    const r = run(["--dry-run", "--yes"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/found no existing installation/i);
    expect(readdirSync(prefix)).toEqual([]);
  });

  it("an existing installation is never offered screen one — it repairs, and says so", () => {
    mkdirSync(join(prefix, "srv", "lares"), { recursive: true });
    const r = run(["--dry-run", "--yes"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/repair/i);
    expect(r.stdout).not.toMatch(/start(ing)? fresh/i);
  });

  it("extraction for the check happens outside $PREFIX, and nothing is written into it", () => {
    const archive = join(dir, "export.tar");
    writeGenuineArchive(archive);
    run(["--restore", archive, "--yes"]);
    expect(readdirSync(prefix)).toEqual([]);
  });
});

/** True if a file with this exact basename exists anywhere under `root`. Used to prove a
 *  hostile archive's member never landed anywhere in this test's own temp tree, not only that
 *  $PREFIX (the only directory this test otherwise inspects) stayed empty. */
function findAnywhere(root: string, basename: string): boolean {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name === basename) return true;
    if (entry.isDirectory()) {
      if (findAnywhere(join(root, entry.name), basename)) return true;
    }
  }
  return false;
}
