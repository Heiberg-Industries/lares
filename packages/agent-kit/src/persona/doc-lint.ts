// lintCapabilityDocs() — the genericness lint, pointed at the ENGINE TEXT (ORB-210 item 1).
//
// `lintRole` proves a role template carries no person, company, vendor, place or language. Until
// now nothing proved the same of `CAPABILITY_DOCS`, even though those paragraphs render into
// EVERY agent's instructions.md and are therefore the text most likely to carry one owner's world
// into a second installation. `tests/persona-docs.test.ts` only asserted that tools exist, that a
// summary is longer than 40 characters, and that the string "Bendik" or "Heiberg" appears
// nowhere. The calendar doc said "the Orakel calendar" and shipped that into three personas; it
// was caught by a human rewriting the entry for another reason, not by a check.
//
// The docs are not role templates, so the same rules cannot apply unchanged: an adapter's whole
// job is to name the product it wraps, and an adapter whose coverage stops at a border has to say
// which border. What the lint does instead is license a finding ONLY against something the entry
// itself declares:
//
//   vendor           -> `vendor` (adapters) and `backedBy` (any kind), whole string, compound
//                       parts, and the individual words of each part.
//   place, language  -> the names of a country in `region.countries` (COUNTRY_TERMS).
//   everything else  -> never licensed. No person, no company, no address, no URL, no unlisted
//                       two-word proper name, in any entry, ever.
//
// The licensing is what makes this a ratchet rather than a rubber stamp: "the Orakel calendar"
// can only come back by adding `backedBy: ["Orakel"]` to the calendar entry, which is a line in a
// diff that a reader can see is wrong. A blanket "adapters may name vendors" exemption would have
// let the original bug straight through, since Orakel is itself an adapter's vendor.
//
// SCOPE: `summary` and `rules` — the text that renders. `region.reason` is declaration metadata
// that no persona ever sees (it explains a coverage decision to whoever reads the code), so it is
// deliberately not linted; it names Entur's geocoder and Norwegian places on purpose.
import { CAPABILITY_DOCS, type CapabilityDoc } from "./capability-docs.js";
import { lintRole, toolNamesIn, type LintFinding } from "./lint.js";
import { COUNTRY_TERMS, vendorParts } from "./overlay-vocabulary.js";

export interface DocLintFinding extends LintFinding {
  /** Which entry of `CAPABILITY_DOCS` the finding is in. */
  capability: string;
}

/** Every spelling of a vendor this entry is allowed to name, lowercased: the declared string, its
 *  compound parts, and each word of a part — so `vendor: "Google Places"` licenses "Google" and
 *  "Places" as well, which is right, because they are the same product. */
function licensedVendors(doc: CapabilityDoc): Set<string> {
  const out = new Set<string>();
  const declared: string[] = [];
  if (doc.kind === "adapter" && doc.vendor) declared.push(doc.vendor);
  declared.push(...(doc.backedBy ?? []));
  for (const name of declared) {
    out.add(name.toLowerCase());
    for (const part of vendorParts(name)) {
      out.add(part.toLowerCase());
      for (const word of part.split(/\s+/)) if (word) out.add(word.toLowerCase());
    }
  }
  return out;
}

/** The place/language words the entry's own declared coverage licenses. An entry with no region,
 *  or `"global"`, licenses none: a worldwide adapter has no border to name. */
function licensedCountryTerms(doc: CapabilityDoc): Set<string> {
  const out = new Set<string>();
  if (doc.kind !== "adapter" || !doc.region || doc.region === "global") return out;
  for (const code of doc.region.countries) {
    for (const term of COUNTRY_TERMS[code] ?? []) out.add(term.toLowerCase());
  }
  return out;
}

/** The rendering text of one entry, one string per line so a finding's line number points at a
 *  summary part (a string summary being one line) or at the nth rule after them. Every part and
 *  every rule is linted whether or not it renders anywhere today: a keyed sentence is text that
 *  WILL render on some installation, so it is held to the same bar. */
function docText(doc: CapabilityDoc): string {
  const summary = typeof doc.summary === "string" ? [doc.summary] : doc.summary.map((p) => (typeof p === "string" ? p : p.text));
  return [...summary, ...(doc.rules ?? []).map((r) => (typeof r === "string" ? r : r.text))].join("\n");
}

export function lintCapabilityDoc(doc: CapabilityDoc): DocLintFinding[] {
  const vendors = licensedVendors(doc);
  const countries = licensedCountryTerms(doc);
  return lintRole(docText(doc))
    .filter((f) => {
      const match = f.match.toLowerCase();
      if (f.rule === "vendor") return !vendors.has(match);
      if (f.rule === "place" || f.rule === "language") return !countries.has(match);
      return true;
    })
    .map((f) => ({ ...f, capability: doc.capability }));
}

export function lintCapabilityDocs(docs: Record<string, CapabilityDoc> = CAPABILITY_DOCS): DocLintFinding[] {
  return Object.values(docs).flatMap(lintCapabilityDoc);
}

/** Throws listing every finding, in the same shape `assertRoleIsGeneric` uses — so a doc that
 *  picked up someone's world fails the way a role template does, naming the entry to fix. */
export function assertCapabilityDocsAreGeneric(docs: Record<string, CapabilityDoc> = CAPABILITY_DOCS): void {
  const findings = lintCapabilityDocs(docs);
  if (findings.length === 0) return;
  const detail = findings
    .map((f) => `${f.capability} (line ${f.line}): ${f.rule} "${f.match}"`)
    .join("\n");
  throw new Error(
    "capability docs are not generic — every one of these renders into EVERY agent's " +
      "instructions.md. Reword it, or declare it on the entry (`backedBy` for a service the " +
      "tools genuinely call, `region.countries` for coverage):\n" +
      detail,
  );
}

// --- instruction skills (ORB-210 item 7) -------------------------------------------------------
//
// An instruction skill is an `agent/skills/<name>/SKILL.md` file eve loads on demand and appends verbatim to
// the turn. It is prose the model reads, exactly like a role template — and, exactly like a role
// template, it is the sort of thing that gets copied to a second installation with a role. Nothing
// held it to the role's bar: `sales-outreach.md` hard-coded the owner's two mailbox addresses and
// named him five times, and `market-edge.md` named him in its routing description.
//
// The one licence a skill gets, and it is derived from the skill's OWN text rather than declared
// anywhere: it may name the vendor of a capability whose tools it instructs the agent to call. A
// skill that says "call `agent-kit__market_edge`" may say "Polymarket"; one that says
// `gmail_send` may say "Gmail". That is the same licence the capability's own doc has, for the
// same reason — the adapter IS the vendor, and an installation without that vendor has no such
// capability and no reason to carry the skill. A vendor the skill calls no tool of is a finding.
//
// Everything else is unlicensed: no person, no company, no place, no language, no address, no
// URL. Those move to `voice.md`, which is the one hand-written file allowed to name the owner's
// world (templates/README.md § "Write `agent/voice.md`"), or become a runtime lookup — a mailbox
// list belongs to `identity_my_addresses`, not to a paragraph that goes stale in silence.

/** Frontmatter keys a SKILL.md may carry. `name` and `description` are eve's; everything else is
 *  a no-op in eve (its CHANGELOG records unmodeled keys being accepted and ignored), and a no-op
 *  that LOOKS like a permission is worse than nothing. */
export const SKILL_FRONTMATTER_KEYS = ["name", "description"] as const;

/** The refusal message for an `allowed-tools` frontmatter key, which would look like a permission
 *  but is not. A skill never widens what an agent may reach; it composes capabilities already
 *  granted and declared in agent.json. */
export const ALLOWED_TOOLS_REFUSAL =
  `allowed-tools pre-approves tools, which is the opposite of how this engine works: a skill ` +
  `composes capabilities its agent already holds and can never widen access. Declare what the skill ` +
  `needs in agent.json's skills[].requires, where the never-widen check can see it.`;

/** The key-value pairs in a markdown file's YAML frontmatter block, or an empty object when there
 *  is no block. Deliberately a small reader rather than a YAML dependency: the frontmatter here is
 *  declared keys only, and the assertion is about presence and validity. */
function frontmatterOf(md: string): Record<string, string> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/u.exec(md);
  if (!m) return {};
  const result: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const match = /^([\w-]+):\s*(.*)$/u.exec(line);
    if (match) {
      result[match[1]!] = match[2]!.trim();
    }
  }
  return result;
}

/** Count lines up to and including the end of the frontmatter block, for error reporting. */
function frontmatterEndLine(md: string): number {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/u.exec(md);
  if (!m) return 1;
  const lineCount = m[1]!.split(/\r?\n/).length;
  return lineCount + 2; // +1 for opening ---, +1 for closing ---
}

/** Findings in one instruction skill's markdown, licensing only the vendors of capabilities whose
 *  tools it names. Frontmatter is linted too: the `description:` line is model-visible text. */
export function lintInstructionSkill(markdown: string, _skillName?: string): LintFinding[] {
  const findings: LintFinding[] = [];

  // Check frontmatter keys
  const frontmatter = frontmatterOf(markdown);
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/u.exec(markdown);
  if (m) {
    const frontmatterLines = m[1]!.split(/\r?\n/);
    for (const key of Object.keys(frontmatter)) {
      if (!SKILL_FRONTMATTER_KEYS.includes(key as any)) {
        // Find the line number of this key
        const keyLine = frontmatterLines.findIndex((line) => line.startsWith(key + ":"));
        const lineNum = keyLine >= 0 ? keyLine + 2 : 2; // +2: 1 for opening ---, 1 for 1-based indexing
        const message = key === "allowed-tools" ? ALLOWED_TOOLS_REFUSAL : `unknown frontmatter key: ${key}`;
        findings.push({
          rule: "vendor", // reuse existing rule type
          match: key,
          line: lineNum,
          message,
        });
      }
    }
  }

  const named = new Set(toolNamesIn(markdown));
  const licensed = new Set<string>();
  for (const doc of Object.values(CAPABILITY_DOCS)) {
    if (!doc.tools.some((t) => named.has(t))) continue;
    for (const v of licensedVendors(doc)) licensed.add(v);
  }
  findings.push(
    ...lintRole(markdown).filter((f) => !(f.rule === "vendor" && licensed.has(f.match.toLowerCase()))),
  );
  return findings;
}

export function assertSkillIsGeneric(markdown: string, label: string): void {
  const findings = lintInstructionSkill(markdown);
  if (findings.length === 0) return;
  const detail = findings.map((f) => `line ${f.line}: ${f.rule} "${f.match}"`).join("\n");
  throw new Error(
    `${label}: this skill isn't generic yet — a skill travels with the role template it was ` +
      `written for, so it is held to the same bar. Move these to agent/voice.md, or replace them ` +
      `with a runtime lookup:\n${detail}`,
  );
}
