/**
 * Writing a saved web link into the vault as an `article` note and its text companion.
 *
 * WHERE IT GOES. The inbox note says whose link it is (`article.ts` `chooseArea`): a shared link
 * goes to `articles/` in the shared area, anything else to `articles/` in the private one. A
 * shared link is never held back by an unusable shared area, and a private link is never widened:
 * when the shared area cannot be used (not configured, not a repository, not writable) the note is
 * filed privately instead and the result says so (`fellBack`), so the pass can tell the owner.
 *
 * COMMITS. Private: the note, its text and the removal of the inbox note are ONE commit, as
 * `lib/digest-file.ts` does for ordinary notes. Shared: the note and its text are one commit in the
 * shared repository, pushed; then a second commit in the private repository retires the inbox
 * note. The two cannot be one commit (they are two repositories), so the order matters: the shared
 * write comes first, and a crash between the two leaves a filed article plus an inbox note that
 * the next pass recognises (same link, already filed), files nothing again, and retires. A failed
 * push throws `VaultPushFailedError`, like every other vault write: the local commit is durable,
 * the item is reported, and it is retried next pass.
 *
 * ALREADY FILED. The file name comes from the page title. If `articles/<name>.md` exists for the
 * same link (compared after `normaliseUrl`) nothing is written and no model call is made; the
 * inbox note is simply retired. A different link with the same title gets the first six hex
 * characters of its hash as a suffix.
 */
import { execFileSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { resolveInStore, storeRootForArea } from "@lares/agent-kit/notes-store";
import { withNoteLock } from "@lares/agent-kit/note-lock";
import { VaultPushFailedError } from "@lares/agent-kit/vault-git";

import { normaliseUrl } from "../clipping/record.js";
import {
  ARTICLES_DIR,
  articleBase,
  buildArticle,
  chooseArea,
  filedLinkMatches,
  parseInboxClip,
  suffixedBase,
  type ArticleArea,
} from "./article.js";
import type { ArticleClassification } from "./classifier.js";
import type { FetchedArticle } from "./enrich.js";

export interface ArticleFileInput {
  /** The inbox note's vault-relative path in the private store. */
  inboxPath: string;
  /** The inbox note exactly as saved. */
  inboxBody: string;
  article: FetchedArticle;
  /**
   * Asks the model. Called at most once, and not at all for a link that is already filed, so the
   * caller can count calls by counting invocations.
   */
  classify: () => Promise<ArticleClassification>;
  /** The pass date, for notes whose inbox note has no usable `saved:`. */
  today: string;
}

export interface ArticleFiled {
  title: string;
  /** Where the article actually went (after any fall-back). */
  area: ArticleArea;
  /** The note's path inside that area's store. */
  destPath: string;
  /** The link was already filed: nothing was written, only the inbox note was retired. */
  duplicate: boolean;
  /** The link belonged in the shared area but that area could not be used. */
  fellBack: boolean;
}

export type FileArticleFn = (input: ArticleFileInput) => Promise<ArticleFiled>;

/** The shared area's root, or undefined when it is not configured. Never throws. */
export function resolveSharedRoot(env: NodeJS.ProcessEnv = process.env): string | undefined {
  try {
    return storeRootForArea("shared", env);
  } catch {
    return undefined;
  }
}

/** A repository we can write into. */
function usable(root: string | undefined): root is string {
  if (!root) return false;
  try {
    if (!statSync(root).isDirectory()) return false;
    if (!existsSync(join(root, ".git"))) return false;
    accessSync(root, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function gitIn(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function shortHead(root: string): string {
  return gitIn(root, "rev-parse", "--short", "HEAD").trim();
}

function pushOrThrow(root: string, commit: string): void {
  try {
    gitIn(root, "push", "-q", "origin", "HEAD");
  } catch (err) {
    throw new VaultPushFailedError(commit, err);
  }
}

/** Whether the index holds a change for this path. */
function hasStaged(root: string, path: string): boolean {
  try {
    gitIn(root, "diff", "--cached", "--quiet", "--", path);
    return false;
  } catch {
    return true;
  }
}

/** Write the note and its text, undoing the writes if anything before the commit fails. */
function writeFiles(root: string, files: Array<{ path: string; text: string }>): void {
  const written: string[] = [];
  try {
    for (const f of files) {
      const abs = resolveInStore(f.path, root);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, f.text, "utf8");
      written.push(f.path);
    }
  } catch (err) {
    for (const p of written) rmSync(resolveInStore(p, root), { force: true });
    throw err;
  }
}

function undoWrites(root: string, paths: string[]): void {
  try {
    gitIn(root, "reset", "-q", "--", ...paths);
  } catch {
    /* nothing staged */
  }
  for (const p of paths) rmSync(resolveInStore(p, root), { force: true });
}

/**
 * Take the inbox note out of the private store. A tracked note is removed in a commit of its own
 * (`message`); a note that was never committed (a clipper drop) is just deleted and there is
 * nothing to commit.
 */
async function retireInbox(privateRoot: string, inboxPath: string, message: string): Promise<void> {
  await withNoteLock(privateRoot, inboxPath, async () => {
    const abs = resolveInStore(inboxPath, privateRoot);
    gitIn(privateRoot, "rm", "-q", "--ignore-unmatch", "--", inboxPath);
    if (existsSync(abs)) rmSync(abs);
    if (!hasStaged(privateRoot, inboxPath)) return;
    gitIn(privateRoot, "commit", "-q", "-m", message);
    pushOrThrow(privateRoot, shortHead(privateRoot));
  });
}

export function makeArticleFiler(opts: {
  privateRoot: string;
  /** The shared area's root, or a function that answers it; undefined when not connected. */
  sharedRoot: string | undefined | (() => string | undefined);
  now?: () => Date;
}): FileArticleFn {
  const sharedRootNow = (): string | undefined =>
    typeof opts.sharedRoot === "function" ? opts.sharedRoot() : opts.sharedRoot;
  const nowFn = opts.now ?? (() => new Date());

  return async (input) => {
    const clip = parseInboxClip(input.inboxBody);
    const link = clip.url ?? input.article.url;
    const urlKey = normaliseUrl(link);
    if (urlKey === null) throw new Error("not a web link; nothing to file");

    const wanted = chooseArea(clip);
    const shared = wanted === "shared" ? sharedRootNow() : undefined;
    const area: ArticleArea = wanted === "shared" && usable(shared) ? "shared" : "private";
    const fellBack = wanted === "shared" && area === "private";
    const root = area === "shared" ? shared! : opts.privateRoot;

    // Which name is free, or already holds this very link.
    const stem = articleBase({ readabilityTitle: input.article.title, clipTitle: clip.title, url: link });
    let base: string | undefined;
    let duplicate = false;
    for (const candidate of [stem, suffixedBase(stem, urlKey)]) {
      const abs = resolveInStore(`${ARTICLES_DIR}/${candidate}.md`, root);
      if (!existsSync(abs)) {
        base = candidate;
        break;
      }
      if (filedLinkMatches(readFileSync(abs, "utf8"), urlKey)) {
        base = candidate;
        duplicate = true;
        break;
      }
    }
    if (base === undefined) throw new Error(`articles with different links already use the name ${stem}`);

    const message = `digest: file article ${base} → ${ARTICLES_DIR}`;
    const destPath = `${ARTICLES_DIR}/${base}.md`;

    if (duplicate) {
      // A shared commit made earlier may never have reached the remote (a failed push); try again
      // now, so retiring the inbox note below never strands it.
      if (area === "shared") {
        await withNoteLock(root, destPath, async () => {
          pushOrThrow(root, shortHead(root));
        });
      }
      await retireInbox(opts.privateRoot, input.inboxPath, message);
      return { title: base, area, destPath, duplicate: true, fellBack };
    }

    const classification = await input.classify();
    const built = buildArticle({
      inboxBody: input.inboxBody,
      article: input.article,
      classification,
      area,
      base,
      now: nowFn(),
      today: input.today,
    });
    const files = [
      { path: built.notePath, text: built.noteRaw },
      { path: built.companionPath, text: built.companionText },
    ];
    const paths = files.map((f) => f.path);

    if (area === "shared") {
      await withNoteLock(root, built.notePath, async () => {
        writeFiles(root, files);
        try {
          gitIn(root, "add", "--", ...paths);
          gitIn(root, "commit", "-q", "-m", built.message);
        } catch (err) {
          undoWrites(root, paths);
          throw err;
        }
        pushOrThrow(root, shortHead(root));
      });
      await retireInbox(opts.privateRoot, input.inboxPath, built.message);
      return { title: built.title, area, destPath: built.notePath, duplicate: false, fellBack };
    }

    await withNoteLock(root, built.notePath, async () => {
      const sourceAbs = resolveInStore(input.inboxPath, root);
      writeFiles(root, files);
      try {
        gitIn(root, "add", "--", ...paths);
        // --ignore-unmatch: an inbox note straight from a clipper is untracked; the unlink after
        // the commit is what removes it then.
        gitIn(root, "rm", "-q", "--ignore-unmatch", "--", input.inboxPath);
        gitIn(root, "commit", "-q", "-m", built.message);
      } catch (err) {
        undoWrites(root, paths);
        try {
          gitIn(root, "checkout", "-q", "--", input.inboxPath);
        } catch {
          /* never tracked, or untouched */
        }
        throw err;
      }
      if (existsSync(sourceAbs)) rmSync(sourceAbs);
      pushOrThrow(root, shortHead(root));
    });
    return { title: built.title, area, destPath: built.notePath, duplicate: false, fellBack };
  };
}
