// Pure Obsidian-flavoured → Notion-flavored markdown translation. No I/O, no vendor
// imports — the engine injects the wikilink resolver, and every byte of output is a
// function of (source, path, resolve) alone, which is what makes the wiki pass
// idempotent-by-construction (plan decision 2: the rendered output IS the hash input).
//
// Syntax authority: Notion's enhanced-markdown spec (notion://docs/enhanced-markdown-spec),
// fetched 2026-08-04. The rules that shaped this file:
//   - backslash escapes the specials  \ * ~ ` $ [ ] < > { } | ^  — outside code only;
//     code block/span content is literal and escapes there would corrupt it,
//   - multi-line quotes and callout bodies must join with <br> — ordinary newlines
//     split them into separate blocks (spec §4.2),
//   - callout children are tab-indented inside <callout icon=".." color=".."> tags,
//   - headings 5-6 silently collapse to heading 4 (accepted; warned, spec §4.2),
//   - <page url> / <database url> MOVE content and DELETE it on removal — the one
//     construct that can destroy data, so it gets assertPushSafe (spec §4.3).
//
// Everything this file does NOT touch (headings 1-4, lists, to-dos, tables, code,
// inline marks, links, images) is native in both dialects per spec §4.1 and passes
// through verbatim.

export interface ResolvedWikiLink {
  url: string;
  title: string;
}

export interface RenderWikiPageOptions {
  /**
   * Vault-relative path of the source file (e.g. "people/jane.md"). Feeds the
   * title fallback (filename stem) and folderHint (directory part); the engine
   * prefixes its wikiDir when building the Notion `Folder` property.
   */
  path: string;
  /**
   * Maps a raw wikilink target (exactly as written between the brackets, e.g.
   * "raw/foo" or "note#heading") to a synced Notion page, or null when the target
   * has no page. MUST be deterministic given the store's path→page map (plan
   * decision 2): pass 1 of a backfill escapes unresolved links, pass 2 re-renders
   * with more targets resolvable, the hash differs, and exactly those files patch.
   */
  resolve: (target: string) => ResolvedWikiLink | null;
}

export interface RenderedWikiPage {
  markdown: string;
  title: string;
  /** The frontmatter's inner text verbatim (no --- fences), "" when absent. */
  frontmatter: string;
  /** Directory part of `path` ("people", "a/b"); absent for root-level files. */
  folderHint?: string;
  /** Fidelity notes (H5/H6 collapse, unknown callout types, code-span joins). */
  warnings: string[];
}

/** Callout type map, spec §4.1 — binding, not a style preference. */
const CALLOUT_STYLE: Record<string, { icon: string; color: string }> = {
  summary: { icon: "💡", color: "blue" },
  quote: { icon: "💬", color: "gray" },
  warning: { icon: "⚠️", color: "yellow" },
  important: { icon: "❗", color: "red" },
  todo: { icon: "☑️", color: "green" },
};

/**
 * A callout type outside the map still renders as a callout — dropping it to a
 * plain quote would silently lose the author's emphasis — but with a neutral
 * icon/color and a warning, mirroring how the pull direction will turn an
 * unrecognised icon into `> [!note]` (spec §4.1).
 */
const DEFAULT_CALLOUT = { icon: "📝", color: "gray" };

/** The full backslash-escapable set from the enhanced-markdown spec. */
const NOTION_SPECIALS = /[\\*~`$[\]<>{}|^]/g;

/** `[[target]]` / `[[target|alias]]`. Target can't contain [ ] |; alias can't contain [ ]. */
const WIKILINK = /\[\[([^\][|]+?)(?:\|([^\][]*))?\]\]/g;

/** `> [!type]` with Obsidian's optional fold marker and optional inline title. */
const CALLOUT_MARKER = /^\[!([A-Za-z][\w-]*)\][+-]?\s*(.*)$/;

// ---------------------------------------------------------------------------
// Escaping — the push-safety rail
// ---------------------------------------------------------------------------

/**
 * Escapes every `<` whose preceding backslash count is EVEN (i.e. every `<` that
 * Notion would treat as a live tag opener). This is the single rule that makes
 * assertPushSafe impossible to bypass from vault content: a run of n backslashes
 * before `<` becomes 2n+1 backslashes in the output — always odd, always inert —
 * because the backslashes themselves pass through and we prepend exactly one more.
 *
 * Only `<` needs this. No tag can open without a live `<`, so escaping the other
 * specials here would change the meaning of ordinary markdown (bold, links,
 * tables) for no safety gain. Cost, accepted: angle-bracket autolinks like
 * `<https://x>` become visible literal text.
 */
function escapeAngles(text: string): string {
  let out = "";
  let backslashes = 0;
  for (const ch of text) {
    if (ch === "\\") {
      backslashes += 1;
      out += ch;
      continue;
    }
    if (ch === "<" && backslashes % 2 === 0) out += "\\<";
    else out += ch;
    backslashes = 0;
  }
  return out;
}

/**
 * Escapes ALL Notion specials — for text that must render as exactly-literal
 * characters: unresolved wikilinks (`\[\[x\]\]`, spec §4.1) and mention labels.
 * The escaped `|` also stops an aliased wikilink literal from splitting a table
 * row it happens to sit in.
 */
function escapeLiteral(text: string): string {
  return text.replace(NOTION_SPECIALS, (c) => `\\${c}`);
}

/** Keeps a URL from breaking out of a tag attribute. Resolver URLs are engine-built,
 *  so this is belt-and-braces, not a sanitiser. */
function attrSafe(url: string): string {
  return url.replace(/"/g, "%22").replace(/</g, "%3C").replace(/>/g, "%3E");
}

/**
 * Why each refused tag is refused — carried into the error so an operator reading
 * a per-doc failure learns WHICH rule fired, not merely that one did.
 *
 * `page`/`database` are spec §4.3: they MOVE an existing page into this one and
 * DELETE it when the tag is removed. They are the only construct in the format
 * that can destroy content.
 *
 * `transcript` is spec §17.2, and it arrived with Phase 4. Notion's own
 * enhanced-markdown spec says the tag "cannot be edited by AI" and that attempting
 * to write it "will result in an error" — which is precisely why transcripts are
 * one-way Notion→vault permanently. Listing it here makes that rule a property of
 * the CONTENT. Two other rails already keep a transcript out of the push path, and
 * both are properties of CONFIGURATION: its state row is `target='meetings'`, so
 * the desk passes never see it, and `deskDirs[].exclude` carves the transcripts
 * folder out of the desk scope, so the vault walker never lists the file. This
 * third rail is the one that still holds if a future caller is wired wrong — the
 * failure becomes a loud refusal here rather than an error from Notion, or worse a
 * partially-written page.
 */
const REFUSED_TAGS: Record<string, string> = {
  page: "<page>/<database> move content and delete it on removal (spec §4.3)",
  database: "<page>/<database> move content and delete it on removal (spec §4.3)",
  transcript:
    "a <transcript> block cannot be written by the API, and transcripts are one-way " +
    "Notion→vault permanently (spec §17.2)",
};

/**
 * The push-safety lint, called by the engine on EVERY outbound body: throws on any
 * live `<page` / `<database` / `<transcript` tag opener. "Live" = the `<` is
 * preceded by an even number of backslashes; an odd count means the `<` itself is
 * escaped and the text is an inert literal. Case-insensitive because over-blocking
 * is free and Notion's parser is not ours to assume.
 *
 * Over-blocking being free is what separates this from assertPullSafe
 * (translate-pull.ts), which is deliberately more precise: a refused PUSH leaves
 * both sides exactly as they were and surfaces as a per-doc error, while a refused
 * PULL freezes a row over content that may never have been unsafe.
 *
 * Deliberately NOT fence-aware, for the same reason: code-block content is literal
 * in Notion-flavored markdown, so a fenced `<page` is *probably* inert — but
 * proving Notion parses the fence exactly as we do is impossible from here, and a
 * mis-parse in that direction is the one that destroys content. A code sample
 * naming these tags therefore fails the write loudly (per-doc error, 3-strike
 * surface) instead of being waved through on a heuristic.
 *
 * BE PRECISE ABOUT WHAT THIS CATCHES, because the honest answer is narrower than it
 * looks (review round 1). Every production caller passes `renderWikiPage`'s output,
 * and that runs `escapeAngles` over prose first — so a live tag in ordinary text has
 * already become an inert `\<page` by the time this sees it. What reaches it live is
 * a tag inside a FENCED CODE BLOCK (fence content is verbatim and unescaped, which is
 * the deliberate loud failure documented above) — and any body that did not go
 * through the renderer at all, which today means a caller passing raw file bytes.
 *
 * It is therefore NOT the rail that keeps a transcript out of the push. Rendered for
 * push, a transcript's `<transcript>` block escapes to `\<transcript>` and sails
 * through here. `assertPushSafeSource` below is the check that actually answers that
 * question, and the structural guards (`pushHoldBack`, the `target='meetings'` row,
 * config's carve-out) are what answer it first.
 */
export function assertPushSafe(markdown: string): void {
  const re = /<(page|database|transcript)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(markdown)) !== null) {
    let backslashes = 0;
    for (let j = m.index - 1; j >= 0 && markdown[j] === "\\"; j -= 1) backslashes += 1;
    if (backslashes % 2 === 1) continue;
    const tag = m[1].toLowerCase();
    const line = markdown.slice(0, m.index).split("\n").length;
    throw new Error(
      `notion-sync: refusing to push — live <${tag}> tag at line ${line}; ${REFUSED_TAGS[tag]}`,
    );
  }
}

/**
 * The SOURCE-side half of the push lint: may this vault file be pushed to Notion AT
 * ALL? Called on the raw bytes, before any rendering (Phase 4, review round 1).
 *
 * It asks one question — does this file contain a live `<transcript>` block? — and
 * that is deliberately narrower than `assertPushSafe`'s three tags, because the two
 * rules are about different things:
 *
 *  - `<page>`/`<database>` (spec §4.3) must never be EMITTED. Escaping them
 *    genuinely neutralises them, so a note that mentions one in prose renders to an
 *    inert literal and pushes correctly. Checking the source for those would break
 *    every such file for no safety gain.
 *  - `<transcript>` (spec §17.2) is not about emission: the DOCUMENT is one-way.
 *    Notion's own spec says the tag cannot be written by the API, and a file
 *    carrying one is a meeting transcript whose source is the Notion page. Escaping
 *    changes nothing about that — the escaped body would still be a transcript,
 *    pushed into a Docs page it does not belong in.
 *
 * So this is the rail that makes "a transcript never reaches a push path" a property
 * of the CONTENT rather than only of the configuration. It is the last of the three,
 * and the other two — the `target='meetings'` state row (which `pushHoldBack` turns
 * into a hold-back set the push consults before reading anything) and config's
 * `deskDirs[].exclude` — both stop the file well before it gets here. This one is
 * what still holds when the first two are wrong.
 */
export function assertPushSafeSource(source: string): void {
  const re = /<transcript/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    let backslashes = 0;
    for (let j = m.index - 1; j >= 0 && source[j] === "\\"; j -= 1) backslashes += 1;
    if (backslashes % 2 === 1) continue;
    const line = source.slice(0, m.index).split("\n").length;
    throw new Error(
      `notion-sync: refusing to push — this file carries a live <transcript> block at line ` +
      `${line}; ${REFUSED_TAGS.transcript}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Frontmatter and title
// ---------------------------------------------------------------------------

function splitFrontmatter(source: string): {
  frontmatter: string;
  bodyLines: string[];
  /** Lines consumed before the body — keeps warning line numbers file-accurate. */
  bodyLineOffset: number;
} {
  const lines = source.split("\n");
  if (lines[0]?.trim() === "---") {
    for (let i = 1; i < lines.length; i += 1) {
      if (lines[i].trim() === "---") {
        return {
          frontmatter: lines.slice(1, i).join("\n"),
          bodyLines: lines.slice(i + 1),
          bodyLineOffset: i + 1,
        };
      }
    }
  }
  // No frontmatter — or an unclosed fence, which is body, not metadata: guessing
  // where it "should" have closed could swallow half the document.
  return { frontmatter: "", bodyLines: lines, bodyLineOffset: 0 };
}

function stripMatchedQuotes(value: string): string {
  for (const q of ['"', "'"]) {
    if (value.length >= 2 && value.startsWith(q) && value.endsWith(q)) {
      return value.slice(1, -1);
    }
  }
  return value;
}

/**
 * Title per plan decision 4: frontmatter `title:` → first H1 → filename stem.
 * The frontmatter lookup is a line scan, not a YAML parser — `title` is a
 * top-level scalar in every vault file, and a YAML lib in lib/ is banned.
 */
function extractTitle(frontmatter: string, bodyLines: string[], path: string): string {
  for (const line of frontmatter.split("\n")) {
    const m = /^title:\s*(.+?)\s*$/.exec(line);
    if (m) return stripMatchedQuotes(m[1]);
  }
  // First H1 outside code fences — a `# comment` in a fence is not a heading.
  let fence: FenceState | null = null;
  for (const line of bodyLines) {
    if (fence !== null) {
      if (closesFence(line, fence)) fence = null;
      continue;
    }
    fence = opensFence(line);
    if (fence !== null) continue;
    const m = /^# +(.+?)\s*$/.exec(line);
    if (m) return m[1];
  }
  const stem = (path.split("/").pop() ?? path).replace(/\.md$/i, "");
  return stem === "" ? path : stem;
}

// ---------------------------------------------------------------------------
// Code fences and inline code spans
// ---------------------------------------------------------------------------

interface FenceState {
  char: string;
  length: number;
}

function opensFence(line: string): FenceState | null {
  const m = /^ {0,3}(`{3,}|~{3,})/.exec(line);
  return m === null ? null : { char: m[1][0], length: m[1].length };
}

function closesFence(line: string, fence: FenceState): boolean {
  const m = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
  return m !== null && m[1][0] === fence.char && m[1].length >= fence.length;
}

const CODE_SPAN = /(`+)(.*?)\1/;

/** True when a backtick remains after every closed span on the line is removed. */
function hasUnclosedCodeSpan(line: string): boolean {
  return line.replace(new RegExp(CODE_SPAN.source, "g"), "").includes("`");
}

// ---------------------------------------------------------------------------
// Inline rendering (per rich-text line)
// ---------------------------------------------------------------------------

type Resolver = RenderWikiPageOptions["resolve"];

/**
 * Wikilinks and angle-escaping for one plain-text segment (never inside code).
 * Order matters: wikilinks are cut out FIRST so the mention tags injected for
 * resolved targets are not themselves angle-escaped; only the text between them
 * goes through escapeAngles.
 */
function renderPlainText(text: string, resolve: Resolver): string {
  let out = "";
  let last = 0;
  for (const m of text.matchAll(WIKILINK)) {
    out += escapeAngles(text.slice(last, m.index));
    const target = m[1];
    const alias = m[2];
    const resolved = resolve(target);
    if (resolved === null) {
      // Unsynced target: the whole literal, fully escaped, stays visibly in the
      // text (spec §4.1) — pass 2 of a backfill re-renders it as a mention once
      // the target has a page.
      out += escapeLiteral(m[0]);
    } else {
      const label = alias !== undefined && alias.trim() !== "" ? alias : resolved.title;
      out += `<mention-page url="${attrSafe(resolved.url)}">${escapeLiteral(label)}</mention-page>`;
    }
    last = (m.index ?? 0) + m[0].length;
  }
  out += escapeAngles(text.slice(last));
  return out;
}

/** One rich-text line: inline code spans pass through verbatim (their content is
 *  literal — escaping inside them would corrupt it), everything else is processed. */
function renderInline(line: string, resolve: Resolver): string {
  let out = "";
  let rest = line;
  for (;;) {
    const m = CODE_SPAN.exec(rest);
    if (m === null) return out + renderPlainText(rest, resolve);
    out += renderPlainText(rest.slice(0, m.index), resolve);
    out += m[0];
    rest = rest.slice(m.index + m[0].length);
  }
}

// ---------------------------------------------------------------------------
// Quote / callout groups
// ---------------------------------------------------------------------------

function isQuoteLine(line: string): boolean {
  return /^\s{0,3}>/.test(line);
}

function stripQuoteMarker(line: string): string {
  return line.replace(/^\s{0,3}> ?/, "");
}

/**
 * One contiguous run of `>` lines → exactly one Notion block. Bodies join with
 * <br> and blank quote lines are normalised away, because ordinary newlines
 * split a Notion quote/callout into separate blocks and truly empty quote lines
 * render as empty blockquotes (both spec §4.2 hazards, 462 files exposed).
 */
function renderQuoteGroup(
  group: string[],
  firstLineNo: number,
  resolve: Resolver,
  warnings: string[],
): string[] {
  const first = stripQuoteMarker(group[0]).trim();
  const marker = CALLOUT_MARKER.exec(first);
  if (marker !== null) {
    const type = marker[1].toLowerCase();
    let style = CALLOUT_STYLE[type];
    if (style === undefined) {
      style = DEFAULT_CALLOUT;
      warnings.push(
        `unknown callout type "${marker[1]}" (line ${firstLineNo}) — rendered with default icon/color`,
      );
    }
    const parts: string[] = [];
    // Obsidian's inline title is just the first body line here: the binding
    // decision flattens callout bodies to one <br>-joined rich-text child, and
    // inventing bold/title styling the source does not carry would be guesswork.
    if (marker[2] !== "") parts.push(marker[2]);
    for (const line of group.slice(1)) {
      const body = stripQuoteMarker(line).trimEnd();
      if (body.trim() !== "") parts.push(body);
    }
    const joined = parts.map((p) => renderInline(p, resolve)).join("<br>");
    const open = `<callout icon="${style.icon}" color="${style.color}">`;
    return joined === "" ? [open, "</callout>"] : [open, `\t${joined}`, "</callout>"];
  }

  const bodyLines = group
    .map((line) => stripQuoteMarker(line).trimEnd())
    .filter((line) => line.trim() !== "");
  if (bodyLines.length === 0) return [];
  return [`> ${bodyLines.map((line) => renderInline(line, resolve)).join("<br>")}`];
}

// ---------------------------------------------------------------------------
// The renderer
// ---------------------------------------------------------------------------

export function renderWikiPage(source: string, opts: RenderWikiPageOptions): RenderedWikiPage {
  const warnings: string[] = [];
  // The vault is LF, but a CRLF file must not change meaning — normalise once.
  const { frontmatter, bodyLines, bodyLineOffset } = splitFrontmatter(
    source.replace(/\r\n/g, "\n"),
  );
  const title = extractTitle(frontmatter, bodyLines, opts.path);
  const dir = opts.path.split("/").slice(0, -1).join("/");
  const lineNo = (bodyIdx: number): number => bodyLineOffset + bodyIdx + 1;

  const out: string[] = [];
  let fence: FenceState | null = null;
  let i = 0;
  while (i < bodyLines.length) {
    const line = bodyLines[i];

    // Fenced code: verbatim, untranslated, unescaped — content is literal.
    if (fence !== null) {
      out.push(line);
      if (closesFence(line, fence)) fence = null;
      i += 1;
      continue;
    }
    const opened = opensFence(line);
    if (opened !== null) {
      fence = opened;
      out.push(line);
      i += 1;
      continue;
    }

    if (isQuoteLine(line)) {
      const group: string[] = [];
      const start = i;
      while (i < bodyLines.length && isQuoteLine(bodyLines[i])) {
        group.push(bodyLines[i]);
        i += 1;
      }
      out.push(...renderQuoteGroup(group, lineNo(start), opts.resolve, warnings));
      continue;
    }

    const heading = /^(#{5,6}) /.exec(line);
    if (heading !== null) {
      warnings.push(
        `heading level ${heading[1].length} collapses to heading 4 in Notion (line ${lineNo(i)})`,
      );
      out.push(renderInline(line, opts.resolve));
      i += 1;
      continue;
    }

    // A code span left open at end-of-line (spec §4.2: a newline breaks the span
    // and renders the backticks as literal text). Join following plain lines with
    // <br> until the span closes; if nothing in the paragraph ever closes it, the
    // backtick was a stray — leave the lines exactly as written.
    if (hasUnclosedCodeSpan(line)) {
      let joined = line;
      let j = i + 1;
      const joinWarnings: string[] = [];
      while (hasUnclosedCodeSpan(joined) && j < bodyLines.length) {
        const next = bodyLines[j];
        if (next.trim() === "" || isQuoteLine(next) || opensFence(next) !== null) break;
        joinWarnings.push(`newline inside inline code joined with <br> (line ${lineNo(j - 1)})`);
        joined = `${joined}<br>${next}`;
        j += 1;
      }
      if (!hasUnclosedCodeSpan(joined)) {
        warnings.push(...joinWarnings);
        out.push(renderInline(joined, opts.resolve));
        i = j;
        continue;
      }
    }

    out.push(renderInline(line, opts.resolve));
    i += 1;
  }

  // Blank edges are stripped by Notion anyway (spec §4.2); trimming them here
  // keeps the rendered hash stable against trailing-newline churn in the vault.
  while (out.length > 0 && out[0].trim() === "") out.shift();
  while (out.length > 0 && out[out.length - 1].trim() === "") out.pop();

  return {
    markdown: out.join("\n"),
    title,
    frontmatter,
    ...(dir === "" ? {} : { folderHint: dir }),
    warnings,
  };
}
