/**
 * The digest's `FileNoteFn` — write the destination note AND retire its `_inbox` source in ONE
 * git commit.
 *
 * Ported from `services/box/lib/brain-source.ts`'s `makeBrainDeps().fileNote` (:175-197).
 *
 * WHY THIS IS NOT `commitNote`. `lib/vault-git.ts`'s `commitNote` serves `vault_write`: it
 * hardcodes its commit message and knows nothing about a source note. Wiring the digest to it
 * would leave every filed clip sitting in `_inbox`, to be re-classified, re-filed and re-posted
 * on the next pass — a duplicate-filing loop that grows daily and reads, in the logs and in
 * Slack, exactly like the digest working. That failure mode is the reason this file exists
 * rather than a two-line reuse.
 *
 * WHY ONE COMMIT. Writing the destination and removing the source in separate commits leaves a
 * window in which the note exists in both places; a crash inside that window leaves it there
 * permanently, and the next pass files it again.
 *
 * ONE DELIBERATE DEPARTURE from brain-source.ts, authorised in the ORB-133 plan: a failed
 * `git push` THROWS (`VaultPushFailedError`) instead of warning and returning success. That
 * matches `lib/vault-git.ts`'s service-wide ORB-51 posture, and it composes correctly here —
 * `runDigest` catches per item, so the throw becomes one entry in `summary.errors`: the pass
 * continues, every other note still files, and the failure is REPORTED in the digest's error
 * thread reply instead of being swallowed. The local commit is durable either way.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { resolveInStore } from "@lares/agent-kit/notes-store";
import { withNoteLock } from "@lares/agent-kit/note-lock";
import { serializeFrontmatter, VaultPushFailedError } from "@lares/agent-kit/vault-git";
import type { FileNoteFn } from "./digest/filer.js";

export function makeDigestFileNote(vaultRoot: string): FileNoteFn {
  return async ({ destPath, sourcePath, frontmatter, body, message }) =>
    withNoteLock(vaultRoot, destPath, async () => {
      // Judge BOTH paths before anything touches the disk, so a bad source path cannot leave a
      // half-filed note behind. `resolveInStore` is the traversal- and symlink-safe check every
      // other vault path already goes through (ORB-52).
      const destAbs = resolveInStore(destPath, vaultRoot);
      const srcAbs = sourcePath ? resolveInStore(sourcePath, vaultRoot) : undefined;

      mkdirSync(dirname(destAbs), { recursive: true });
      writeFileSync(destAbs, `${serializeFrontmatter(frontmatter)}\n\n${body}`, "utf8");
      execFileSync("git", ["-C", vaultRoot, "add", "--", destPath]);

      if (sourcePath && srcAbs) {
        // --ignore-unmatch: the source is frequently UNTRACKED (a clipper or sync drop written
        // straight to disk), and a plain `git rm` would fail "pathspec did not match". For a
        // tracked source this stages the deletion; for an untracked one it is a NO-OP, which is
        // why the explicit unlink below is load-bearing rather than belt-and-braces.
        execFileSync("git", ["-C", vaultRoot, "rm", "-q", "--ignore-unmatch", "--", sourcePath]);
        if (existsSync(srcAbs)) rmSync(srcAbs);
      }

      // ONE commit: the new note and the retired source land together.
      execFileSync("git", ["-C", vaultRoot, "commit", "-q", "-m", message]);
      const commit = execFileSync("git", ["-C", vaultRoot, "rev-parse", "--short", "HEAD"])
        .toString()
        .trim();

      try {
        execFileSync("git", ["-C", vaultRoot, "push", "-q", "origin", "HEAD"]);
      } catch (err) {
        throw new VaultPushFailedError(commit, err);
      }

      return { commit };
    });
}
