import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import vaultWrite from "../extension/tools/vault_write.js";
import vaultFile from "../extension/tools/vault_file.js";
import vaultDrop from "../extension/tools/vault_drop.js";
import { UnauthorizedApproverError } from "../extension/lib/approval-gate.js";

/**
 * Final-wave fix (whole-branch review of ORB-143): `tests/approval-gate.test.ts` covers
 * `makeApprovalGate`'s logic in isolation (a fake resolver, no eve involved), and
 * `tests/vault-git.test.ts` covers `commitNote`/`moveNote`/`removeNote`'s git mechanics in
 * isolation (no approval check involved). Neither ever calls `vault_write.execute()` /
 * `vault_file.execute()` / `vault_drop.execute()` themselves, so nothing previously failed
 * if the `assertApprover(...)` line were deleted from any of the three tool files.
 *
 * This file closes that gap by importing the three tool modules directly — the same way this
 * file itself is imported by vitest, NOT through eve's compiled-agent loader — and proves two
 * things per tool: (1) the call is refused with `UnauthorizedApproverError`, and (2) no git
 * write happens as a result (checked against a REAL fixture repo, `vault-git.test.ts`'s
 * pattern of a working clone + bare "origin").
 *
 * WHY this refuses even for an auth shape that would be approved in production: eve's
 * `defineExtension` binds mount-site config into a `globalThis`-scoped registry only when the
 * *mount factory* runs inside eve's own loader (see `node_modules/eve/dist/.../
 * definitions/extension.js`: the `config` getter is
 * `(scope === undefined ? undefined : registry.get(scope)) ?? validateConfig(schema, {})`).
 * A plain `import` — what this test file and any other non-eve test harness does — never
 * calls that mount factory, so the registry lookup is always empty and `config` falls back to
 * validating `{}` against the schema. Because `brain` is `.optional()` on
 * `extension/extension.ts`'s schema, that fallback validates cleanly to `{ brain: undefined }`,
 * so `extension.config.brain?.isApprovedPrincipal` is `undefined` — which
 * `extension/lib/approval-gate.ts`'s `makeApprovalGate` resolver treats as "no principal is
 * approved" (fail-closed), exactly like `approval-gate.test.ts`'s "resolver itself resolves to
 * undefined" case. Verified by reading both files before writing this test, not assumed.
 */

const OWNER = "U-fixture-owner";

function slackAuth(userId: string) {
  return { attributes: { user_id: userId, channel_id: "D123", thread_ts: "1.0" }, authenticator: "slack-webhook" };
}

/** Mirrors `services/chief-of-staff/tests/brain-writes.test.ts` (pre-ORB-143-Task-2)'s `ctx()` — a
 *  minimal fake `ToolContext`; only `session.auth` is read before the gate throws. */
function ctx(auth: unknown) {
  return { session: { id: "wrun_test", auth: { current: auth, initiator: auth } } } as never;
}

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
}

function commitCount(dir: string): number {
  return git(dir, "log", "--oneline").trim().split("\n").filter(Boolean).length;
}

function seedNote(workDir: string, relPath: string, content: string): void {
  const abs = join(workDir, relPath);
  execFileSync("mkdir", ["-p", join(abs, "..")]);
  writeFileSync(abs, content, "utf8");
  git(workDir, "add", "--", relPath);
  git(workDir, "commit", "-q", "-m", `seed ${relPath}`);
  git(workDir, "push", "-q", "origin", "HEAD");
}

let tmp: string;
let bareDir: string;
let workDir: string;
let previousVaultPath: string | undefined;

beforeEach(() => {
  previousVaultPath = process.env["VAULT_PATH"];
  tmp = mkdtempSync(join(tmpdir(), "agent-kit-vault-write-gate-"));
  bareDir = join(tmp, "brain.git");
  workDir = join(tmp, "brain");

  execFileSync("git", ["init", "--quiet", "--bare", bareDir]);
  execFileSync("git", ["clone", "--quiet", bareDir, workDir]);
  git(workDir, "config", "user.email", "test-suite@example.com");
  git(workDir, "config", "user.name", "Test Suite");

  // Seed an initial commit so the branch exists (a brand-new bare repo has no ref yet).
  writeFileSync(join(workDir, ".gitkeep"), "");
  git(workDir, "add", "--", ".gitkeep");
  git(workDir, "commit", "-q", "-m", "seed");
  git(workDir, "push", "-q", "origin", "HEAD");

  // Set even though the gate is expected to throw before `storeRootForArea("private")` is ever
  // called — belt and braces: if the gate regresses and lets the call through, this makes
  // sure the write lands in the disposable fixture repo, not wherever the ambient
  // environment happens to point VAULT_PATH.
  process.env["VAULT_PATH"] = workDir;
});

afterEach(() => {
  if (previousVaultPath === undefined) delete process.env["VAULT_PATH"];
  else process.env["VAULT_PATH"] = previousVaultPath;
  rmSync(tmp, { recursive: true, force: true });
});

describe("vault_write.execute() called directly (extension config never bound)", () => {
  it("throws UnauthorizedApproverError and performs no git write", async () => {
    const before = commitCount(bareDir);
    await expect(
      vaultWrite.execute({ area: "private", title: "Should Not Land", body: "x" }, ctx(slackAuth(OWNER))),
    ).rejects.toThrow(UnauthorizedApproverError);
    expect(commitCount(bareDir)).toBe(before);
    expect(existsSync(join(workDir, "_inbox"))).toBe(false);
  });
});

describe("vault_file.execute() called directly (extension config never bound)", () => {
  it("throws UnauthorizedApproverError and performs no git write", async () => {
    seedNote(workDir, "_inbox/existing.md", "---\ntitle: Existing\n---\n\nBody.");
    const before = commitCount(bareDir);
    await expect(
      vaultFile.execute({ area: "private", path: "_inbox/existing.md", destination: "writing-seeds" }, ctx(slackAuth(OWNER))),
    ).rejects.toThrow(UnauthorizedApproverError);
    expect(commitCount(bareDir)).toBe(before);
    expect(existsSync(join(workDir, "_inbox/existing.md"))).toBe(true);
    expect(existsSync(join(workDir, "writing-seeds/existing.md"))).toBe(false);
  });
});

describe("vault_drop.execute() called directly (extension config never bound)", () => {
  it("throws UnauthorizedApproverError and performs no git write", async () => {
    seedNote(workDir, "_inbox/existing.md", "---\ntitle: Existing\n---\n\nBody.");
    const before = commitCount(bareDir);
    await expect(vaultDrop.execute({ area: "private", path: "_inbox/existing.md" }, ctx(slackAuth(OWNER)))).rejects.toThrow(
      UnauthorizedApproverError,
    );
    expect(commitCount(bareDir)).toBe(before);
    expect(existsSync(join(workDir, "_inbox/existing.md"))).toBe(true);
  });
});
