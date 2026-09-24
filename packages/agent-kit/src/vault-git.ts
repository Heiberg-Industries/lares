import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { execFileSync } from "node:child_process";

import { resolveInStore } from "./notes-store.js";
import { withNoteLock } from "./note-lock.js";

/**
 * The git mechanics behind the vault write tools (`vault_write`, `vault_file`, `vault_drop`
 * — Task 9). Ported from `services/box/lib/brain-source.ts`'s `commitNote`,
 * `moveNote`, `removeNote` and `serializeFrontmatter` — same git invocations, same argument
 * shapes (`git add`, `git commit -q -m <msg>`, `git rev-parse --short HEAD`,
 * `git push -q origin HEAD`, `git mv`, `git rm -q`).
 *
 * Path safety reuses `lib/notes-store.ts`'s `resolveInStore` (the ORB-52 traversal- and
 * symlink-safe containment check already proven by every read tool) instead of
 * reimplementing `brain-source.ts`'s simpler prefix-only `assertSafe`.
 *
 * ONE DELIBERATE DEPARTURE from `brain-source.ts`: that file catches a `git push` failure,
 * `console.warn`s, and returns success anyway — reasoning "the nightly mirror reconciles".
 * eve-saga has no such backstop wired up yet, so a silent local-only commit would be a real
 * ORB-51 silent-failure gap: the vault would look updated to the caller while the bare
 * remote never got it. Here a push failure throws `VaultPushFailedError` instead, carrying
 * the local commit hash it durably made — the caller/model learns the commit exists, but
 * is not (yet) synced to the bare remote.
 */

export interface VaultWriteResult {
  commit: string;
}

/** A `git push` to the bare remote failed. The local commit is durable (see `.commit`) but
 *  has NOT reached `/srv/brain.git` — a silent local-only write here is exactly the
 *  ORB-51 silent-failure shape, so this is thrown rather than swallowed. */
export class VaultPushFailedError extends Error {
  constructor(readonly commit: string, cause: unknown) {
    super(
      `vault push to origin failed after local commit ${commit}: the commit is durable ` +
        `locally but has NOT reached the bare remote yet (ORB-51 — a vault that looks ` +
        `updated locally while the bare never got it is the silent-failure shape this ` +
        `refuses to produce).`,
      { cause },
    );
    this.name = "VaultPushFailedError";
  }
}

// ── YAML frontmatter serialiser (no external deps) — ported verbatim from brain-source.ts ──

export function serializeFrontmatter(fm: Record<string, unknown>): string {
  const lines: string[] = ["---"];
  for (const [key, value] of Object.entries(fm)) {
    if (value === null || value === undefined) {
      lines.push(`${key}:`);
    } else if (Array.isArray(value)) {
      lines.push(`${key}: [${value.join(", ")}]`);
    } else {
      lines.push(`${key}: ${value}`);
    }
  }
  lines.push("---");
  return lines.join("\n");
}

function gitShortHead(vaultRoot: string): string {
  return execFileSync("git", ["-C", vaultRoot, "rev-parse", "--short", "HEAD"]).toString().trim();
}

/** Push HEAD to origin, or throw `VaultPushFailedError` carrying the local commit hash. */
function gitPushOrThrow(vaultRoot: string, commit: string): void {
  try {
    execFileSync("git", ["-C", vaultRoot, "push", "-q", "origin", "HEAD"]);
  } catch (err) {
    throw new VaultPushFailedError(commit, err);
  }
}

/** Create (or overwrite) a note with serialised frontmatter + body, commit, push. Used by
 *  `vault_write` for the `_inbox/<slug>.md` convention.
 *
 *  `message` is optional and defaults to the role-neutral `note: <path>` wording — no persona
 *  name, because the engine ships with none (this repo's own rule). It exists because the kit
 *  is shared by more than one agent (ORB-142): a role's own write tool, or a scheduled job
 *  like the dream cycle's, can pass its own message, and the vault's git log is the only audit
 *  trail those writes have. */
export async function commitNote(opts: {
  vaultRoot: string;
  path: string;
  frontmatter: Record<string, unknown>;
  body: string;
  message?: string;
}): Promise<VaultWriteResult> {
  const { vaultRoot, path, frontmatter, body } = opts;
  return withNoteLock(vaultRoot, path, async () => {
    const abs = resolveInStore(path, vaultRoot); // throws NotePathEscapesStoreError first
    mkdirSync(dirname(abs), { recursive: true });

    const content = `${serializeFrontmatter(frontmatter)}\n\n${body}`;
    writeFileSync(abs, content, "utf8");

    execFileSync("git", ["-C", vaultRoot, "add", "--", path]);
    execFileSync("git", ["-C", vaultRoot, "commit", "-q", "-m", opts.message ?? `note: ${path}`]);
    const commit = gitShortHead(vaultRoot);
    gitPushOrThrow(vaultRoot, commit);
    return { commit };
  });
}

/** Move an existing note to a new path AS-IS via `git mv`, preserving its bytes and history
 *  (`git log --follow`). Used by `vault_file`. */
export async function moveNote(opts: {
  vaultRoot: string;
  sourcePath: string;
  destPath: string;
  message: string;
}): Promise<VaultWriteResult> {
  const { vaultRoot, sourcePath, destPath, message } = opts;
  return withNoteLock(vaultRoot, destPath, async () => {
    const destAbs = resolveInStore(destPath, vaultRoot);
    resolveInStore(sourcePath, vaultRoot); // reject traversal on the source too, before any git call

    mkdirSync(dirname(destAbs), { recursive: true });
    // git mv preserves the file's bytes (and its history) — a true move, not a rewrite.
    execFileSync("git", ["-C", vaultRoot, "mv", "--", sourcePath, destPath]);
    execFileSync("git", ["-C", vaultRoot, "commit", "-q", "-m", message]);
    const commit = gitShortHead(vaultRoot);
    gitPushOrThrow(vaultRoot, commit);
    return { commit };
  });
}

/** Delete a note (`git rm`), committed + pushed so the removal is canonical + reversible via
 *  git history. Used by `vault_drop`. */
export async function removeNote(opts: {
  vaultRoot: string;
  path: string;
  message: string;
}): Promise<VaultWriteResult> {
  const { vaultRoot, path, message } = opts;
  return withNoteLock(vaultRoot, path, async () => {
    resolveInStore(path, vaultRoot); // reject traversal, before any git call

    execFileSync("git", ["-C", vaultRoot, "rm", "-q", "--", path]);
    execFileSync("git", ["-C", vaultRoot, "commit", "-q", "-m", message]);
    const commit = gitShortHead(vaultRoot);
    gitPushOrThrow(vaultRoot, commit);
    return { commit };
  });
}
