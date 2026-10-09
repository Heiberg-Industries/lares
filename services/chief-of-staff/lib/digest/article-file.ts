/**
 * Writing a saved web link into the vault as an `article` note and its text companion.
 *
 * WHERE IT GOES. The inbox note says whose link it is and the installation's article area setting
 * says where articles go (`article.ts` `chooseArea`): a link bound for the shared area goes to
 * `articles/` there, anything else to `articles/` in the private one. A shared link is never held
 * back by an unusable shared area, and a private link is never widened: when the shared area
 * cannot be used (not configured, not a repository, not writable, or the caller passed no root
 * because the filing agent has no write grant there) the note is filed privately instead and the
 * result says so (`fellBack`), so the pass can tell the owner. Under the `private` setting
 * nothing is bound for the shared area, so nothing is reported.
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
import { accessSync, constants, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
   * caller can count calls by counting invocations. It is told which area the article is going
   * to, so the caller can keep private note names away from a shared article.
   */
  classify: (ctx: { area: ArticleArea }) => Promise<ArticleClassification>;
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
  /**
   * A push failed AFTER the article was committed and the inbox note was already gone. The result
   * is still good (the article is in the vault, at `destPath`); the caller must record where it
   * went and also report this, because the commit is not yet on the remote.
   */
  pushFailure?: VaultPushFailedError;
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

/** Whether the repository tracks this path. */
function isTracked(root: string, path: string): boolean {
  try {
    gitIn(root, "ls-files", "--error-unmatch", "--", path);
    return true;
  } catch {
    return false;
  }
}

/**
 * The file-name stem of an article in `root` that was filed for this link, whatever it was called
 * when it was filed (a page title can change between passes), or null.
 */
function findFiledArticle(root: string, urlKey: string): string | null {
  let names: string[];
  try {
    names = readdirSync(resolveInStore(ARTICLES_DIR, root)).filter((n) => n.endsWith(".md")).sort();
  } catch {
    return null; // no articles folder yet
  }
  for (const name of names) {
    try {
      if (filedLinkMatches(readFileSync(resolveInStore(`${ARTICLES_DIR}/${name}`, root), "utf8"), urlKey)) {
        return name.slice(0, -3);
      }
    } catch {
      /* unreadable: not a match */
    }
  }
  return null;
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
 * (`message`), scoped to that one path so nothing anybody else staged rides along; a note that was
 * never committed (a clipper drop) is just deleted and there is nothing to commit. A failed push
 * is RETURNED, not thrown: by then the inbox note is gone and the caller must still learn that.
 */
async function retireInbox(
  privateRoot: string,
  inboxPath: string,
  message: string,
): Promise<VaultPushFailedError | undefined> {
  return withNoteLock(privateRoot, inboxPath, async () => {
    const abs = resolveInStore(inboxPath, privateRoot);
    gitIn(privateRoot, "rm", "-q", "--ignore-unmatch", "--", inboxPath);
    if (existsSync(abs)) rmSync(abs);
    if (!hasStaged(privateRoot, inboxPath)) return undefined;
    gitIn(privateRoot, "commit", "-q", "-m", message, "--", inboxPath);
    try {
      pushOrThrow(privateRoot, shortHead(privateRoot));
    } catch (err) {
      if (err instanceof VaultPushFailedError) return err;
      throw err;
    }
    return undefined;
  });
}

export function makeArticleFiler(opts: {
  privateRoot: string;
  /** The shared area's root, or a function that answers it; undefined when not connected. */
  sharedRoot: string | undefined | (() => string | undefined);
  /**
   * The installation's article area setting (`article-area.ts`). Default `shared`, the engine's
   * default. `private` files every article privately and is never reported as a fall-back.
   */
  articleArea?: ArticleArea;
  now?: () => Date;
}): FileArticleFn {
  const sharedRootNow = (): string | undefined =>
    typeof opts.sharedRoot === "function" ? opts.sharedRoot() : opts.sharedRoot;
  const setting: ArticleArea = opts.articleArea ?? "shared";
  const nowFn = opts.now ?? (() => new Date());

  return async (input) => {
    const clip = parseInboxClip(input.inboxBody);
    const link = clip.url ?? input.article.url;
    const urlKey = normaliseUrl(link);
    if (urlKey === null) throw new Error("not a web link; nothing to file");

    const wanted = chooseArea(clip, setting);
    const shared = wanted === "shared" ? sharedRootNow() : undefined;
    const area: ArticleArea = wanted === "shared" && usable(shared) ? "shared" : "private";
    const fellBack = wanted === "shared" && area === "private";
    const root = area === "shared" ? shared! : opts.privateRoot;

    // Which name is free, or already holds this very link.
    const stem = articleBase({ readabilityTitle: input.article.title, clipTitle: clip.title, url: link });
    // First: was this link filed already, under whatever name it had then?
    let base: string | undefined = findFiledArticle(root, urlKey) ?? undefined;
    let duplicate = base !== undefined;
    for (const candidate of base !== undefined ? [] : [stem, suffixedBase(stem, urlKey)]) {
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

    const retireMessage = `digest: retire inbox note for article ${base}`;
    const destPath = `${ARTICLES_DIR}/${base}.md`;

    if (duplicate) {
      // A shared commit made earlier may never have reached the remote (a failed push); try again
      // now, so retiring the inbox note below never strands it. This one THROWS: the inbox note
      // is still there, so the item stays in the inbox and is retried next pass.
      if (area === "shared") {
        await withNoteLock(root, destPath, async () => {
          pushOrThrow(root, shortHead(root));
        });
      }
      const pushFailure = await retireInbox(opts.privateRoot, input.inboxPath, retireMessage);
      return { title: base, area, destPath, duplicate: true, fellBack, ...(pushFailure ? { pushFailure } : {}) };
    }

    const classification = await input.classify({ area });
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
          // Scoped to the article's own files: the shared store has several writers, and a plain
          // commit would take in whatever any of them had staged.
          gitIn(root, "commit", "-q", "-m", built.message, "--", ...paths);
        } catch (err) {
          undoWrites(root, paths);
          throw err;
        }
        // Throws: the inbox note is still there, so the next pass finds the article and retries.
        pushOrThrow(root, shortHead(root));
      });
      const pushFailure = await retireInbox(opts.privateRoot, input.inboxPath, retireMessage);
      return {
        title: built.title, area, destPath: built.notePath, duplicate: false, fellBack,
        ...(pushFailure ? { pushFailure } : {}),
      };
    }

    const pushFailure = await withNoteLock(root, built.notePath, async () => {
      const sourceAbs = resolveInStore(input.inboxPath, root);
      const tracked = isTracked(root, input.inboxPath);
      writeFiles(root, files);
      // True only once `git rm` has actually removed the inbox note: if it refused (unsaved edits)
      // or never ran, the file on disk is untouched and must not be "restored" over.
      let removed = false;
      try {
        gitIn(root, "add", "--", ...paths);
        // A tracked inbox note is removed in this same commit; one that was never committed (a
        // clipper drop) is deleted after it. The commit is scoped to these paths only.
        if (tracked) {
          gitIn(root, "rm", "-q", "--", input.inboxPath);
          removed = true;
        }
        gitIn(root, "commit", "-q", "-m", built.message, "--", ...paths, ...(tracked ? [input.inboxPath] : []));
      } catch (err) {
        undoWrites(root, paths);
        if (removed) {
          try {
            // The removal is staged and the file is gone; put both back.
            gitIn(root, "reset", "-q", "HEAD", "--", input.inboxPath);
            gitIn(root, "checkout", "-q", "HEAD", "--", input.inboxPath);
          } catch {
            /* nothing more can be done here; the original error is what matters */
          }
        }
        throw err;
      }
      if (existsSync(sourceAbs)) rmSync(sourceAbs);
      try {
        pushOrThrow(root, shortHead(root));
      } catch (err) {
        // The inbox note is already gone: hand the failure back with the result.
        if (err instanceof VaultPushFailedError) return err;
        throw err;
      }
      return undefined;
    });
    return {
      title: built.title, area, destPath: built.notePath, duplicate: false, fellBack,
      ...(pushFailure ? { pushFailure } : {}),
    };
  };
}
