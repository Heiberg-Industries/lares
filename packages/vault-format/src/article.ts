// Article notes (the `articles/` folder): the vocabulary and the one path rule that move, delete
// and erase share. Self-contained on purpose — NO relative imports — because the agent extension
// build (`eve extension build`) evaluates this file through the extension's own module graph and
// cannot resolve `./x.js` style imports in this package. `okf.ts` re-exports everything here, so
// `@lares/vault-format/okf` and `@lares/agent-kit/okf` keep working.
//
// The reading state is deliberately NOT called `status`: in OKF SPEC.md at the pinned commit
// ad30107c, §5.4, `status` is the document LIFECYCLE field (`draft | stable | deprecated`,
// absent means `stable`), so reusing it for "have I read this yet" would collide with a
// spec-defined meaning. The same spec's §5.1/§5.2 define `sources` as a list of mappings with a
// required `resource`, and `generated` as `{by, at}`; articles write those shapes.

/** The article area's addition to the OKF type list: one saved web page, its summary and provenance. */
export const OKF_ARTICLE_TYPES = ["article"] as const;

/** Reading state of an article. Not `status` — see the header (OKF §5.4). */
export const ARTICLE_READING_KEY = "reading";
export const ARTICLE_READING_STATES = ["to-read", "read", "used", "dropped", "suggested"] as const;

/** Frontmatter key naming the plain-text companion that holds an article's full text. */
export const ARTICLE_FULL_TEXT_KEY = "full_text";

/**
 * Where an article's text companion lives, from the note's store-relative path and the
 * `full_text` value. Only a bare `<name>.txt` beside the note is accepted; anything that could
 * point elsewhere (a path, `..`, a dot-file, a non-`.txt` name) returns null, so a hand-edited
 * note cannot make a move, delete or erasure touch another file.
 */
export function articleCompanionPath(notePath: string, fullText: string): string | null {
  if (!/^[^/\\\0]+\.txt$/.test(fullText) || fullText.startsWith(".")) return null;
  const slash = notePath.lastIndexOf("/");
  return slash === -1 ? fullText : `${notePath.slice(0, slash + 1)}${fullText}`;
}
