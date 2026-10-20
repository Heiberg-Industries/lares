// What get-lares.sh promises, read from its own text (the same way install-contract.test.ts holds
// install.sh to its promises). The download lives in this file and nowhere else: install.sh stays
// free of it.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const OPS = join(dirname(fileURLToPath(import.meta.url)), "..", "ops");
const src = readFileSync(join(OPS, "get-lares.sh"), "utf8");
const wrapper = readFileSync(join(OPS, "lares"), "utf8");
const lines = src.split("\n");
const stripComments = (text: string) => text.split("\n").filter((l) => !l.trimStart().startsWith("#")).join("\n");
const code = stripComments(src);
const wrapperCode = stripComments(wrapper);

describe("what the bootstrap promises", () => {
  // Each host is named in the script's own header with a reason; this list and that header must agree.
  const ALLOWED_HOSTS = ["raw.githubusercontent.com", "ghcr.io"];

  it("reaches exactly two hosts, each with its reason written in the script header", () => {
    // ghcr.io is a registry, named without a scheme: the only registry the digest rule accepts.
    const hosts = [...new Set([
      ...[...src.matchAll(/https?:\/\/([a-z0-9.-]+)/g)].map((m) => m[1]!),
      ...[...code.matchAll(/\b(ghcr\.io)\//g)].map((m) => m[1]!),
    ])].sort();
    expect(hosts).toEqual([...ALLOWED_HOSTS].sort());
    const header = lines.slice(0, 80).join("\n");
    for (const h of ALLOWED_HOSTS) {
      expect(header, h).toMatch(new RegExp(`^#\\s+${h.replace(/\./g, "\\.")}\\s+-\\s+\\S.{15,}`, "m"));
    }
  });

  it("pulls only an image named by digest, and checks the digest's shape first", () => {
    expect(code).toMatch(/docker pull "\$ENGINE_IMAGE"/);
    expect(code).not.toMatch(/docker pull(?! "\$ENGINE_IMAGE")/);
    expect(code).toMatch(/@sha256:\[a-f0-9\]\{64\}/);
    for (const m of src.matchAll(/ghcr\.io\/[a-z0-9./_-]+(@sha256:[a-f0-9]{64}|:[A-Za-z0-9._-]+)?/g)) {
      if (m[1]) expect(m[1], m[0]).toMatch(/^@sha256:/);
    }
  });

  it("refuses when not root", () => {
    expect(code).toMatch(/id -u/);
    expect(src).toMatch(/needs to run as root/);
    expect(src).toMatch(/EX_NOTROOT=77/);
  });

  it("collects every preflight problem and reports them together", () => {
    expect(code).toMatch(/problem\(\)/);
    expect((code.match(/\bproblem "/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(code.match(/PROBLEMS/g)!.length).toBeGreaterThan(2);
  });

  it("pipes nothing into a shell and evaluates nothing it downloaded", () => {
    for (const text of [code, wrapperCode]) {
      expect(text).not.toMatch(/\|\s*(sudo\s+)?(ba|z|da)?sh\b/);
      expect(text).not.toMatch(/\beval\b/);
      expect(text).not.toMatch(/(^|\s)(source|\.)\s+[^\n]*(WORK|release\.json)/);
      expect(text).not.toMatch(/\bwget\b/);
    }
  });

  it("never builds or installs dependencies, and never touches a secret", () => {
    expect(code).not.toMatch(/docker build|pnpm install|npm install|eve build/);
    expect(code).not.toMatch(/KEY|PASSWORD|TOKEN/);
  });

  it("names an undo beside every removal", () => {
    const rm = lines.map((l, i) => ({ l, i })).filter(({ l }) => /\brm -rf\b/.test(l) && !l.trimStart().startsWith("#"));
    const bad = rm.filter(({ i }) => !/^\s*#\s*undo:/.test(lines[i - 1] ?? ""));
    expect(bad.map(({ l }) => l.trim())).toEqual([]);
  });

  it("says in its header that it never phones home, and keeps to image mode", () => {
    expect(src.slice(0, 4000)).toMatch(/phones? home/i);
    expect(code).not.toMatch(/pnpm|\bnode\b/);
    expect(wrapperCode).not.toMatch(/pnpm|\bnode\b/);
  });

  it("keeps the download out of install.sh", () => {
    const install = readFileSync(join(OPS, "install.sh"), "utf8");
    expect(install).not.toMatch(/raw\.githubusercontent\.com/);
  });
});
