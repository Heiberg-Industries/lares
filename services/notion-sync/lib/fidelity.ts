// The fidelity gate (Phase 3 plan T2, spec §4.5/§18.3): the local, offline
// precondition for `enable-two-way` — no file's direction may flip to `two_way`
// until it round-trips push→pull byte-for-byte (mod normalizeForFidelity). Pure:
// no I/O, no vendor imports (neutrality.test.ts enforces); the vault walk and file
// reads are injected by the caller (lib/adapters/vault-files.ts on the real path).
//
// The round trip per file is: renderWikiPage -> assertPushSafe -> parseNotionPage
// -> assertPullSafe -> compare normalizeForFidelity(pulled.body) against the
// source's own body (frontmatter-stripped, edge-trimmed the same way
// renderWikiPage's output is). A throw at either safety rail fails the file with
// that rail's own message; a clean round trip that still differs byte-for-byte
// fails with a compact reason naming the first differing line.
//
// The wikilink resolver used here is neither the real store (T2 has no database
// dependency, on purpose — the gate must run offline, on a laptop, against a bare
// vault checkout) nor resolver-free (a resolver that always returns null would
// route every wikilink through escapeLiteral/unescapeLiteralPairs, which are exact
// inverses by construction and so could never catch translate-pull.ts's own
// documented gap: an aliased `[[target|alias]]` loses its alias text through the
// mention-page path, and "Files that relied on alias text fail the fidelity gate
// ... is exactly the gate's job"). So every target resolves, through a synthetic
// "echo" pair that carries the target through the mention tag's `url` attribute
// and reads it straight back out — self-contained, deterministic, and it exercises
// the SAME lossy path (bare wikilink, alias dropped) that the real store-backed
// resolver will use once a page actually exists.
import {
  renderWikiPage, assertPushSafe,
  type ResolvedWikiLink,
} from "./translate.js";
import {
  parseNotionPage, assertPullSafe, normalizeForFidelity,
  type ResolvedWikiTarget,
} from "./translate-pull.js";
// Straight from @lares/vault-format — the dependency-free package, not the role kit this
// service must never import (the sync-jobs image does not contain it).
import { originAfterWrite, readOriginFrontmatter } from "@lares/vault-format/origin";

export interface FidelityFileResult {
  path: string;
  passed: boolean;
  /** Absent when passed; present and human-readable when not. */
  reason?: string;
}

export interface FidelityFailure {
  path: string;
  reason: string;
}

export interface FidelityReport {
  /** Denominator recounted at run time (spec §18.3) — always `files.length`. */
  scanned: number;
  results: FidelityFileResult[];
}

export interface RunFidelityResult {
  passed: number;
  failed: FidelityFailure[];
  report: FidelityReport;
}

const ECHO_PREFIX = "fidelity-echo:";

/** Always resolves — see the file header for why an always-resolving pair, not a
 *  null one, is what actually exercises the gate's documented failure mode. */
function echoResolve(target: string): ResolvedWikiLink {
  return { url: `${ECHO_PREFIX}${encodeURIComponent(target)}`, title: target };
}

function echoResolvePage(urlOrId: string): ResolvedWikiTarget | null {
  if (!urlOrId.startsWith(ECHO_PREFIX)) return null;
  return { target: decodeURIComponent(urlOrId.slice(ECHO_PREFIX.length)) };
}

/**
 * Mirrors translate.ts's private splitFrontmatter plus renderWikiPage's own
 * blank-edge trim, independently — same deliberate non-import translate-pull.ts
 * itself uses ("the two files mirror each other's constants independently on
 * purpose, so a change to one is forced to be a deliberate, visible edit to
 * both"). This is what "the source's own body" is compared against.
 *
 * Exported (T7) for the gate's LIVE leg (spec §18.3): `notion-sync
 * enable-two-way` reverse-translates a page's real `GET /markdown` and compares
 * it to the vault file — and "the vault file" has to mean exactly what it means
 * here, or a file could pass the offline leg and fail the live one purely
 * because the two legs disagreed about, say, trailing blank lines.
 */
export function splitSource(source: string): { frontmatter: string; body: string } {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  let frontmatter = "";
  let bodyLines = lines;
  if (lines[0]?.trim() === "---") {
    for (let i = 1; i < lines.length; i += 1) {
      if (lines[i].trim() === "---") {
        frontmatter = lines.slice(1, i).join("\n");
        bodyLines = lines.slice(i + 1);
        break;
      }
    }
  }
  while (bodyLines.length > 0 && bodyLines[0].trim() === "") bodyLines = bodyLines.slice(1);
  while (bodyLines.length > 0 && bodyLines[bodyLines.length - 1].trim() === "") {
    bodyLines = bodyLines.slice(0, -1);
  }
  return { frontmatter, body: bodyLines.join("\n") };
}

/** First 1-indexed line at which `a` and `b` diverge. Only called once a !== b. */
function firstDiffLine(a: string, b: string): number {
  const linesA = a.split("\n");
  const linesB = b.split("\n");
  const max = Math.max(linesA.length, linesB.length);
  for (let i = 0; i < max; i += 1) {
    if (linesA[i] !== linesB[i]) return i + 1;
  }
  return max; // unreachable when a !== b, but a safe fallback rather than a throw.
}

function preview(text: string | undefined): string {
  const line = (text ?? "").trim();
  return line.length > 60 ? `${line.slice(0, 60)}…` : line;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Whether this file's frontmatter block CLOSES at different lines depending on which
 * rule reads it. This service's own splitters (splitSource above, pull-sync.ts's
 * splitFrontmatter, translate.ts's private one) all close a block on a line whose
 * trim() is exactly "---"; @lares/vault-format's readOriginFrontmatter and
 * upsertOriginFrontmatter close it on a line that merely startsWith("---") — so a
 * line like "----" ends the block for one reading and not the other. On such a file,
 * readOriginFrontmatter can report a stamp that the block this service will actually
 * preserve on write never contained (or vice versa) — the two disagree about which
 * bytes ARE the frontmatter, so the gate refuses rather than trust either guess.
 */
function frontmatterCloseDisagrees(source: string): boolean {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  if (lines[0]?.trim() !== "---") return false; // no block opens by either rule
  let trimClose = -1;
  let startsWithClose = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (trimClose === -1 && lines[i]!.trim() === "---") trimClose = i;
    if (startsWithClose === -1 && lines[i]!.startsWith("---")) startsWithClose = i;
  }
  return trimClose !== startsWithClose;
}

async function checkOne(
  path: string,
  readFile: (path: string) => Promise<string>,
): Promise<FidelityFileResult> {
  let source: string;
  try {
    source = await readFile(path);
  } catch (err) {
    return { path, passed: false, reason: `read failed: ${errorMessage(err)}` };
  }

  const { frontmatter: sourceFrontmatter, body: sourceBody } = splitSource(source);

  let renderedMarkdown: string;
  let renderedFrontmatter: string;
  try {
    const rendered = renderWikiPage(source, { path, resolve: echoResolve });
    assertPushSafe(rendered.markdown);
    renderedMarkdown = rendered.markdown;
    renderedFrontmatter = rendered.frontmatter;
  } catch (err) {
    return { path, passed: false, reason: errorMessage(err) };
  }

  let pulledBody: string;
  try {
    const pulled = parseNotionPage(renderedMarkdown, { resolvePage: echoResolvePage });
    assertPullSafe(pulled.body);
    pulledBody = pulled.body;
  } catch (err) {
    return { path, passed: false, reason: errorMessage(err) };
  }

  // Frontmatter travels as a Notion property, untranslated — it round-trips by
  // construction. Asserted anyway (spec brief: "assert anyway") because a
  // divergence here would mean renderWikiPage's own frontmatter split disagrees
  // with this file's independent mirror of it, which is a bug worth surfacing
  // loudly rather than silently trusting.
  if (renderedFrontmatter !== sourceFrontmatter) {
    return {
      path, passed: false,
      reason: "frontmatter did not survive verbatim (renderWikiPage split disagrees with the gate's own)",
    };
  }

  // WAVE-3-NOTES: readOriginFrontmatter and this file's own splitters can disagree
  // about where the frontmatter block ends (a "----" line). Refuse before trusting
  // either one's answer about the stamp.
  if (frontmatterCloseDisagrees(source)) {
    return {
      path, passed: false,
      reason: "this file's frontmatter block ends ambiguously (a line starting with \"---\" that " +
        "is not exactly \"---\") — refusing rather than guessing which stamp survives a pull",
    };
  }

  // ADR-0017 rule 9: the gate refuses a pull that would drop or downgrade a lares_*
  // stamp. What an approved pull actually writes is decided in lib/apply-sync.ts
  // (originAfterWrite of the file's own stamp and "synced"); this is the offline
  // prediction of that, so a document cannot be enabled for two-way sync in a state
  // where the first pull would lose its provenance. `undefined` covers three cases at
  // once — no block, no key, and a value that is not one of the five classes — and
  // all three are the same refusal for an owner.
  const stamp = readOriginFrontmatter(source);
  if (stamp === undefined) {
    return { path, passed: false, reason: "a pull would leave this file with no origin at all" };
  }
  const after = originAfterWrite(stamp, "synced");
  if (after !== stamp) {
    // Unreachable with today's originAfterWrite (it is narrowest, so it never
    // widens) — written anyway, because it is the property the gate exists to
    // assert and it must fail loudly if that function ever changes. Do not delete
    // this as dead code.
    return {
      path, passed: false,
      reason: `a pull would leave this file's origin as "${after}" instead of "${stamp}" — refusing rather than widening it`,
    };
  }

  const normalizedSource = normalizeForFidelity(sourceBody);
  const normalizedPulled = normalizeForFidelity(pulledBody);
  if (normalizedSource !== normalizedPulled) {
    const line = firstDiffLine(normalizedSource, normalizedPulled);
    const sourceLines = normalizedSource.split("\n");
    const pulledLines = normalizedPulled.split("\n");
    return {
      path, passed: false,
      reason: `body mismatch at line ${line}: source "${preview(sourceLines[line - 1])}" ` +
        `vs round-tripped "${preview(pulledLines[line - 1])}"`,
    };
  }

  return { path, passed: true };
}

/**
 * Runs the offline round trip over every given file, sorted for determinism
 * (mirrors runWikiSync's own `[...listWikiFiles()].sort()`). Per-file failures
 * never abort the batch — one bad file must not hide every other file's verdict.
 */
export async function runFidelity(
  files: string[],
  readFile: (path: string) => Promise<string>,
): Promise<RunFidelityResult> {
  const results: FidelityFileResult[] = [];
  const failed: FidelityFailure[] = [];
  let passed = 0;

  for (const path of [...files].sort()) {
    const outcome = await checkOne(path, readFile);
    results.push(outcome);
    if (outcome.passed) {
      passed += 1;
    } else {
      failed.push({ path, reason: outcome.reason ?? "unknown failure" });
    }
  }

  return { passed, failed, report: { scanned: files.length, results } };
}
