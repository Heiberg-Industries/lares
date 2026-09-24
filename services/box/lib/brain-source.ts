import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { join, resolve, relative, extname, basename, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { withNoteLock } from "./note-lock.js";

// ── BrainDeps interface (local — structurally compatible with agent-runtime) ─

export interface BrainDeps {
  search(q: string): Promise<string[]>;
  read(path: string): Promise<string>;
  backlinks(path: string): Promise<string[]>;
  list(): Promise<string[]>;
  commitNote(note: {
    path: string;
    frontmatter: Record<string, unknown>;
    body: string;
  }): Promise<{ commit: string }>;
  fileNote(opts: {
    destPath: string;
    sourcePath?: string;
    frontmatter: Record<string, unknown>;
    body: string;
    message: string;
  }): Promise<{ commit: string }>;
  /** Move an existing note to a new path AS-IS (git mv), preserving its bytes. */
  moveNote(opts: { sourcePath: string; destPath: string; message: string }): Promise<{ commit: string }>;
  /** Delete a note (git rm), committed + pushed so the removal is canonical + reversible. */
  removeNote(opts: { path: string; message: string }): Promise<{ commit: string }>;
  /** Write raw bytes to a vault path (no git commit — untracked attachment storage). */
  writeRaw(opts: { relPath: string; bytes: Buffer }): Promise<void>;
}

// ── Exclusions ───────────────────────────────────────────────────────────────

const EXCLUDED_DIRS = new Set([".git", ".locks", ".trash", ".obsidian", "node_modules"]);

// ── Recursive walk ───────────────────────────────────────────────────────────

function walkMd(dir: string, base: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (EXCLUDED_DIRS.has(entry.name)) continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkMd(abs, base));
    } else if (entry.isFile() && extname(entry.name) === ".md") {
      results.push(relative(base, abs));
    }
  }
  return results;
}

// ── YAML frontmatter serialiser (no external deps) ───────────────────────────

function serializeFrontmatter(fm: Record<string, unknown>): string {
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

// ── Factory ──────────────────────────────────────────────────────────────────

export function makeBrainDeps(vaultPath: string): BrainDeps {
  const absVault = resolve(vaultPath);

  function assertSafe(relPath: string): string {
    const abs = resolve(join(absVault, relPath));
    if (!abs.startsWith(absVault + "/") && abs !== absVault) {
      throw new Error(`Path traversal detected: ${relPath}`);
    }
    return abs;
  }

  return {
    async list() {
      return walkMd(absVault, absVault);
    },

    async read(path) {
      const abs = assertSafe(path);
      return readFileSync(abs, "utf8");
    },

    async search(q) {
      // Tokenized match (W4b): LLM callers send natural multi-word queries
      // ("Vol de Nuit positioning") — the old whole-string substring match
      // returned 0 hits unless the exact phrase appeared. Tokens are unicode
      // word chunks (æøå safe), <2 chars dropped. A file hits when ALL tokens
      // appear in its path or content; if nothing has all tokens, fall back to
      // ANY-token hits ranked by distinct-token count (capped at 20).
      const tokens = q.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 2);
      if (tokens.length === 0) return [];
      const files = walkMd(absVault, absVault);
      const scored = files.map((relPath) => {
        let haystack = relPath.toLowerCase();
        try {
          haystack += "\n" + readFileSync(join(absVault, relPath), "utf8").toLowerCase();
        } catch {
          // unreadable entry — score on path alone
        }
        return { relPath, n: tokens.filter((t) => haystack.includes(t)).length };
      });
      const all = scored.filter((s) => s.n === tokens.length).map((s) => s.relPath);
      if (all.length > 0) return all;
      return scored.filter((s) => s.n > 0).sort((a, b) => b.n - a.n).slice(0, 20).map((s) => s.relPath);
    },

    async backlinks(path) {
      // Match [[basename-without-.md]] (case-insensitive)
      const stem = basename(path, ".md");
      const pattern = new RegExp(`\\[\\[${stem}\\]\\]`, "i");
      const files = walkMd(absVault, absVault);
      return files.filter((relPath) => {
        if (relPath === path) return false; // exclude self
        try {
          const content = readFileSync(join(absVault, relPath), "utf8");
          return pattern.test(content);
        } catch {
          return false;
        }
      });
    },

    async commitNote({ path, frontmatter, body }) {
      return withNoteLock(absVault, path, async () => {
        const abs = assertSafe(path);
        mkdirSync(dirname(abs), { recursive: true });

        const fm = serializeFrontmatter(frontmatter);
        const fileContent = `${fm}\n\n${body}`;
        writeFileSync(abs, fileContent, "utf8");

        execFileSync("git", ["-C", absVault, "add", "--", path]);
        execFileSync("git", [
          "-C",
          absVault,
          "commit",
          "-q",
          "-m",
          `note(saga): ${path}`,
        ]);

        const hash = execFileSync("git", [
          "-C",
          absVault,
          "rev-parse",
          "--short",
          "HEAD",
        ])
          .toString()
          .trim();

        // Push to the canonical, backed-up bare remote so Saga's notes become
        // canonical + captured by backup. A push failure must not lose the
        // durable local commit — the nightly mirror reconciles, so warn only.
        try {
          execFileSync("git", ["-C", absVault, "push", "-q", "origin", "HEAD"]);
        } catch (err) {
          console.warn(`note(saga): push to bare failed (commit ${hash} is durable locally):`, err);
        }

        return { commit: hash };
      });
    },

    async fileNote({ destPath, sourcePath, frontmatter, body, message }) {
      return withNoteLock(absVault, destPath, async () => {
        const destAbs = assertSafe(destPath);
        mkdirSync(dirname(destAbs), { recursive: true });
        writeFileSync(destAbs, `${serializeFrontmatter(frontmatter)}\n\n${body}`, "utf8");
        execFileSync("git", ["-C", absVault, "add", "--", destPath]);
        if (sourcePath) {
          const srcAbs = assertSafe(sourcePath); // reject traversal
          // --ignore-unmatch: the source may be UNTRACKED (a clipper/sync drop written via
          // writeRaw, or a hand-dropped clip) — a plain `git rm` would fail "pathspec did not
          // match". For a tracked source this removes it from index+worktree; for an untracked
          // one it's a no-op, so we then unlink it from disk ourselves.
          execFileSync("git", ["-C", absVault, "rm", "-q", "--ignore-unmatch", "--", sourcePath]);
          if (existsSync(srcAbs)) rmSync(srcAbs);
        }
        execFileSync("git", ["-C", absVault, "commit", "-q", "-m", message]);
        const hash = execFileSync("git", ["-C", absVault, "rev-parse", "--short", "HEAD"]).toString().trim();
        try {
          execFileSync("git", ["-C", absVault, "push", "-q", "origin", "HEAD"]);
        } catch (err) {
          console.warn(`fileNote: push to bare failed (commit ${hash} is durable locally):`, err);
        }
        return { commit: hash };
      });
    },

    async moveNote({ sourcePath, destPath, message }) {
      return withNoteLock(absVault, destPath, async () => {
        const destAbs = assertSafe(destPath);
        assertSafe(sourcePath); // reject traversal on the source too
        mkdirSync(dirname(destAbs), { recursive: true });
        // git mv preserves the file's bytes (and its history) — a true move, not a rewrite.
        execFileSync("git", ["-C", absVault, "mv", "--", sourcePath, destPath]);
        execFileSync("git", ["-C", absVault, "commit", "-q", "-m", message]);
        const hash = execFileSync("git", ["-C", absVault, "rev-parse", "--short", "HEAD"]).toString().trim();
        try {
          execFileSync("git", ["-C", absVault, "push", "-q", "origin", "HEAD"]);
        } catch (err) {
          console.warn(`moveNote: push to bare failed (commit ${hash} is durable locally):`, err);
        }
        return { commit: hash };
      });
    },

    async removeNote({ path, message }) {
      return withNoteLock(absVault, path, async () => {
        assertSafe(path); // reject traversal
        execFileSync("git", ["-C", absVault, "rm", "-q", "--", path]);
        execFileSync("git", ["-C", absVault, "commit", "-q", "-m", message]);
        const hash = execFileSync("git", ["-C", absVault, "rev-parse", "--short", "HEAD"]).toString().trim();
        try {
          execFileSync("git", ["-C", absVault, "push", "-q", "origin", "HEAD"]);
        } catch (err) {
          console.warn(`removeNote: push to bare failed (commit ${hash} is durable locally):`, err);
        }
        return { commit: hash };
      });
    },

    async writeRaw({ relPath, bytes }) {
      if (relPath.includes("..")) {
        throw new Error(`Path traversal detected: ${relPath}`);
      }
      const abs = assertSafe(relPath);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, bytes);
    },
  };
}
