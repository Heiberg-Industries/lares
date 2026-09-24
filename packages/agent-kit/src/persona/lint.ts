// lintRole() — proves a role template names no person, company, vendor, place or language
// (ORB-145 Phase 2, Task 6). The vocabulary, the structural person rule's allowlist and its
// stopword list all live in overlay-vocabulary.ts; this file is purely scanning and reporting.
//
// `doc-lint.ts` runs the same scan over CAPABILITY_DOCS with per-entry licensing (ORB-210 item
// 1), so anything added here is inherited by the engine text as well as by role templates.

import {
  RULES,
  CAPITALIZED_WORD,
  STRUCTURAL_PERSON_ALLOWLIST,
  PERSON_NAME_STOPWORDS,
  TOOL_NAME_PATTERNS,
  TOOL_NAMES,
  type LintRule,
} from "./overlay-vocabulary.js";

export interface LintFinding {
  rule: LintRule;
  match: string;
  line: number;
  message?: string;
}

const RULE_ORDER: LintRule[] = RULES.map((r) => r.rule);

/** Every match of `pattern` in `text` with its start index, regardless of whether `pattern` was
 *  built with the `g` flag — callers never have to remember to add one. */
function findAll(text: string, pattern: RegExp): Array<{ match: string; index: number }> {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  const re = new RegExp(pattern.source, flags);
  const found: Array<{ match: string; index: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    found.push({ match: m[0], index: m.index });
    if (m[0].length === 0) re.lastIndex += 1; // never spin on a zero-width match
  }
  return found;
}

/** Replace a span with same-length `#` filler so text already claimed by one rule (an email, a
 *  URL) can't ALSO be read by another — e.g. "bendik@heiberg.co" must not additionally report a
 *  `person`/`company` match for the name and the domain buried inside the address. */
function blank(text: string, index: number, length: number): string {
  return text.slice(0, index) + "#".repeat(length) + text.slice(index + length);
}

function isStopword(word: string): boolean {
  return PERSON_NAME_STOPWORDS.has(word.toLowerCase());
}

interface Span {
  rule: LintRule;
  match: string;
  index: number;
}

/** Every literal-vocabulary hit on `line`, with overlaps resolved LONGEST-FIRST so one piece of
 *  text is claimed by exactly one rule (ORB-210 item 1).
 *
 *  This generalises what `blank()` already did for `address`/`url` to all seven rules, and the
 *  reason is the same one written on `blank()`: a span already read by one rule must not be read
 *  again by another. "MET Norway" is one vendor, not a vendor plus a `place`; "Google Maps
 *  Directions" is one service, not the vendor "Google" plus an unlisted person called "Maps
 *  Directions". Before this, both of those reported two and three times over — noise that reads
 *  identically to a real leak, which is how a lint stops being read at all. */
function literalSpans(line: string, reserved: Array<[number, number]>): Span[] {
  const all: Span[] = [];
  for (const { rule, patterns } of RULES) {
    for (const pattern of patterns) {
      for (const { match, index } of findAll(line, pattern)) all.push({ rule, match, index });
    }
  }
  all.sort(
    (a, b) =>
      b.match.length - a.match.length ||
      a.index - b.index ||
      RULE_ORDER.indexOf(a.rule) - RULE_ORDER.indexOf(b.rule),
  );
  const kept: Span[] = [];
  const taken = [...reserved];
  for (const s of all) {
    const end = s.index + s.match.length;
    if (taken.some(([from, to]) => s.index < to && from < end)) continue;
    taken.push([s.index, end]);
    kept.push(s);
  }
  return kept;
}

/** Where a known tool name sits on the line — claimed before any rule and never reported, the
 *  exemption class documented on `TOOL_NAME_PATTERNS` (ORB-210 item 3). Reserving the span, rather
 *  than relying on `_` happening to block a word boundary, is what makes it a decision. */
function toolNameSpans(line: string): Array<[number, number]> {
  return TOOL_NAME_PATTERNS.flatMap((p) =>
    findAll(line, p).map(({ match, index }): [number, number] => [index, index + match.length]),
  );
}

function scanLine(line: string, lineNumber: number, out: LintFinding[]): void {
  const seen = new Set<string>();
  const add = (rule: LintRule, match: string): void => {
    // Lowercased (ORB-210 item 5): every vocabulary pattern is case-INSENSITIVE, so "Notion" and
    // "notion" on one line are one finding about one word. A case-sensitive key reported it
    // twice, which reads as two separate leaks. The reported `match` keeps the first spelling
    // seen, so the message still quotes the text as written.
    const key = `${rule} ${match.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ rule, match, line: lineNumber });
  };

  // Tool names first: masked out of the line entirely, reported by nothing.
  let masked = line;
  const reserved = toolNameSpans(line);
  for (const [from, to] of reserved) masked = blank(masked, from, to - from);

  // Literal vocabulary, each hit masking its own span too so the structural person fallback below
  // cannot rebuild a candidate name out of words a rule has already accounted for.
  for (const s of literalSpans(line, reserved)) {
    add(s.rule, s.match);
    masked = blank(masked, s.index, s.match.length);
  }

  // Structural fallback for `person`: every ADJACENT pair of capitalised words, so three or more
  // capitalised words in a row (e.g. "Ask Ola Nordmann") still yield each overlapping pair — a
  // non-overlapping scan would consume "Ask Ola" and never test "Ola Nordmann" at all.
  const words = findAll(masked, CAPITALIZED_WORD);
  for (let i = 0; i + 1 < words.length; i++) {
    const a = words[i];
    const b = words[i + 1];
    const gap = masked.slice(a.index + a.match.length, b.index);
    if (!/^\s+$/.test(gap)) continue; // not textually adjacent — different clauses
    const phrase = masked.slice(a.index, b.index + b.match.length);
    if (STRUCTURAL_PERSON_ALLOWLIST.has(phrase.toLowerCase())) continue;
    if (isStopword(a.match) || isStopword(b.match)) continue;
    add("person", phrase);
  }
}

export function lintRole(roleMd: string): LintFinding[] {
  const findings: LintFinding[] = [];
  const lines = roleMd.split("\n");
  for (let i = 0; i < lines.length; i++) scanLine(lines[i], i + 1, findings);
  findings.sort((x, y) => x.line - y.line || RULE_ORDER.indexOf(x.rule) - RULE_ORDER.indexOf(y.rule));
  return findings;
}

export function assertRoleIsGeneric(roleMd: string, label: string): void {
  const findings = lintRole(roleMd);
  if (findings.length === 0) return;
  const detail = findings.map((f) => `line ${f.line}: ${f.rule} "${f.match}"`).join("\n");
  throw new Error(`${label}: this role isn't generic yet — remove the following before it can ship as a template:\n${detail}`);
}

// --- role text vs the tools that actually ship (ORB-210 item 3) --------------------------------
//
// A role template is generic about people and places but NOT about tools: `travel/role.md` tells
// the agent to call `place_link`, `nearby_places`, `strava_routes`, `shopping_add`,
// `shopping_remove` and `info` by name, `chief-of-staff/role.md` names `read_url`. Drop the grant
// behind one of those and the generated "where I run" section simply stops naming the tool while
// the role text keeps demanding it — an agent instructed, in the same file, to call something the
// same file says it does not have.
//
// TWO MECHANISMS WERE AVAILABLE and this is the one chosen: lint the role text against the tool
// set at assemble time, rather than extending keyed rules into the templates.
//
//   - Keyed blocks in role.md would need conditional markup inside a hand-written markdown file,
//     and would resolve a dropped grant by SILENTLY rendering less. The instruction that goes
//     missing is the interesting part, and nobody would be told it went.
//   - This check fails the assemble loudly, names the tool and the file, and makes "drop the
//     grant, edit role.md in the same change" — which templates/README.md already asks for in
//     prose — the only way through. `assemble-instructions.ts` already holds both halves (the
//     role text and `deployedToolsFor`), so it costs one assertion and no new file format.
//
// LIMIT, the same one `deployed-tools.ts` documents: the allowed set is a FILE listing, so a tool
// present as a `disableTool()` sentinel counts as shipped here. Each service's
// tests/agent-declaration.test.ts checks the committed instructions.md against what `eve build`
// actually compiled, and that is the authority.

/** A backticked span is read as a tool reference when it is shaped like one of the fleet's tool
 *  names: lowercase, optional `<extension>__` prefix, and either an underscore (the naming
 *  convention) or an exact match on a documented tool, so a backticked ordinary word like
 *  `inspiration/` or `[Attachment: …]` is left alone. */
const TOOL_REFERENCE = /^(?:[a-z0-9]+(?:-[a-z0-9]+)*__)?[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/u;
const KNOWN_TOOL_NAMES: ReadonlySet<string> = new Set(TOOL_NAMES);

/** Every tool this role text instructs the agent to call, in first-mention order. */
export function toolNamesIn(roleMd: string): string[] {
  const found = new Set<string>();
  for (const { match } of findAll(roleMd, /`([^`\n]+)`/u)) {
    const inner = match.slice(1, -1);
    if (!TOOL_REFERENCE.test(inner)) continue;
    if (!inner.includes("_") && !KNOWN_TOOL_NAMES.has(inner)) continue;
    found.add(inner);
  }
  return [...found];
}

/** Throws when the role text names a tool this agent does not ship. `allowed` is what it holds:
 *  the deployed tool files plus the framework tools its declaration keeps enabled. */
export function assertRoleToolsAreDeployed(roleMd: string, allowed: Iterable<string>, label: string): void {
  const have = new Set(allowed);
  const missing = toolNamesIn(roleMd).filter((t) => !have.has(t));
  if (missing.length === 0) return;
  throw new Error(
    `${label}: this role instructs the agent to call ${missing.map((t) => `\`${t}\``).join(", ")}, ` +
      `which this agent does not ship. Either grant the capability behind it, or edit the role text ` +
      `in the same change — the generated section would silently stop naming the tool while the role ` +
      `text kept demanding it.`,
  );
}
