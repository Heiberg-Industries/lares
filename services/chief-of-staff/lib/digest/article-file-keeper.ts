/**
 * Filing a saved web link as an `article` note and its text companion on an install with no Vault
 * folder: every read and write goes through keeper's `vault.scheduled` operation (the `digest` rule
 * in `@lares/agent-kit/scheduled-vault-policy`). The folder version is `article-file.ts`; the
 * naming, area choice, building and already-filed test are shared with it (`article.ts`).
 *
 * ORDER OF WRITES. Every keeper write is its own commit (pushed at once to the area's origin), so
 * the order is what keeps a crash from filing one link twice: first the text companion, then the
 * article note, then the inbox note is removed. A crash after the companion leaves a companion
 * only (the same bytes are `unchanged` next pass). A crash after the note leaves a filed article
 * plus the inbox note; the next pass finds the article (same link after `normaliseUrl`), makes no
 * model call, and only removes the inbox note.
 *
 * WHERE IT GOES. As in the folder version: the clip and the installation's setting choose the area;
 * a shared article needs the shared area to be usable, otherwise it is filed privately and the
 * result says so (`fellBack`). A private link is never widened. There is no push to hold back here:
 * keeper publishes each write itself.
 *
 * A text bigger than the keeper's body limit is refused before anything is sent, and the item is
 * reported as failed with the inbox note kept.
 */
import { normaliseUrl } from "../clipping/record.js";
import type { ScheduledVault } from "../scheduled-vault.js";
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
import type { ArticleFiled, FileArticleFn } from "./article-file.js";

/** The stem of an article already filed in this vault for the link, whatever its name was then. */
async function findFiledArticle(vault: ScheduledVault, urlKey: string): Promise<string | null> {
  const names = (await vault.list(`${ARTICLES_DIR}/`)).filter((p) => /^articles\/[^/]+\.md$/.test(p)).sort();
  for (const path of names) {
    const raw = await vault.read(path);
    if (raw !== undefined && filedLinkMatches(raw, urlKey)) return path.slice(ARTICLES_DIR.length + 1, -3);
  }
  return null;
}

export function makeKeeperArticleFiler(opts: {
  /** The private area: where the inbox is, and where a private article goes. */
  privateVault: ScheduledVault;
  /** The shared area, or undefined when this agent may not write there. */
  sharedVault: ScheduledVault | undefined;
  articleArea?: ArticleArea;
  /** Whether the agent's definition grants WRITE on the private area; without it nothing is filed. */
  mayWritePrivate: boolean;
  now?: () => Date;
}): FileArticleFn {
  const setting: ArticleArea = opts.articleArea ?? "shared";
  const nowFn = opts.now ?? (() => new Date());

  return async (input): Promise<ArticleFiled> => {
    const clip = parseInboxClip(input.inboxBody, input.article.url);
    const link = clip.url ?? input.article.url;
    const urlKey = normaliseUrl(link);
    if (urlKey === null) throw new Error("not a web link; nothing to file");
    if (!opts.mayWritePrivate) {
      throw new Error(
        "nothing filed: this agent's definition has no write grant on the private area, and filing an article " +
          "always writes there (the article itself, or taking the saved note out of the inbox). " +
          "The saved link stays in the inbox until the grant is given.",
      );
    }

    const wanted = chooseArea(clip, setting);
    let area: ArticleArea = "private";
    let vault = opts.privateVault;
    let existing: string | null = null;
    if (wanted === "shared" && opts.sharedVault) {
      try {
        // The first look at the shared area doubles as the test that it can be used at all.
        existing = await findFiledArticle(opts.sharedVault, urlKey);
        area = "shared";
        vault = opts.sharedVault;
      } catch {
        existing = null; // refused or unreachable: file privately, and say so
      }
    }
    const fellBack = wanted === "shared" && area === "private";
    if (area === "private") existing = await findFiledArticle(opts.privateVault, urlKey);

    const stem = articleBase({ readabilityTitle: input.article.title, clipTitle: clip.title, url: link });
    let base: string | undefined = existing ?? undefined;
    let duplicate = base !== undefined;
    for (const candidate of base !== undefined ? [] : [stem, suffixedBase(stem, urlKey)]) {
      const raw = await vault.read(`${ARTICLES_DIR}/${candidate}.md`);
      if (raw === undefined) { base = candidate; break; }
      if (filedLinkMatches(raw, urlKey)) { base = candidate; duplicate = true; break; }
    }
    if (base === undefined) throw new Error(`articles with different links already use the name ${stem}`);

    if (duplicate) {
      await opts.privateVault.remove(input.inboxPath);
      return { title: base, area, destPath: `${ARTICLES_DIR}/${base}.md`, duplicate: true, fellBack };
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
    // Companion first, then the note, then the inbox note: see the header.
    await vault.writeVerbatim(built.companionPath, built.companionText, built.message);
    await vault.writeVerbatim(built.notePath, built.noteRaw, built.message);
    await opts.privateVault.remove(input.inboxPath);
    return { title: built.title, area, destPath: built.notePath, duplicate: false, fellBack };
  };
}
