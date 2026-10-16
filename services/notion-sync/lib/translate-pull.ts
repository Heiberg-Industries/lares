// Pure Notion-flavored -> Obsidian-flavoured markdown translation. No I/O, no vendor
// imports (mirrors translate.ts's own boundary; tests/neutrality.test.ts enforces
// it). This is the reverse of translate.ts's renderWikiPage: every construct that
// file mints on the way out, this file un-mints on the way in. It does NOT import
// translate.ts — the two files mirror each other's constants independently on
// purpose, so a change to one is forced to be a deliberate, visible edit to both.
//
// Syntax authority: the same enhanced-markdown spec translate.ts cites (§4.1-4.3).
//
// Fidelity is asymmetric by construction and that is accepted, not a bug here:
//   - push loses the distinction between a bare `[[x]]` link and an aliased
//     `[[x|label]]` one (both become `<mention-page>` with only the resolved/alias
//     label surviving) — so pull always reconstructs a BARE `[[target]]`, never
//     an alias. Files that relied on alias text fail the fidelity gate (T4), which
//     is exactly the gate's job; this file does not try to guess around it.
//   - push also loses whether a callout's first line was an inline `[!type] title`
//     or a separate body line — both flatten to the same <br>-joined child. Pull
//     always reconstructs `[!type]` alone plus body lines, never an inline title.
//
// OUTPUT SHAPE — the canonical block separation (deploy discovery, 2026-08-04)
//
// Notion's serialiser joins top-level blocks with a SINGLE "\n": every blank
// line between blocks is gone by the time `GET /v1/pages/:id/markdown` hands the
// page back. Verified live against a page pushed from a conventionally formatted
// vault file, which came back as:
//
//   # Probe note\nA desk probe file…\n- one list item\n- two list items\n<callout …>
//
// and again against the live wiki mirror, where a hard-wrapped source paragraph
// came back as three "\n"-joined lines. So "\n" means BLOCK BOUNDARY here (the
// in-block line break is `<br>`, spec §4.2), and the vault's own blank lines are
// not recoverable from the markdown — that information no longer exists.
//
// This file therefore emits ONE canonical shape rather than mirroring whatever
// the input happened to look like: **top-level blocks separated by exactly one
// blank line**, compound blocks kept tight. The same body comes out whether the
// input separated blocks with "\n" (Notion's shape) or "\n\n" (our own render's
// shape, which the offline fidelity leg feeds in) — without that, the offline
// leg and the live leg could never agree, and an approved apply would write
// Notion's blank-line-stripped body into the vault, merging paragraphs.
//
// Blank lines are inserted at a boundary between: paragraph↔paragraph,
// heading↔anything, list↔non-list, table↔non-table, quote/callout↔anything,
// fenced or indented code↔anything. They are NOT inserted inside a compound
// block — consecutive list items, consecutive table rows, the `<br>`-split lines
// of one quote/callout body, or anything between a fence's own delimiters
// (fenced content is verbatim, blank lines included).
//
// Four places where a blank line would not merely re-space the document but
// CHANGE it, so the rule above is overridden rather than applied:
//   - a setext underline (`====` / `----`) belongs to the paragraph line above
//     it: separating them turns a heading into a paragraph plus a stray line or
//     a thematic break;
//   - a second table's delimiter row starts a new table: welding the two makes
//     that table's header and delimiter into data rows of the first;
//   - a list whose marker family changes (`-` → `1.`) is a new list, and the
//     blank between them is structure, not decoration;
//   - an indented code line that followed a blank is a code block, not a lazy
//     continuation of the paragraph above it.
//
// The costs, accepted and named:
//   - a vault file whose paragraphs are hard-wrapped across several lines comes
//     back as one blank-separated paragraph per line. That is not a guess —
//     Notion really did store those lines as separate blocks on the way in, and
//     it is what the human sees and edits on the page, so reconstructing them as
//     one paragraph would be the lie. Such a file only ever changes if a
//     Notion-side edit is approved for it, and `enable-two-way` flags it
//     `reflow` at flip time;
//   - list looseness (`- a` / blank / `- b`) is not preserved: a pulled list is
//     always tight;
//   - a MULTI-line paragraph under a setext underline keeps its paragraph
//     separators, so only its last line reads as the heading. Notion had already
//     split those lines into separate blocks on the way in, so the heading did
//     not survive the push either.
// The first three of the four overrides above can only fire on input that still
// HAS blank lines — i.e. our own render, not Notion's output. What keeps the
// live side from having to guess is normalizeForFidelity's rule 4, which leaves
// those blank lines visible to the gate so an ambiguous file fails it instead of
// being rewritten into the other document.
//
// Unescaping is NOT a single uniform pass, because push doesn't apply a single
// uniform escape. Two different mechanisms produced whatever backslashes show
// up here, and each needs its own exact inverse:
//   - escapeAngles touches ONLY `<`, in ordinary prose, keyed on backslash-run
//     PARITY (odd = already escaped, leave alone; even = live, it added one).
//     unescapeAngleOnly mirrors that exactly and touches nothing else — an
//     author-written `\*`, `\|`, `\$`, `\^` in vault prose was never a live
//     character to begin with, so push left it alone, and pull must too.
//   - escapeLiteral touches EVERY NOTION_SPECIAL, unconditionally, char by char
//     — but only inside the two constructs it builds from scratch: an escaped
//     wikilink literal (`\[\[target\]\]`) and a mention/unknown-tag label. Its
//     exact inverse is LEFT-TO-RIGHT PAIRING (`\` + next char -> next char),
//     not parity — escapeLiteral doesn't count runs, so neither does its
//     inverse. This is also why `[[a\b]]` survives the round trip: the literal
//     backslash in the target becomes `\\` going out, and pairing un-doubles it.

export interface ResolvedWikiTarget {
  /**
   * The exact text to place between the wikilink brackets — emitted verbatim
   * as `[[target]]`, no further transformation. Deciding "bare stem when
   * unique, else directory-qualified" is the CALLER's job: only the caller's
   * index has visibility across the whole vault to know what's unique, so it
   * belongs with the engine (T5+), not in this single-mention-at-a-time pure
   * function.
   */
  target: string;
}

export interface ParseNotionPageOptions {
  /** Notion page url or id — whichever attribute the `<mention-page>` tag
   *  carries (`url="..."` preferred, `id="..."` as a fallback) — mapped to the
   *  wikilink target text to emit, or null when there is none (yet). MUST NOT
   *  be called for text this file already knows is an inert escaped literal —
   *  see the "cannot be bypassed" unescaping tests for why that matters. */
  resolvePage: (urlOrId: string) => ResolvedWikiTarget | null;
}

export interface ParsedNotionPage {
  body: string;
  /** Fidelity notes: unknown callout icon/color, unresolved mentions, unsupported
   *  tags. Mirrors translate.ts's warnings contract — advisory, never thrown. */
  warnings: string[];
}

/** Must equal translate.ts's CALLOUT_STYLE map, inverted (icon|color -> type).
 *  Binding per spec §4.1, not a style preference — kept as a literal here rather
 *  than imported so the two files never silently drift without a diff on both. */
const CALLOUT_STYLE_REVERSE: Record<string, string> = {
  "💡|blue": "summary",
  "💬|gray": "quote",
  "⚠️|yellow": "warning",
  "❗|red": "important",
  "☑️|green": "todo",
};

// ---------------------------------------------------------------------------
// Unescaping — inverts escapeAngles / escapeLiteral, each on its own terms
// ---------------------------------------------------------------------------

/**
 * Inverts escapeAngles exactly, and ONLY escapeAngles: a `<` preceded by an
 * ODD backslash run was added by escaping (drop exactly one backslash, keep
 * `<` literal); an EVEN run (including zero) means it was never touched.
 * Every other character — including every OTHER escaped special an author
 * typed by hand (`\*`, `\|`, `\$`, `\^`, ...) — passes through completely
 * unchanged, backslashes and all, because escapeAngles never touched them
 * either. This is the general-prose unescaper; it must never be used on an
 * escapeLiteral construct (a wikilink literal or a tag label) — those need
 * unescapeLiteralPairs instead.
 */
function unescapeAngleOnly(text: string): string {
  let out = "";
  let run = 0;
  for (const ch of text) {
    if (ch === "\\") {
      run += 1;
      continue;
    }
    if (ch === "<" && run % 2 === 1) out += "\\".repeat(run - 1) + ch;
    else out += "\\".repeat(run) + ch;
    run = 0;
  }
  out += "\\".repeat(run);
  return out;
}

/**
 * Inverts escapeLiteral exactly: escapeLiteral is a straight per-character
 * replace (every NOTION_SPECIAL, including a literal backslash, becomes `\`
 * + itself), not a run-counting scan, so its inverse is left-to-right
 * PAIRING rather than parity — a `\` always consumes exactly the next
 * character and emits it bare. This is what makes `[[a\b]]` (a wikilink
 * target containing a literal backslash) survive the round trip: escapeLiteral
 * doubles it to `\\` going out, and pairing un-doubles it coming back, whereas
 * parity-based unescaping would incorrectly treat the doubled backslash as
 * "already escaped, do nothing" and drop a character.
 */
function unescapeLiteralPairs(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "\\" && i + 1 < text.length) {
      out += text[i + 1];
      i += 1;
    } else {
      out += text[i];
    }
  }
  return out;
}

/** Counts the backslash run immediately before `index` — the same "is this `<`
 *  live or inert" test assertPushSafe uses, generalised to any tag opener. */
function backslashRunBefore(text: string, index: number): number {
  let n = 0;
  for (let j = index - 1; j >= 0 && text[j] === "\\"; j -= 1) n += 1;
  return n;
}

// ---------------------------------------------------------------------------
// Code fences and inline code spans — verbatim, both directions
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

// ---------------------------------------------------------------------------
// Inline tags — <mention-page>, <mention-database>, unknown, <empty-block/>
// ---------------------------------------------------------------------------

type Resolver = ParseNotionPageOptions["resolvePage"];

/**
 * Two DIFFERENT kinds of span, matched together so a single left-to-right
 * scan finds whichever comes first:
 *   - group 1-3: an opening tag (name / attrs / self-closing slash) — same
 *     shape as before.
 *   - the second alternative (no capture groups): an escaped wikilink
 *     literal, `\[\[...\]\]`, lazy up to the first `\]\]`. Safe to stop at
 *     the first one because push's own WIKILINK regex excludes `[`, `]`, `|`
 *     from the raw target/alias text it ever escapes this way, so a `\]\]`
 *     from the target's own content can't occur — the first one really is
 *     the closing boundary.
 */
const SPAN = /<([a-zA-Z][\w-]*)((?:\s+[\w-]+="[^"]*")*)\s*(\/)?>|\\\[\\\[[\s\S]*?\\\]\\\]/g;

/**
 * One plain-text segment (never inside code): reverses mention tags, unknown
 * tags, and escaped wikilink literals; unescapes everything else via
 * unescapeAngleOnly (general prose — see the file header for why that's the
 * right default, not unescapeLiteralPairs). A tag candidate whose `<` has an
 * ODD preceding backslash run is the inert literal escapeAngles left behind
 * (or a hand-written escape) — never a tag we minted — so it is skipped here
 * and picked up by the trailing unescape sweep instead. This is the exact
 * mirror of assertPushSafe's own live/inert test.
 */
function parsePlainText(text: string, resolvePage: Resolver, warnings: string[], lineNo: number): string {
  let out = "";
  let cursor = 0;
  SPAN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SPAN.exec(text)) !== null) {
    if (m[1] === undefined) {
      // Escaped wikilink literal — escapeLiteral's construct, so its exact
      // inverse is pairing, applied to the whole matched span at once.
      out += unescapeAngleOnly(text.slice(cursor, m.index));
      out += unescapeLiteralPairs(m[0]);
      cursor = m.index + m[0].length;
      SPAN.lastIndex = cursor;
      continue;
    }

    if (backslashRunBefore(text, m.index) % 2 === 1) continue;

    const tagName = m[1].toLowerCase();
    const attrs = m[2];
    const selfClosing = m[3] === "/";

    if (selfClosing) {
      // <empty-block/> only carries meaning as a whole line (handled by the
      // caller); mid-line it simply contributes nothing. Any other self-closing
      // tag is unsupported — same "keep nothing, warn" stance as a paired one.
      out += unescapeAngleOnly(text.slice(cursor, m.index));
      if (tagName !== "empty-block") {
        warnings.push(`unsupported <${tagName}/> (line ${lineNo}) — dropped`);
      }
      cursor = m.index + m[0].length;
      SPAN.lastIndex = cursor;
      continue;
    }

    const closeTag = `</${m[1]}>`;
    const closeIdx = text.indexOf(closeTag, m.index + m[0].length);
    if (closeIdx === -1) continue; // no matching close — not safe to treat as a tag

    // The label is escapeLiteral's construct too (translate.ts always wraps
    // it in escapeLiteral before minting the tag) — pairing, not parity.
    const label = unescapeLiteralPairs(text.slice(m.index + m[0].length, closeIdx));
    out += unescapeAngleOnly(text.slice(cursor, m.index));

    if (tagName === "mention-page") {
      // url= is what translate.ts emits; id= is accepted too since T4's live
      // probe against real Notion GET /markdown output hasn't run yet and
      // either attribute name is cheap to support now.
      const key = (/\burl="([^"]*)"/.exec(attrs) ?? /\bid="([^"]*)"/.exec(attrs))?.[1] ?? null;
      const resolved = key !== null ? resolvePage(key) : null;
      if (resolved !== null) {
        out += `[[${resolved.target}]]`;
      } else {
        warnings.push(`unresolved mention-page (line ${lineNo}) — kept "${label}" as plain text`);
        out += label;
      }
    } else {
      // <mention-database> and anything else this file doesn't have a
      // construct for — the label survives as plain text, never silently
      // dropped, same stance translate.ts takes for an unrecognised callout.
      warnings.push(`unsupported <${tagName}> (line ${lineNo}) — kept "${label}" as plain text`);
      out += label;
    }

    cursor = closeIdx + closeTag.length;
    SPAN.lastIndex = cursor;
  }
  out += unescapeAngleOnly(text.slice(cursor));
  return out;
}

/** One rich-text line: code spans pass through verbatim, everything else through
 *  parsePlainText. Exact mirror of translate.ts's renderInline. */
function renderInlineFromNotion(line: string, resolvePage: Resolver, warnings: string[], lineNo: number): string {
  let out = "";
  let rest = line;
  for (;;) {
    const m = CODE_SPAN.exec(rest);
    if (m === null) return out + parsePlainText(rest, resolvePage, warnings, lineNo);
    out += parsePlainText(rest.slice(0, m.index), resolvePage, warnings, lineNo);
    out += m[0];
    rest = rest.slice(m.index + m[0].length);
  }
}

// ---------------------------------------------------------------------------
// Quotes and callouts
// ---------------------------------------------------------------------------

function isQuoteLine(line: string): boolean {
  return /^\s{0,3}>/.test(line);
}

function stripQuoteMarker(line: string): string {
  return line.replace(/^\s{0,3}> ?/, "");
}

/** A quote/callout body's `<br>`-joined parts, each becoming its own `> ` line —
 *  the exact inverse of translate.ts's renderQuoteGroup join. */
function quoteLines(body: string, resolvePage: Resolver, warnings: string[], lineNo: number): string[] {
  return body.split("<br>").map((part) => `> ${renderInlineFromNotion(part, resolvePage, warnings, lineNo)}`);
}

const CALLOUT_OPEN = /^<callout icon="([^"]*)" color="([^"]*)">$/;
const CALLOUT_CLOSE = "</callout>";

/** Consumes lines[startIdx..] from a `<callout>` open tag through its matching
 *  `</callout>`, returning the reconstructed `> [!type]` block and the index to
 *  resume the outer loop at. */
function parseCalloutBlock(
  lines: string[],
  startIdx: number,
  match: RegExpExecArray,
  resolvePage: Resolver,
  warnings: string[],
): { outLines: string[]; nextIdx: number } {
  const [, icon, color] = match;
  let type = CALLOUT_STYLE_REVERSE[`${icon}|${color}`];
  if (type === undefined) {
    type = "note";
    warnings.push(
      `unknown callout icon/color ("${icon}", "${color}") (line ${startIdx + 1}) — rendered as [!note]`,
    );
  }

  const outLines = [`> [!${type}]`];
  let i = startIdx + 1;
  while (i < lines.length && lines[i].trim() !== CALLOUT_CLOSE) {
    const body = lines[i].replace(/^\t/, "");
    outLines.push(...quoteLines(body, resolvePage, warnings, i + 1));
    i += 1;
  }
  return { outLines, nextIdx: i + 1 };
}

// ---------------------------------------------------------------------------
// Block shape — where a blank line belongs (see the OUTPUT SHAPE header note)
// ---------------------------------------------------------------------------

/**
 * What an emitted line is, for the ONE purpose of deciding block separation.
 * Not a markdown model: `inside` covers every line that continues the block
 * above it (an indented list continuation, an indented code line, a fence's own
 * content), and `empty` is the blank line an `<empty-block/>` stands for.
 */
type BlockKind =
  | "heading" | "para" | "list" | "table" | "quote" | "fence" | "code-indent" | "empty" | "inside";

interface OutLine {
  text: string;
  kind: BlockKind;
  /** True when this line STARTS a new top-level block rather than continuing one. */
  opensBlock: boolean;
  /** True when this line starts a NEW run of a kind that normally stays tight —
   *  a second table, or a list whose marker family changed. Overrides the
   *  same-kind suppression in needsSeparator, which would otherwise weld the two
   *  runs into one construct. */
  breaksRun?: boolean;
}

/** Any list marker at any indent — a nested item is still a list item. */
const LIST_MARKER = /^[ \t]*(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/;

/** A table's header/body separator: `| --- | :-: |`. Only ever tested on a line
 *  already known to be a table row, so it cannot be confused with `---`. */
const TABLE_DELIMITER = /^\|[\s:|-]+\|?\s*$/;

/** A setext underline: `====` (H1) or `----` (H2) under the line it titles. */
const SETEXT_UNDERLINE = /^ {0,3}(?:=+|-{2,})\s*$/;

/** An indented code line — four spaces or a tab, markdown's fence-less code block. */
const INDENTED_CODE = /^(?: {4,}|\t)/;

/** A line that can carry a setext underline: ordinary paragraph text, not a
 *  heading, list item, quote, table row or indented line. */
function canTakeSetextUnderline(text: string): boolean {
  return text.trim() !== ""
    && !INDENTED_CODE.test(text)
    && !LIST_MARKER.test(text)
    && !/^ {0,3}[>#|]/.test(text)
    && !SETEXT_UNDERLINE.test(text);
}

/** Which list a marker belongs to: the bullet character, or "ordered" for
 *  `1.`/`1)`. A change of family at the same (zero) indent starts a NEW list in
 *  markdown, so the blank line between them is structure, not decoration. */
function listFamily(text: string): string | null {
  const m = /^(?:([-*+])|(\d{1,9})[.)])(?:[ \t]|$)/.exec(text);
  if (m === null) return null; // indented → nested, not a sibling run
  return m[1] ?? "ordered";
}

/** Block kind of one reconstructed (Obsidian-flavoured) line. Quote, callout and
 *  fence lines never reach this — their kind is known where they are emitted. */
function classifyLine(text: string): BlockKind {
  if (LIST_MARKER.test(text)) return "list";
  if (/^[ \t]/.test(text)) return "inside";
  if (/^#{1,6}(?: |$)/.test(text)) return "heading";
  if (text.startsWith("|")) return "table";
  return "para";
}

/**
 * Whether a blank line goes between these two emitted lines.
 *
 * Notion counts every list item and every table row as its own block, but in
 * markdown they are ONE construct: a blank line between two `- ` items makes a
 * loose list, and a blank line between two rows ends the table. Those two runs
 * are therefore the only same-kind pairs that stay tight. Everything else that
 * opens a block gets its separator — including two consecutive paragraphs,
 * which is the case Notion's single-"\n" output makes indistinguishable from a
 * hard-wrapped one (header note).
 *
 * An `<empty-block/>` IS separation, so nothing is added beside one: k of them
 * between two blocks come back as k blank lines, not 2k+1. Not a fixed point,
 * and worth being exact about rather than claiming stability the code does not
 * have: one empty block renders as exactly the ordinary separator, so the next
 * push cannot tell it from one, and k >= 2 renders as k blank lines of which
 * only the first survives the next pull (the rest are separator whitespace on
 * the way in). An empty Notion paragraph is preserved as spacing, never as a
 * construct — the same asymmetry the file header names for everything else that
 * only exists as a blank line.
 */
function needsSeparator(prev: OutLine, next: OutLine): boolean {
  if (!next.opensBlock) return false;
  if (prev.kind === "empty" || next.kind === "empty") return false;
  if (next.breaksRun === true) return true;
  if (prev.kind === next.kind && (next.kind === "list" || next.kind === "table")) return false;
  return true;
}

/**
 * Whether this delimiter row opens a SECOND table rather than belonging to the
 * run already being emitted. Walks back over the current table run: a delimiter
 * already in it means the row directly above this one is a new table's header,
 * and welding the two would silently turn that header and this delimiter into
 * data rows of the first table. Structural on purpose — the blank line that
 * separated them in the vault is gone before this file ever sees the markdown.
 */
function startsNewTableRun(out: OutLine[], text: string): boolean {
  if (!TABLE_DELIMITER.test(text)) return false;
  for (let j = out.length - 1; j >= 0; j -= 1) {
    if (out[j].kind !== "table") return false;
    if (TABLE_DELIMITER.test(out[j].text)) return true;
  }
  return false;
}

/** The marker family of the list run being emitted — the last UNINDENTED item in
 *  it, so nested items in between do not read as a change of family. */
function topLevelListFamily(out: OutLine[]): string | null {
  for (let j = out.length - 1; j >= 0; j -= 1) {
    if (out[j].kind !== "list") return null;
    const family = listFamily(out[j].text);
    if (family !== null) return family;
  }
  return null;
}

/** The kind an indented continuation line inherits: the block it continues, or
 *  `para` when there is nothing above it to continue (or only a blank). */
function continuedKind(out: OutLine[]): BlockKind {
  const prev = out[out.length - 1];
  return prev === undefined || prev.kind === "empty" ? "para" : prev.kind;
}

// ---------------------------------------------------------------------------
// The parser
// ---------------------------------------------------------------------------

export function parseNotionPage(notionMarkdown: string, opts: ParseNotionPageOptions): ParsedNotionPage {
  const warnings: string[] = [];
  const lines = notionMarkdown.replace(/\r\n/g, "\n").split("\n");
  const out: OutLine[] = [];
  const pushGroup = (texts: string[], kind: BlockKind): void => {
    texts.forEach((text, idx) => out.push({ text, kind, opensBlock: idx === 0 }));
  };
  let fence: FenceState | null = null;
  /** Whether the input had a blank line immediately before the line being read.
   *  Notion's shape never has one; our own render's does, and it is the only
   *  thing that distinguishes a setext underline from a thematic break. */
  let blankBefore = true;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const precededByBlank = blankBefore;
    blankBefore = false;

    if (fence !== null) {
      // Fence content and the closing delimiter continue the block the opening
      // delimiter started — verbatim, blank lines included.
      out.push({ text: line, kind: "fence", opensBlock: false });
      if (closesFence(line, fence)) fence = null;
      i += 1;
      continue;
    }
    const opened = opensFence(line);
    if (opened !== null) {
      fence = opened;
      out.push({ text: line, kind: "fence", opensBlock: true });
      i += 1;
      continue;
    }

    // A blank line outside a fence is block separation, never content — in our
    // own render's shape it is there, in Notion's it is not, and the separator
    // is re-derived below either way. Dropping it here is what collapses the two
    // input shapes onto one output shape.
    if (line.trim() === "") {
      blankBefore = true;
      i += 1;
      continue;
    }

    const calloutMatch = CALLOUT_OPEN.exec(line.trim());
    if (calloutMatch !== null) {
      const { outLines, nextIdx } = parseCalloutBlock(lines, i, calloutMatch, opts.resolvePage, warnings);
      pushGroup(outLines, "quote");
      i = nextIdx;
      continue;
    }

    if (line.trim() === "<empty-block/>") {
      out.push({ text: "", kind: "empty", opensBlock: false });
      i += 1;
      continue;
    }

    if (isQuoteLine(line)) {
      // One `>` line in = one Notion quote block; the `<br>`-split lines it
      // expands to are that same block's body and stay tight.
      pushGroup(quoteLines(stripQuoteMarker(line), opts.resolvePage, warnings, i + 1), "quote");
      i += 1;
      continue;
    }

    const text = renderInlineFromNotion(line, opts.resolvePage, warnings, i + 1);
    const previous = out[out.length - 1];

    // A setext underline belongs to the paragraph line directly above it — the
    // two ARE the heading. Separating them would turn a heading into a paragraph
    // plus a stray line (`====`) or a thematic break (`----`), and with block
    // spacing normalised away the fidelity gate could not see it happen. Only
    // when the input had no blank line between them: a `---` after a blank (or
    // at the start of the body) is a thematic break, and stays one. Limitation,
    // named: a MULTI-line paragraph under an underline keeps its paragraph
    // separators, so only its last line reads as the heading — Notion split those
    // lines into separate blocks on the way in, so the heading was already gone.
    if (
      !precededByBlank && previous !== undefined && previous.kind === "para"
      && previous.opensBlock && SETEXT_UNDERLINE.test(text)
    ) {
      previous.kind = "heading";
      out.push({ text, kind: "heading", opensBlock: false });
      i += 1;
      continue;
    }

    const classified = classifyLine(text);
    if (classified === "inside") {
      // An indented line that FOLLOWS A BLANK is markdown's fence-less code
      // block and a block in its own right — welding it to the paragraph above
      // would make it a lazy continuation and stop it rendering as code. Inside
      // a list, the same indentation means the item's own continuation, so the
      // rule stops at a list. (Notion's shape carries no blank lines, so this
      // can only fire on our own render — see normalizeForFidelity's rule 4 for
      // how the gate keeps the live side from guessing.)
      if (precededByBlank && INDENTED_CODE.test(text) && previous?.kind !== "list") {
        out.push({ text, kind: "code-indent", opensBlock: true });
        i += 1;
        continue;
      }
      // Otherwise a continuation line takes on the kind of the block it
      // continues, so the run it belongs to survives it: `- one` / `  continued`
      // / `- two` is still one list, and a blank line before the second item
      // would make it a loose one.
      out.push({ text, kind: continuedKind(out), opensBlock: false });
      i += 1;
      continue;
    }

    // Two runs of the same kind that markdown would weld into one construct if
    // they touched: a second table (its delimiter row would become a data row of
    // the first), and a list whose marker family changed.
    let breaksRun = false;
    if (classified === "table" && startsNewTableRun(out, text)) {
      const header = out[out.length - 1];
      if (header !== undefined) header.breaksRun = true;
    } else if (classified === "list" && previous?.kind === "list") {
      // Compare against the run's own top-level marker, not the line directly
      // above — a nested item sits between two siblings without ending the list.
      const now = listFamily(text);
      breaksRun = now !== null && topLevelListFamily(out) !== null && topLevelListFamily(out) !== now;
    }

    out.push({ text, kind: classified, opensBlock: true, ...(breaksRun ? { breaksRun } : {}) });
    i += 1;
  }

  // Mirrors renderWikiPage's own edge trim, so a pulled body's edges don't churn
  // against incidental blank lines in whatever produced the input. Only
  // `<empty-block/>` lines can be here — ordinary blanks were dropped above.
  while (out.length > 0 && out[0].text.trim() === "") out.shift();
  while (out.length > 0 && out[out.length - 1].text.trim() === "") out.pop();

  const body: string[] = [];
  out.forEach((current, idx) => {
    if (idx > 0 && needsSeparator(out[idx - 1], current)) body.push("");
    body.push(current.text);
  });

  return { body: body.join("\n"), warnings };
}

// ---------------------------------------------------------------------------
// The pull-safety rail
// ---------------------------------------------------------------------------

const EXPIRING_URL = /secure\.notion-static\.com|file\.notion\.so|X-Amz-/gi;
const TRANSCRIPT_TAG = /<transcript\b/gi;

/** Character-index ranges of `markdown` that are inside a fenced code block or
 *  an inline code span — content there is a literal sample, never a live
 *  construct, in both directions (see opensFence/closesFence/CODE_SPAN above). */
function codeRanges(markdown: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const lines = markdown.split("\n");
  let fence: FenceState | null = null;
  let offset = 0;
  for (const line of lines) {
    if (fence !== null) {
      ranges.push([offset, offset + line.length]);
      if (closesFence(line, fence)) fence = null;
    } else {
      const opened = opensFence(line);
      if (opened !== null) {
        fence = opened;
        ranges.push([offset, offset + line.length]);
      } else {
        const spanRe = new RegExp(CODE_SPAN.source, "g");
        let m: RegExpExecArray | null;
        while ((m = spanRe.exec(line)) !== null) {
          ranges.push([offset + m.index, offset + m.index + m[0].length]);
        }
      }
    }
    offset += line.length + 1; // +1 for the "\n" split() consumed
  }
  return ranges;
}

function isInRanges(ranges: Array<[number, number]>, index: number): boolean {
  return ranges.some(([start, end]) => index >= start && index < end);
}

/**
 * Called by the engine on the reconstructed body BEFORE it is written into the
 * vault — the pull mirror of assertPushSafe. Throws on a Notion-signed expiring
 * URL (uploaded file/image links: they expire, and a stale one baked into a
 * vault file is worse than none — freeze the row, spec §4.4 as amended) and on
 * a live `<transcript` block (no Obsidian-side construct to round-trip it into).
 *
 * Deliberately MORE precise than assertPushSafe, not just its mirror-image:
 * push over-blocking is free (the flagged content simply stays out of the
 * vault, and the source markdown is untouched either way), but pull
 * over-blocking permanently freezes a row over content that was never
 * actually unsafe — a false positive has a real, sticky cost. So here, and
 * only here: a `<transcript` is checked for liveness (an escaped `\<transcript`
 * is inert prose, e.g. someone's push-escaped mention of the tag itself) and
 * an expiring-URL match inside a code fence or inline code span is sample
 * text, not a live image link — both are skipped rather than flagged.
 */
export function assertPullSafe(markdown: string): void {
  const normalized = markdown.replace(/\r\n/g, "\n");
  const ranges = codeRanges(normalized);

  EXPIRING_URL.lastIndex = 0;
  let expiring: RegExpExecArray | null;
  while ((expiring = EXPIRING_URL.exec(normalized)) !== null) {
    if (isInRanges(ranges, expiring.index)) continue;
    const line = normalized.slice(0, expiring.index).split("\n").length;
    throw new Error(
      `notion-sync: refusing to pull — Notion-signed expiring URL ("${expiring[0]}") at line ${line}; ` +
        `it will go stale in the vault (spec §4.4, freeze the row)`,
    );
  }

  TRANSCRIPT_TAG.lastIndex = 0;
  let transcript: RegExpExecArray | null;
  while ((transcript = TRANSCRIPT_TAG.exec(normalized)) !== null) {
    if (backslashRunBefore(normalized, transcript.index) % 2 === 1) continue;
    const line = normalized.slice(0, transcript.index).split("\n").length;
    throw new Error(`notion-sync: refusing to pull — <transcript> block at line ${line} cannot round-trip`);
  }
}

// ---------------------------------------------------------------------------
// Fidelity-gate normalisation
// ---------------------------------------------------------------------------

/**
 * The ONLY normalisation either leg of the fidelity gate (T4) applies before
 * comparing a pulled body against the vault body it should match. Kept
 * deliberately minimal — every rule here is a fidelity difference the gate can
 * no longer see, so each one is named:
 *
 *   1. Line endings — CRLF and LF compare equal.
 *   2. Trailing whitespace at end of line.
 *   3. **Blank lines between blocks** (2026-08-04, the deploy discovery).
 *      Notion's `GET /markdown` joins top-level blocks with a single "\n": the
 *      vault's blank lines do not survive the round trip and cannot be inferred
 *      on the way back (see the OUTPUT SHAPE header note). Both sides are
 *      therefore compared with inter-block blank lines removed, so a file whose
 *      only divergence is block spacing still passes — and what an approved
 *      apply then writes is this file's canonical one-blank-line form.
 *
 *      Be precise about what that costs, because "just whitespace" is not the
 *      whole truth: in markdown a blank line can carry block STRUCTURE, and
 *      removing it makes those distinctions invisible here. Content lines still
 *      compare byte for byte, in order, and a blank line inside a fenced code
 *      block is content, so it is kept and compared. What the gate can no
 *      longer see, named:
 *        - **list looseness** — `- a` / blank / `- b` (loose) compares equal to
 *          the tight list. Both are lists; the spacing differs.
 *        - **lazy continuation** — a paragraph line under a list item compares
 *          equal whether it was the item's own continuation or a new paragraph.
 *      And what rule 4 below deliberately keeps VISIBLE, because there the
 *      blank line is the only thing standing between two different documents.
 *   4. **Structural blank lines are NOT removed.** A blank line whose next line
 *      is a setext underline (`====` / `----`) is what makes the line above it a
 *      paragraph followed by a thematic break rather than a heading; a blank
 *      line before an indented code line is what makes it code rather than a
 *      lazy continuation. Notion strips those blanks like any other, so the
 *      pulled body cannot have them — which is the point: keeping them on the
 *      vault side makes such a file FAIL the live leg and stay one-way, instead
 *      of passing and then being silently rewritten into the other document.
 *      This rule only ever makes the gate stricter.
 */
export function normalizeForFidelity(md: string): string {
  const lines = md
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""));

  const out: string[] = [];
  let fence: FenceState | null = null;
  for (const [index, line] of lines.entries()) {
    if (fence !== null) {
      out.push(line);
      if (closesFence(line, fence)) fence = null;
      continue;
    }
    const opened = opensFence(line);
    if (opened !== null) {
      fence = opened;
      out.push(line);
      continue;
    }
    if (line === "") {
      if (structuralBlank(out[out.length - 1], nextNonBlank(lines, index))) out.push(line);
      continue;
    }
    out.push(line);
  }

  return out.join("\n");
}

/** The next line after `index` that is not blank — what a blank run separates
 *  the previous emitted line FROM. */
function nextNonBlank(lines: string[], index: number): string | undefined {
  for (let j = index + 1; j < lines.length; j += 1) {
    if (lines[j] !== "") return lines[j];
  }
  return undefined;
}

/**
 * Whether this blank line is load-bearing (rule 4 above): it is the only thing
 * marking the line after it as a thematic break rather than a setext underline,
 * or as an indented code block rather than a lazy continuation. Both need a real
 * line on each side — a blank at the edges separates nothing. Only ever called
 * outside a fence, and it never REMOVES a blank the old rule kept, so it cannot
 * turn a failing comparison into a passing one.
 */
function structuralBlank(before: string | undefined, after: string | undefined): boolean {
  if (before === undefined || after === undefined || before === "") return false;
  if (SETEXT_UNDERLINE.test(after)) return canTakeSetextUnderline(before);
  if (INDENTED_CODE.test(after)) return !LIST_MARKER.test(before) && !INDENTED_CODE.test(before);
  return false;
}
