import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { renderWikiPage } from "../lib/translate.js";
import {
  parseNotionPage,
  assertPullSafe,
  normalizeForFidelity,
  type ResolvedWikiTarget,
  type ParseNotionPageOptions,
} from "../lib/translate-pull.js";
import { fixtureResolve, fixtureResolvePage, NESTED_TARGET_URL } from "./helpers/fixture-resolver.js";

const here = dirname(fileURLToPath(import.meta.url));

/** A resolver for unit tests: resolves nothing unless a map says otherwise. */
const none = (): ResolvedWikiTarget | null => null;
const mapResolver = (map: Record<string, ResolvedWikiTarget>) =>
  (urlOrId: string): ResolvedWikiTarget | null => map[urlOrId] ?? null;
/** Proves a code path never calls the resolver at all. */
const mustNotBeCalled = (): ResolvedWikiTarget | null => {
  throw new Error("resolvePage must not be called here");
};

type Resolver = ParseNotionPageOptions["resolvePage"];

const pull = (markdown: string, resolvePage: Resolver = none) => parseNotionPage(markdown, { resolvePage });

/** Strips frontmatter and edge-trims a vault source the same way translate.ts's
 *  splitFrontmatter + renderWikiPage's edge trim do, so round-trip comparisons are fair. */
function vaultBody(source: string): string {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  let body = lines;
  if (lines[0]?.trim() === "---") {
    for (let i = 1; i < lines.length; i += 1) {
      if (lines[i].trim() === "---") {
        body = lines.slice(i + 1);
        break;
      }
    }
  }
  while (body.length > 0 && body[0].trim() === "") body = body.slice(1);
  while (body.length > 0 && body[body.length - 1].trim() === "") body = body.slice(0, -1);
  return body.join("\n");
}

describe("unescaping — general prose (unescapeAngleOnly: only \\< is touched)", () => {
  it("unescapes autolink angle brackets", () => {
    expect(pull("see \\<https://example.com> and a\\<b").body).toBe(
      "see <https://example.com> and a<b",
    );
  });

  it("unescapes a fake escaped <mention-page> literal back to inert text, never calling the resolver", () => {
    const out = pull(
      '\\<mention-page url="https://x">fake\\</mention-page>',
      mustNotBeCalled,
    );
    expect(out.body).toBe('<mention-page url="https://x">fake</mention-page>');
    expect(out.warnings).toEqual([]);
  });

  it("leaves unescaped specials that were never touched by push (bold, table pipes) alone", () => {
    expect(pull("**bold** and | a table | cell |").body).toBe("**bold** and | a table | cell |");
  });

  // Push's escapeAngles never touches anything but `<` in ordinary prose, so an
  // author-written backslash-escape of ANY other special must survive a pull
  // completely byte-intact — stripping it would silently edit the author's text.
  it("leaves an author-escaped pipe inside a table row byte-intact", () => {
    const input = "| a \\| b | c |";
    expect(pull(input).body).toBe(input);
  });

  it("leaves author-escaped asterisks byte-intact", () => {
    const input = "a \\*literal\\* b";
    expect(pull(input).body).toBe(input);
  });

  it("leaves author-escaped $ and ^ byte-intact", () => {
    const input = "cost is 5\\$ and 3\\^2";
    expect(pull(input).body).toBe(input);
  });
});

describe("unescaping — escaped wikilink literals (unescapeLiteralPairs: left-to-right pairing)", () => {
  it("unescapes a bare escaped wikilink literal", () => {
    expect(pull("See \\[\\[missing\\]\\].").body).toBe("See [[missing]].");
  });

  it("unescapes an escaped pipe inside an aliased literal wikilink", () => {
    expect(pull("| \\[\\[missing\\|Miss\\]\\] |").body).toBe("| [[missing|Miss]] |");
  });

  it("un-doubles a literal backslash inside the wikilink target", () => {
    // Pushed by escapeLiteral: the raw `[[a\b]]` becomes `\[\[a\\b\]\]` (the
    // literal backslash in "a\b" is itself a NOTION_SPECIAL, so it doubles).
    // Parity-based unescaping would get this wrong; pairing gets it right.
    const pushed = renderWikiPage("see [[a\\b]] here", { path: "n.md", resolve: () => null }).markdown;
    expect(pushed).toBe("see \\[\\[a\\\\b\\]\\] here");
    expect(pull(pushed).body).toBe("see [[a\\b]] here");
  });
});

describe("callouts (reverse of translate.ts's CALLOUT_STYLE map)", () => {
  const cases: Array<[string, string, string]> = [
    ["summary", "💡", "blue"],
    ["quote", "💬", "gray"],
    ["warning", "⚠️", "yellow"],
    ["important", "❗", "red"],
    ["todo", "☑️", "green"],
  ];

  for (const [type, icon, color] of cases) {
    it(`maps icon "${icon}"/color "${color}" back to [!${type}]`, () => {
      const out = pull(`<callout icon="${icon}" color="${color}">\n\tBody\n</callout>`);
      expect(out.body).toBe(`> [!${type}]\n> Body`);
      expect(out.warnings).toEqual([]);
    });
  }

  it("splits a <br>-joined body into separate quote lines", () => {
    const out = pull('<callout icon="💡" color="blue">\n\tLine one<br>Line two\n</callout>');
    expect(out.body).toBe("> [!summary]\n> Line one\n> Line two");
  });

  it("reconstructs an empty-body callout as the marker line alone", () => {
    const out = pull('<callout icon="💡" color="blue">\n</callout>');
    expect(out.body).toBe("> [!summary]");
  });

  it("renders an unrecognised icon/color pair as [!note] with a warning", () => {
    const out = pull('<callout icon="📝" color="gray">\n\tx\n</callout>');
    expect(out.body).toBe("> [!note]\n> x");
    expect(out.warnings).toEqual([
      'unknown callout icon/color ("📝", "gray") (line 1) — rendered as [!note]',
    ]);
  });

  it("unescapes and resolves mentions inside a callout body", () => {
    const resolve = mapResolver({ "https://www.notion.so/abc": { target: "target" } });
    const out = pull(
      '<callout icon="💡" color="blue">\n\tSee <mention-page url="https://www.notion.so/abc">Target</mention-page>.\n</callout>',
      resolve,
    );
    expect(out.body).toBe("> [!summary]\n> See [[target]].");
  });
});

describe("quotes", () => {
  it("splits a <br>-joined plain quote into separate quote lines", () => {
    expect(pull("> a<br>b<br>c").body).toBe("> a\n> b\n> c");
  });

  it("leaves a single-line quote with no <br> as one quote line", () => {
    expect(pull("> a single line").body).toBe("> a single line");
  });
});

describe("mentions (spec §4.1)", () => {
  it("emits the resolver's target verbatim inside [[...]]", () => {
    const resolve = mapResolver({
      "https://www.notion.so/1234": { target: "known" },
    });
    const out = pull(
      'See <mention-page url="https://www.notion.so/1234">Known Page</mention-page> here.',
      resolve,
    );
    expect(out.body).toBe("See [[known]] here.");
    expect(out.warnings).toEqual([]);
  });

  it("emits a directory-qualified target exactly as the resolver returns it — target derivation is the caller's job", () => {
    const resolve = mapResolver({
      "https://www.notion.so/5678": { target: "people/jane" },
    });
    const out = pull('<mention-page url="https://www.notion.so/5678">Jane</mention-page>', resolve);
    expect(out.body).toBe("[[people/jane]]");
  });

  it("resolves via id= the same way it resolves via url=", () => {
    const resolve = mapResolver({ "page-id-123": { target: "known" } });
    const out = pull('<mention-page id="page-id-123">Known Page</mention-page>', resolve);
    expect(out.body).toBe("[[known]]");
  });

  it("keeps the visible title as plain text and warns when the resolver returns null (never invents a link)", () => {
    const out = pull(
      'See <mention-page url="https://www.notion.so/dead">Ghost Page</mention-page> here.',
      () => null,
    );
    expect(out.body).toBe("See Ghost Page here.");
    expect(out.warnings).toEqual([
      'unresolved mention-page (line 1) — kept "Ghost Page" as plain text',
    ]);
  });

  it("processes a mention inside a table cell", () => {
    const resolve = mapResolver({ "https://www.notion.so/1234": { target: "known" } });
    const out = pull('| <mention-page url="https://www.notion.so/1234">K</mention-page> — x |', resolve);
    expect(out.body).toBe("| [[known]] — x |");
  });

  it("uses the shared fixture resolver's nested entry (representative of the 'else full path' case)", () => {
    const out = pull(`<mention-page url="${NESTED_TARGET_URL}">Jane</mention-page>`, fixtureResolvePage);
    expect(out.body).toBe("[[people/jane]]");
  });
});

describe("mention-database and unknown tags", () => {
  it("turns a mention-database into its plain-text label with a warning", () => {
    const out = pull(
      'See <mention-database url="https://www.notion.so/db1">My Database</mention-database> for details.',
    );
    expect(out.body).toBe("See My Database for details.");
    expect(out.warnings).toEqual([
      'unsupported <mention-database> (line 1) — kept "My Database" as plain text',
    ]);
  });

  it("turns an unrecognised paired tag into its plain-text label with a warning", () => {
    const out = pull('A <highlight color="pink">note</highlight> here.');
    expect(out.body).toBe("A note here.");
    expect(out.warnings).toEqual([
      'unsupported <highlight> (line 1) — kept "note" as plain text',
    ]);
  });
});

describe("<empty-block/>", () => {
  it("becomes a blank line", () => {
    expect(pull("Para one.\n<empty-block/>\nPara two.").body).toBe("Para one.\n\nPara two.");
  });

  it("alone renders as an empty body", () => {
    expect(pull("<empty-block/>").body).toBe("");
  });

  // The empty block IS the separation — the block-boundary rule must not add a
  // second blank line beside it, or every Notion-authored empty paragraph would
  // grow a gap on every pull.
  it("does not stack with the block separator", () => {
    expect(pull("Para one.\n<empty-block/>\n<empty-block/>\nPara two.").body).toBe(
      "Para one.\n\n\nPara two.",
    );
  });
});

// Notion's GET /markdown joins top-level blocks with a SINGLE "\n" — every blank
// line between blocks is gone by the time we see it (verified live 2026-08-04,
// see the file header). These are the boundaries where the reconstruction has to
// put one back.
describe("block boundaries — one blank line between top-level blocks", () => {
  const cases: Array<[string, string, string]> = [
    ["heading → paragraph", "# Title\nProse.", "# Title\n\nProse."],
    ["paragraph → heading", "Prose.\n## Section", "Prose.\n\n## Section"],
    ["heading → heading", "# One\n## Two", "# One\n\n## Two"],
    ["paragraph → paragraph", "First block.\nSecond block.", "First block.\n\nSecond block."],
    ["paragraph → list", "Prose.\n- one", "Prose.\n\n- one"],
    ["list → paragraph", "- one\nProse.", "- one\n\nProse."],
    ["ordered list → paragraph", "1. one\nProse.", "1. one\n\nProse."],
    ["paragraph → table", "Prose.\n| a | b |", "Prose.\n\n| a | b |"],
    ["table → paragraph", "| a | b |\nProse.", "| a | b |\n\nProse."],
    ["paragraph → quote", "Prose.\n> quoted", "Prose.\n\n> quoted"],
    ["quote → paragraph", "> quoted\nProse.", "> quoted\n\nProse."],
    ["paragraph → fence", "Prose.\n```\ncode\n```", "Prose.\n\n```\ncode\n```"],
    ["fence → paragraph", "```\ncode\n```\nProse.", "```\ncode\n```\n\nProse."],
    ["fence → fence", "```\na\n```\n```\nb\n```", "```\na\n```\n\n```\nb\n```"],
  ];

  for (const [name, input, expected] of cases) {
    it(`${name}`, () => {
      expect(pull(input).body).toBe(expected);
    });
  }

  it("callout → paragraph", () => {
    expect(pull('<callout icon="💡" color="blue">\n\tNote.\n</callout>\nProse.').body).toBe(
      "> [!summary]\n> Note.\n\nProse.",
    );
  });

  it("paragraph → callout", () => {
    expect(pull('Prose.\n<callout icon="💡" color="blue">\n\tNote.\n</callout>').body).toBe(
      "Prose.\n\n> [!summary]\n> Note.",
    );
  });
});

// A separator inserted between a paragraph and its own setext underline would
// silently turn a heading into "paragraph + stray line / thematic break" — and
// with blank lines normalised away, the gate could never see it.
describe("setext headings (the underline belongs to the line above it)", () => {
  it("keeps a setext H1 underline tight", () => {
    expect(pull("Heading text\n====\nProse.").body).toBe("Heading text\n====\n\nProse.");
  });

  it("keeps a setext H2 underline tight", () => {
    expect(pull("Heading text\n---\nProse.").body).toBe("Heading text\n---\n\nProse.");
  });

  // The vault's writing-seed files carry a second `---`-fenced block in the
  // body. Its closing `---` sits directly under a plain line, so it IS a setext
  // underline and has to stay welded to it. The lines above it are adjacent
  // paragraphs and do get separated — the accepted, documented cost — but the
  // heading/thematic-break flip does not happen.
  it("keeps the writing-seed block's closing --- welded to the line above it", () => {
    const tight = ["---", "title: Seed — x", "type: writing-seed", "---", "Prose after."].join("\n");
    expect(pull(tight).body).toBe(
      ["---", "", "title: Seed — x", "", "type: writing-seed", "---", "", "Prose after."].join("\n"),
    );
  });

  it("treats a --- that opens the body as a thematic break, not an underline", () => {
    expect(pull("---\nFirst line.").body).toBe("---\n\nFirst line.");
  });

  it("treats a --- after a blank line as a thematic break, separated normally", () => {
    expect(pull("Prose.\n\n---\n\nMore prose.").body).toBe("Prose.\n\n---\n\nMore prose.");
  });

  it("does not turn a --- under a list item or a quote into an underline", () => {
    expect(pull("- item\n---").body).toBe("- item\n\n---");
    expect(pull("> quoted\n---").body).toBe("> quoted\n\n---");
  });

  it("does not chain: a second --- under an underline is its own block", () => {
    expect(pull("Heading text\n---\n---").body).toBe("Heading text\n---\n\n---");
  });
});

// An indented code block welded to the paragraph above it stops being code and
// becomes a lazy continuation of that paragraph — a rendering change, not a
// spacing one.
describe("indented code blocks", () => {
  it("keeps an indented code block separate from the paragraph above it", () => {
    const body = "Prose.\n\n    code line\n    more code\n\nAfter.";
    expect(pull(body).body).toBe(body);
  });

  it("keeps a blank line inside an indented code block", () => {
    const body = "Prose.\n\n    first\n\n    second\n\nAfter.";
    expect(pull(body).body).toBe(body);
  });

  it("still treats a deep indent under a list item as that item's continuation", () => {
    expect(pull("- item\n\n    continuation of the item").body).toBe(
      "- item\n    continuation of the item",
    );
  });

  it("cannot invent one from Notion's shape, where the blank line is gone", () => {
    // No blank in the input → the indented line is a continuation, as before.
    expect(pull("Prose.\n    indented").body).toBe("Prose.\n    indented");
  });
});

// Two tables that merge into one are a data-shape corruption: the second table's
// delimiter row becomes a data row of the first.
describe("adjacent tables stay two tables", () => {
  it("splits a new table at its delimiter row", () => {
    const input = "| a | b |\n| --- | --- |\n| 1 | 2 |\n| c | d |\n| --- | --- |\n| 3 | 4 |";
    expect(pull(input).body).toBe(
      "| a | b |\n| --- | --- |\n| 1 | 2 |\n\n| c | d |\n| --- | --- |\n| 3 | 4 |",
    );
  });

  it("keeps one long table as one table", () => {
    const input = "| a | b |\n| :-- | --: |\n| 1 | 2 |\n| 3 | 4 |\n| 5 | 6 |";
    expect(pull(input).body).toBe(input);
  });
});

describe("compound blocks stay tight (a blank line there would split them)", () => {
  it("keeps consecutive list items adjacent", () => {
    expect(pull("- one\n- two\n- three").body).toBe("- one\n- two\n- three");
  });

  it("keeps consecutive ordered list items adjacent", () => {
    expect(pull("1. one\n2. two").body).toBe("1. one\n2. two");
  });

  it("keeps an indented nested list item with its parent", () => {
    expect(pull("- one\n\t- nested\n- two").body).toBe("- one\n\t- nested\n- two");
  });

  it("keeps an indented continuation line with the block above it", () => {
    expect(pull("- one\n  continued\n- two").body).toBe("- one\n  continued\n- two");
  });

  it("keeps consecutive table rows adjacent", () => {
    expect(pull("| a | b |\n| --- | --- |\n| 1 | 2 |").body).toBe(
      "| a | b |\n| --- | --- |\n| 1 | 2 |",
    );
  });

  it("keeps a <br>-split quote body on adjacent lines (one Notion block)", () => {
    expect(pull("> a<br>b<br>c").body).toBe("> a\n> b\n> c");
  });

  it("keeps a <br>-split callout body on adjacent lines (one Notion block)", () => {
    expect(pull('<callout icon="💡" color="blue">\n\tLine one<br>Line two\n</callout>').body).toBe(
      "> [!summary]\n> Line one\n> Line two",
    );
  });

  it("separates two quote BLOCKS (two Notion blocks) with a blank line", () => {
    expect(pull("> first quote\n> second quote").body).toBe("> first quote\n\n> second quote");
  });

  it("leaves fenced content verbatim, blank lines included", () => {
    const input = "```py\ndef a():\n    pass\n\n\ndef b():\n    pass\n```";
    expect(pull(input).body).toBe(input);
  });
});

// The whole point of the rule: our own render separates blocks with a blank line,
// Notion's serialiser separates them with nothing. Both must land on the same
// canonical body, or the offline fidelity leg and the live one can never agree.
describe("one canonical output shape from both input shapes", () => {
  const SAMPLES = [
    "# Title\n\nProse.\n\n- one\n- two\n\n> [!summary]\n> Note.",
    "Prose.\n\n| a | b |\n| --- | --- |\n\nMore prose.",
    "# Title\n\n```\ncode\n\nstill code\n```\n\nAfter.",
  ];

  for (const [i, spaced] of SAMPLES.entries()) {
    it(`sample ${i + 1}: Notion's single-\\n shape parses to the same body as our blank-separated shape`, () => {
      // What Notion gives back: every separator blank line stripped, fences intact.
      const tight: string[] = [];
      let inFence = false;
      for (const line of spaced.split("\n")) {
        if (/^ {0,3}(```|~~~)/.test(line)) {
          inFence = !inFence;
          tight.push(line);
          continue;
        }
        if (!inFence && line.trim() === "") continue;
        tight.push(line);
      }
      expect(pull(tight.join("\n")).body).toBe(pull(spaced).body);
    });
  }
});

// The deploy probe that found this (Phase 3 live leg, 2026-08-04): the exact
// bytes GET /v1/pages/:id/markdown returned for a page pushed from a
// conventionally formatted vault file, and the exact vault body it must
// reconstruct. Frontmatter travels as a Notion property, so it is not in either.
describe("deploy probe 2026-08-04 — GET /markdown of the scratch probe page", () => {
  const LIVE_MARKDOWN =
    '# Probe note\nA desk probe file for the Phase 3 scratch proof.\n- one list item\n' +
    '- two list items\n<callout icon="💡" color="blue">\n\tA callout that must round-trip.\n</callout>';

  const VAULT_BODY = [
    "# Probe note",
    "",
    "A desk probe file for the Phase 3 scratch proof.",
    "",
    "- one list item",
    "- two list items",
    "",
    "> [!summary]",
    "> A callout that must round-trip.",
  ].join("\n");

  it("reconstructs the vault body exactly", () => {
    const out = pull(LIVE_MARKDOWN);
    expect(out.body).toBe(VAULT_BODY);
    expect(out.warnings).toEqual([]);
  });

  it("passes the fidelity comparison against the vault body", () => {
    expect(normalizeForFidelity(pull(LIVE_MARKDOWN).body)).toBe(normalizeForFidelity(VAULT_BODY));
  });
});

describe("code fences and inline code spans (verbatim, per spec — escapes never applied there)", () => {
  it("passes a fenced block through untouched, including anything that looks escaped or tag-like", () => {
    const input = '```\n<mention-page url="https://x">T</mention-page>\n\\[\\[escaped\\]\\]\n```';
    expect(pull(input).body).toBe(input);
  });

  it("passes an inline code span through untouched", () => {
    expect(pull("run `lares \\[\\[x\\]\\]` now").body).toBe("run `lares \\[\\[x\\]\\]` now");
  });
});

describe("determinism", () => {
  it("parsing the same source twice yields identical results", () => {
    const source = readFileSync(join(here, "fixtures/wiki-expected/camera-not-an-engine.md"), "utf8");
    const a = parseNotionPage(source, { resolvePage: fixtureResolvePage });
    const b = parseNotionPage(source, { resolvePage: fixtureResolvePage });
    expect(a).toEqual(b);
  });
});

describe("assertPullSafe", () => {
  it("throws on a secure.notion-static.com URL", () => {
    expect(() =>
      assertPullSafe("see the file at https://secure.notion-static.com/abc/file.png"),
    ).toThrow(/notion-static/);
  });

  it("throws on a file.notion.so URL", () => {
    expect(() => assertPullSafe("https://file.notion.so/f/xyz/doc.pdf")).toThrow(/file\.notion\.so/);
  });

  it("throws on an X-Amz- signed query param", () => {
    expect(() =>
      assertPullSafe("https://example.com/f.png?X-Amz-Signature=abc&X-Amz-Expires=3600"),
    ).toThrow(/X-Amz-|expiring/);
  });

  it("throws on a live <transcript block, case-insensitively", () => {
    expect(() => assertPullSafe("before <transcript>content</transcript> after")).toThrow(
      /transcript/,
    );
    expect(() => assertPullSafe("<TRANSCRIPT id=\"1\">x</TRANSCRIPT>")).toThrow(/transcript/i);
  });

  it("throws with the offending line number", () => {
    expect(() => assertPullSafe("line one\nline two\n<transcript>x</transcript>")).toThrow(
      /line 3/,
    );
  });

  it("does not throw on ordinary pushed markdown", () => {
    const safe = [
      "plain prose with **bold** and a table | a | b |",
      '<mention-page url="https://www.notion.so/1234">Title</mention-page>',
      '<callout icon="💡" color="blue">\n\tx\n</callout>',
      "\\[\\[escaped\\]\\] wikilink literal",
    ];
    for (const markdown of safe) {
      expect(() => assertPullSafe(markdown), `markdown: ${markdown}`).not.toThrow();
    }
  });

  // Finding 2: pull over-blocking is sticky (freezes a row permanently), so
  // both checks must be precise, not just parity-blind mirrors of push's.
  it("does not throw on prose mentioning <transcript> that push already escaped to inert text", () => {
    const pushed = renderWikiPage("a <transcript> tag, mentioned in prose", {
      path: "n.md",
      resolve: () => null,
    }).markdown;
    expect(pushed).toBe("a \\<transcript> tag, mentioned in prose");
    expect(() => assertPullSafe(pushed)).not.toThrow();
  });

  it("does not throw on an expiring-URL-shaped string inside a code fence", () => {
    const input = "```\ncurl 'https://x/?X-Amz-Signature=abc'\n```";
    expect(() => assertPullSafe(input)).not.toThrow();
  });

  it("does not throw on an expiring-URL-shaped string inside an inline code span", () => {
    const input = "see `https://x/?X-Amz-Signature=abc` for the sample request";
    expect(() => assertPullSafe(input)).not.toThrow();
  });

  it("still throws on a live <transcript> tag even when other text on the line is escaped", () => {
    expect(() => assertPullSafe("\\<page> then a live <transcript>x</transcript>")).toThrow(
      /transcript/,
    );
  });

  it("still throws on a bare X-Amz- image URL outside any code", () => {
    expect(() =>
      assertPullSafe("![img](https://secure.notion-static.com/f.png?X-Amz-Signature=abc)"),
    ).toThrow(/notion-static|expiring/);
  });
});

describe("normalizeForFidelity", () => {
  it("strips trailing whitespace per line", () => {
    expect(normalizeForFidelity("first line   \nsecond line\t \n")).toBe("first line\nsecond line");
  });

  // Named fidelity loss (see the file header): Notion destroys blank lines
  // between blocks, so the gate cannot see them on either side.
  it("drops blank lines between blocks, however many", () => {
    expect(normalizeForFidelity(["a", "", "b"].join("\n"))).toBe("a\nb");
    expect(normalizeForFidelity(["a", "", "", "b"].join("\n"))).toBe("a\nb");
    expect(normalizeForFidelity(["a", "", "", "", "", "b"].join("\n"))).toBe("a\nb");
  });

  it("makes the two block-separation conventions compare equal", () => {
    expect(normalizeForFidelity("# Title\n\n- one\n- two")).toBe(
      normalizeForFidelity("# Title\n- one\n- two"),
    );
  });

  // Rule 4: the blank lines that carry block structure stay, so the two
  // documents they distinguish never compare equal.
  it("keeps the blank line that makes a --- a thematic break, not a setext underline", () => {
    const thematicBreak = "Prose.\n\n---\n\nMore.";
    const setextHeading = "Prose.\n---\n\nMore.";
    expect(normalizeForFidelity(thematicBreak)).toBe("Prose.\n\n---\nMore.");
    expect(normalizeForFidelity(thematicBreak)).not.toBe(normalizeForFidelity(setextHeading));
  });

  it("keeps the blank line that makes an indented line code, not a lazy continuation", () => {
    expect(normalizeForFidelity("Prose.\n\n    code")).not.toBe(
      normalizeForFidelity("Prose.\n    code"),
    );
  });

  it("does not keep a blank before an indented line that continues a list item", () => {
    expect(normalizeForFidelity("- item\n\n    continuation")).toBe(
      normalizeForFidelity("- item\n    continuation"),
    );
  });

  it("keeps blank lines INSIDE a fenced code block — that is content, not spacing", () => {
    const input = "```\na\n\n\nb\n```";
    expect(normalizeForFidelity(input)).toBe(input);
  });

  it("still sees a content difference inside a fence", () => {
    expect(normalizeForFidelity("```\na\n\nb\n```")).not.toBe(normalizeForFidelity("```\na\nb\n```"));
  });

  it("trims blank edges so a trailing newline is not a difference", () => {
    expect(normalizeForFidelity("\n\na\n\n")).toBe("a");
  });

  it("normalises CRLF to LF", () => {
    expect(normalizeForFidelity("a\r\nb\r\n")).toBe("a\nb");
  });
});

describe("round-trip against real Phase 2 fixtures", () => {
  // Fixtures whose vault source uses only BARE wikilinks (no `|alias`) and callouts
  // with no inline title — the two push-side constructs that lose information on
  // the way to Notion (alias text; title-vs-first-body-line) and so can never
  // byte-round-trip. aina-lemoen-lunde.md / adnuntius.md hit both and are
  // deliberately excluded — that gap is exactly what the fidelity gate (T4) exists
  // to catch, not something this pure translator can paper over.
  const ROUND_TRIP_FIXTURES = [
    "README.md",
    "writing.md",
    "agent-loops-design.md",
    "camera-not-an-engine.md",
    "claude-code-meetup-external-brain.md",
  ];

  for (const rel of ROUND_TRIP_FIXTURES) {
    it(`${rel}: parseNotionPage(renderWikiPage(source)) reconstructs the original body`, () => {
      const source = readFileSync(join(here, "fixtures/wiki", rel), "utf8");
      const pushed = renderWikiPage(source, { path: rel, resolve: fixtureResolve }).markdown;
      const pulled = parseNotionPage(pushed, { resolvePage: fixtureResolvePage });
      expect(normalizeForFidelity(pulled.body)).toBe(normalizeForFidelity(vaultBody(source)));
      expect(pulled.warnings).toEqual([]);
    });

    // normalizeForFidelity can no longer see block spacing, so the assertion
    // above would survive a parser that mangled it. This one cannot: once an
    // applied body is back in the vault, the NEXT push→pull cycle must return
    // it byte for byte. Canonical output has to be a fixed point of that cycle
    // (push→pull, not parse alone — a pulled body is Obsidian-flavoured, and it
    // is renderWikiPage's job to turn it back into Notion's dialect), or every
    // tick would rewrite the file again.
    it(`${rel}: the reconstructed body is a byte-exact fixed point of push→pull`, () => {
      const source = readFileSync(join(here, "fixtures/wiki", rel), "utf8");
      const cycle = (body: string): string => parseNotionPage(
        renderWikiPage(body, { path: rel, resolve: fixtureResolve }).markdown,
        { resolvePage: fixtureResolvePage },
      ).body;
      const once = cycle(source);
      expect(cycle(once)).toBe(once);
    });
  }
});

// The real fixtures are vault files, and the vault mixes both block-spacing
// conventions — so none of them is byte-identical through the round trip, and
// the assertions above lean on normalizeForFidelity. This one does not: a
// conventionally formatted document carrying every construct must come back
// byte for byte, with no normalisation anywhere near the comparison.
describe("byte-identical round trip for a canonically formatted document", () => {
  const CANONICAL = [
    "# Title",
    "",
    "A first paragraph.",
    "",
    "A second paragraph.",
    "",
    "## Section",
    "",
    "- one",
    "- two",
    "\t- nested",
    "",
    "1. first",
    "2. second",
    "",
    "| a | b |",
    "| --- | --- |",
    "| 1 | 2 |",
    "",
    "> [!summary]",
    "> A callout body.",
    "",
    "> A plain quote.",
    "",
    "```ts",
    "const x = 1;",
    "",
    "const y = 2;",
    "```",
    "",
    "Closing paragraph.",
  ].join("\n");

  const source = `---\ntitle: Canonical\n---\n\n${CANONICAL}\n`;
  const pushed = (): string =>
    renderWikiPage(source, { path: "canonical.md", resolve: () => null }).markdown;

  it("survives render → parse unchanged", () => {
    expect(parseNotionPage(pushed(), { resolvePage: () => null }).body).toBe(CANONICAL);
  });

  // The same render with every separator blank line stripped — what Notion's
  // serialiser actually hands back (fences untouched).
  it("survives Notion's own single-\\n shape unchanged", () => {
    const tight: string[] = [];
    let inFence = false;
    for (const line of pushed().split("\n")) {
      if (/^ {0,3}(```|~~~)/.test(line)) { inFence = !inFence; tight.push(line); continue; }
      if (!inFence && line === "") continue;
      tight.push(line);
    }
    expect(parseNotionPage(tight.join("\n"), { resolvePage: () => null }).body).toBe(CANONICAL);
  });
});
