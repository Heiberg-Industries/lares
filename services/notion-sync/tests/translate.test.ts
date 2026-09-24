import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  renderWikiPage, assertPushSafe, assertPushSafeSource, type ResolvedWikiLink,
} from "../lib/translate.js";
import { fixtureResolve } from "./helpers/fixture-resolver.js";

const here = dirname(fileURLToPath(import.meta.url));

/** A resolver for unit tests: resolves nothing unless a map says otherwise. */
const none = (): ResolvedWikiLink | null => null;
const mapResolver = (map: Record<string, ResolvedWikiLink>) =>
  (target: string): ResolvedWikiLink | null => map[target] ?? null;

const render = (source: string, path = "note.md", resolve = none) =>
  renderWikiPage(source, { path, resolve });

describe("frontmatter", () => {
  it("strips the frontmatter block and preserves its inner text verbatim", () => {
    const out = render('---\ntitle: "T"\ntags: [a, b]\nweird:   spacing kept \n---\nBody line');
    expect(out.frontmatter).toBe('title: "T"\ntags: [a, b]\nweird:   spacing kept ');
    expect(out.markdown).toBe("Body line");
  });

  it("returns empty frontmatter when there is none", () => {
    const out = render("# Hello\ntext");
    expect(out.frontmatter).toBe("");
    expect(out.markdown).toBe("# Hello\ntext");
  });

  it("treats an unclosed frontmatter fence as body, not as frontmatter", () => {
    const out = render("---\ntitle: x\nno closing fence");
    expect(out.frontmatter).toBe("");
    // The stray `---` stays in the body (it renders as a divider, which is honest).
    expect(out.markdown).toContain("title: x");
  });
});

describe("title extraction (plan decision 4)", () => {
  it("prefers the frontmatter title, stripping surrounding quotes", () => {
    expect(render('---\ntitle: "Quoted Title"\n---\n# H1 Title\n').title).toBe("Quoted Title");
    expect(render("---\ntitle: 'Single'\n---\nx").title).toBe("Single");
    expect(render("---\ntitle: Bare title\n---\nx").title).toBe("Bare title");
  });

  it("falls back to the first H1", () => {
    expect(render("intro\n# The H1\n## not this").title).toBe("The H1");
  });

  it("falls back to the filename stem when there is no frontmatter title and no H1", () => {
    expect(render("just text", "notes/some-page.md").title).toBe("some-page");
    expect(render("---\ntype: person\n---\njust text", "some-page.md").title).toBe("some-page");
  });

  it("ignores an H1 inside a code fence", () => {
    expect(render("```\n# not a heading\n```\ntext", "stem-case.md").title).toBe("stem-case");
  });
});

describe("folderHint", () => {
  it("is the directory part of the path, undefined at the root", () => {
    expect(render("x", "people/jane.md").folderHint).toBe("people");
    expect(render("x", "a/b/c.md").folderHint).toBe("a/b");
    expect(render("x", "README.md").folderHint).toBeUndefined();
  });
});

describe("callouts (spec §4.1 map)", () => {
  it("renders a multi-line summary callout with <br>-joined body", () => {
    const out = render("> [!summary]\n> Line one\n> Line two");
    expect(out.markdown).toBe('<callout icon="💡" color="blue">\n\tLine one<br>Line two\n</callout>');
  });

  it("maps all five callout types to their icon and color", () => {
    const cases: Array<[string, string, string]> = [
      ["summary", "💡", "blue"],
      ["quote", "💬", "gray"],
      ["warning", "⚠️", "yellow"],
      ["important", "❗", "red"],
      ["todo", "☑️", "green"],
    ];
    for (const [type, icon, color] of cases) {
      const out = render(`> [!${type}]\n> Body`);
      expect(out.markdown).toBe(`<callout icon="${icon}" color="${color}">\n\tBody\n</callout>`);
      expect(out.warnings).toEqual([]);
    }
  });

  it("puts an inline title on the marker line first in the body", () => {
    const out = render("> [!summary] The gist.\n> And more.");
    expect(out.markdown).toBe('<callout icon="💡" color="blue">\n\tThe gist.<br>And more.\n</callout>');
  });

  it("normalises blank quote lines out of the callout body", () => {
    const out = render("> [!warning]\n> para one\n>\n> para two");
    expect(out.markdown).toBe('<callout icon="⚠️" color="yellow">\n\tpara one<br>para two\n</callout>');
  });

  it("renders an unknown callout type with the default icon/color and a warning", () => {
    const out = render("> [!note]\n> x");
    expect(out.markdown).toBe('<callout icon="📝" color="gray">\n\tx\n</callout>');
    expect(out.warnings).toEqual(['unknown callout type "note" (line 1) — rendered with default icon/color']);
  });

  it("accepts the Obsidian fold markers [!type]- and [!type]+", () => {
    const out = render("> [!summary]- folded\n> body");
    expect(out.markdown).toBe('<callout icon="💡" color="blue">\n\tfolded<br>body\n</callout>');
  });

  it("processes wikilinks inside a callout body", () => {
    const resolve = mapResolver({ target: { url: "https://www.notion.so/abc", title: "Target" } });
    const out = renderWikiPage("> [!summary]\n> See [[target]].", { path: "n.md", resolve });
    expect(out.markdown).toBe(
      '<callout icon="💡" color="blue">\n\tSee <mention-page url="https://www.notion.so/abc">Target</mention-page>.\n</callout>',
    );
  });
});

describe("quotes", () => {
  it("joins a multi-line quote with <br> into a single quote block", () => {
    expect(render("> a\n> b\n> c").markdown).toBe("> a<br>b<br>c");
  });

  it("normalises blank quote lines away", () => {
    expect(render("> a\n>\n> b").markdown).toBe("> a<br>b");
  });

  it("emits nothing for a quote of only blank lines", () => {
    expect(render(">\n>").markdown).toBe("");
  });
});

describe("wikilinks (spec §4.1)", () => {
  const resolve = mapResolver({
    known: { url: "https://www.notion.so/1234", title: "Known Page" },
  });

  it("renders a resolved link as a mention-page with the resolved title", () => {
    const out = renderWikiPage("See [[known]] here.", { path: "n.md", resolve });
    expect(out.markdown).toBe('See <mention-page url="https://www.notion.so/1234">Known Page</mention-page> here.');
  });

  it("renders a resolved aliased link with the alias as label", () => {
    const out = renderWikiPage("See [[known|the alias]].", { path: "n.md", resolve });
    expect(out.markdown).toBe('See <mention-page url="https://www.notion.so/1234">the alias</mention-page>.');
  });

  it("escapes an unresolved link into an inert literal", () => {
    const out = renderWikiPage("See [[missing]].", { path: "n.md", resolve });
    expect(out.markdown).toBe("See \\[\\[missing\\]\\].");
  });

  it("escapes the pipe in an unresolved aliased link so tables cannot split on it", () => {
    const out = renderWikiPage("| [[missing|Miss]] |", { path: "n.md", resolve });
    expect(out.markdown).toBe("| \\[\\[missing\\|Miss\\]\\] |");
  });

  it("passes the exact raw target text to the resolver", () => {
    const seen: string[] = [];
    const spy = (target: string): ResolvedWikiLink | null => { seen.push(target); return null; };
    renderWikiPage("[[raw/foo]] [[note#sec]] [[a|B]]", { path: "n.md", resolve: spy });
    expect(seen).toEqual(["raw/foo", "note#sec", "a"]);
  });

  it("processes wikilinks inside table cells", () => {
    const out = renderWikiPage("| [[known|K]] — x |", { path: "n.md", resolve });
    expect(out.markdown).toBe('| <mention-page url="https://www.notion.so/1234">K</mention-page> — x |');
  });

  it("leaves wikilinks inside inline code untouched", () => {
    const out = renderWikiPage("run `lares [[known]]` now", { path: "n.md", resolve });
    expect(out.markdown).toBe("run `lares [[known]]` now");
  });
});

describe("headings", () => {
  it("passes H5/H6 through and records the collapse warning with the source line", () => {
    const out = render("---\ntitle: T\n---\n\n##### Deep\n###### Deeper");
    expect(out.markdown).toBe("##### Deep\n###### Deeper");
    expect(out.warnings).toEqual([
      "heading level 5 collapses to heading 4 in Notion (line 5)",
      "heading level 6 collapses to heading 4 in Notion (line 6)",
    ]);
  });
});

describe("inline code", () => {
  it("does not escape anything inside an inline code span", () => {
    expect(render("a `x < y` b").markdown).toBe("a `x < y` b");
  });

  it("joins a newline inside an inline code span with <br> and warns", () => {
    const out = render("run `foo\nbar` now");
    expect(out.markdown).toBe("run `foo<br>bar` now");
    expect(out.warnings).toEqual(["newline inside inline code joined with <br> (line 1)"]);
  });

  it("leaves a stray unclosed backtick alone when nothing ever closes it", () => {
    const out = render("a ` b\nplain line");
    expect(out.markdown).toBe("a ` b\nplain line");
    expect(out.warnings).toEqual([]);
  });
});

describe("escaping and assertPushSafe (spec §4.3 — the two tags we must never emit)", () => {
  it("escapes a literal <page> tag in body text into an inert literal, not silently stripped", () => {
    const out = render('Before <page url="https://x">Evil</page> after');
    expect(out.markdown).toBe('Before \\<page url="https://x">Evil\\</page> after');
    // Inert AND still visibly present — never silently dropped.
    expect(out.markdown).toContain("page url=");
    expect(() => assertPushSafe(out.markdown)).not.toThrow();
  });

  it("cannot be bypassed by pre-escaped vault content (backslash-parity attacks)", () => {
    // Each crafted source tries to land an even number of backslashes before `<`
    // in the OUTPUT, which would make the tag live again. The renderer must keep
    // the parity odd in every case.
    const attacks = [
      '<page url="https://x">x</page>',
      '\\<page url="https://x">x</page>',
      '\\\\<page url="https://x">x</page>',
      '\\\\\\<page url="https://x">x</page>',
      '<database url="https://x">x</database>',
      '<PAGE url="https://x">x</PAGE>',
      "<pAgE url='https://x'>",
      '<mention-page url="https://x">not ours</mention-page>',
      "[[missing|<page url=\"https://x\">]]",
      '> [!summary] <page url="https://x">\n> <database url="https://x">',
      '| <page url="https://x"> |',
    ];
    for (const source of attacks) {
      const out = render(source);
      expect(() => assertPushSafe(out.markdown), `source: ${source}`).not.toThrow();
    }
  });

  it("assertPushSafe throws on live <page and <database tags, case-insensitively", () => {
    const live = [
      '<page url="https://x">T</page>',
      '<database url="https://x">D</database>',
      '<PAGE url="https://x">',
      '<Database url="https://x">',
      // Even backslash count = the backslashes escape each other, the tag is live.
      '\\\\<page url="https://x">',
      'prose then <page url="https://x"> mid-line',
    ];
    for (const markdown of live) {
      expect(() => assertPushSafe(markdown), `markdown: ${markdown}`).toThrow(/page|database/);
    }
  });

  it("assertPushSafe allows escaped literals and the tags the renderer emits", () => {
    const safe = [
      '\\<page url="https://x">',
      "\\\\\\<page",
      '<mention-page url="https://x">T</mention-page>',
      '<mention-database url="https://x">D</mention-database>',
      '<callout icon="💡" color="blue">\n\tx\n</callout>',
      "a<br>b",
      "plain text with [brackets] and <br>",
    ];
    for (const markdown of safe) {
      expect(() => assertPushSafe(markdown), `markdown: ${markdown}`).not.toThrow();
    }
  });

  it("a <page> tag inside a code fence passes through verbatim and FAILS the push lint", () => {
    // Code-block content is literal in Notion-flavored markdown, so it cannot be
    // escaped without corrupting it. The lint cannot prove Notion will parse the
    // fence the way we do, so this fails loudly (spec §4.3: fail the write rather
    // than send) instead of being waved through on a fence heuristic.
    const out = render('```\n<page url="https://x">\n```');
    expect(out.markdown).toBe('```\n<page url="https://x">\n```');
    expect(() => assertPushSafe(out.markdown)).toThrow(/line 2/);
  });

  // Phase 4 (T4). Transcripts are one-way Notion→vault PERMANENTLY (spec §17.2):
  // Notion's own docs say the <transcript> tag "cannot be edited by AI" and that
  // writing it "will result in an error". Three separate rails keep a transcript
  // body away from a push — the state row is `target='meetings'` so the desk passes
  // never see it, config carves `*/transcripts/` out of the desk scope so the
  // walker never lists the file — and THIS one, which is the only rail that is a
  // property of the CONTENT rather than of the configuration. Without it, the
  // one-way rule holds only for as long as nobody wires a new caller.
  it("assertPushSafe refuses a transcript body — the one-way rule enforced by code (§17.2)", () => {
    const transcript = [
      "# Weekly sync",
      "",
      "<transcript>",
      "Bendik: so where did we land",
      "Other: on the second option",
      "</transcript>",
    ].join("\n");
    expect(() => assertPushSafe(transcript)).toThrow(/transcript/);
    expect(() => assertPushSafe(transcript)).toThrow(/line 3/);

    // Case-insensitive and attribute-carrying variants, same as the other two tags.
    expect(() => assertPushSafe('<TRANSCRIPT id="x">')).toThrow(/transcript/);
    expect(() => assertPushSafe("prose then <transcript> mid-line")).toThrow(/transcript/);
  });

  it("assertPushSafe still allows an ESCAPED <transcript — that is inert prose, not a tag", () => {
    // Which is what a vault file mentioning the tag renders to: renderWikiPage
    // escapes every live `<` in prose, so an ordinary note that talks ABOUT
    // transcripts must keep pushing exactly as it did before this rail existed.
    expect(() => assertPushSafe("\\<transcript>")).not.toThrow();
    const out = render("the <transcript> tag cannot be written by the API");
    expect(out.markdown).toContain("\\<transcript>");
    expect(() => assertPushSafe(out.markdown)).not.toThrow();
  });

  // The honest statement of what each rail catches (review round 1). Rendered for
  // push, a transcript's block is escaped and sails through assertPushSafe — so the
  // rail that actually answers "may this FILE be pushed at all" has to read the raw
  // source, before anything is rendered.
  it("assertPushSafe does NOT catch a transcript once it has been rendered — assertPushSafeSource does", () => {
    const source = "# Ukesmøte\n\n<transcript>\nBendik: ja\n</transcript>\n";
    const rendered = render(source).markdown;

    expect(rendered).toContain("\\<transcript>");
    expect(() => assertPushSafe(rendered)).not.toThrow();     // inert by then
    expect(() => assertPushSafeSource(source)).toThrow(/transcript/);
    expect(() => assertPushSafeSource(source)).toThrow(/one-way/);
  });

  it("assertPushSafeSource refuses ONLY the transcript rule — <page>/<database> in prose still push", () => {
    // §4.3 is about EMISSION, and escaping genuinely neutralises those two. Checking
    // the source for them would break every note that mentions one in prose.
    expect(() => assertPushSafeSource('a note about <page url="https://x">')).not.toThrow();
    expect(() => assertPushSafeSource('<database url="https://x">')).not.toThrow();
    // An already-escaped mention of the transcript tag is inert prose, not a block.
    expect(() => assertPushSafeSource("the \\<transcript> tag cannot be written")).not.toThrow();
  });

  it("escapes a literal <mention-page> from vault content — only resolver output may mint mentions", () => {
    const out = render('<mention-page url="https://x">fake</mention-page>');
    expect(out.markdown).toBe('\\<mention-page url="https://x">fake\\</mention-page>');
  });

  it("escapes other angle-bracket content too (documented cost: autolinks become literal text)", () => {
    expect(render("see <https://example.com> and a<b").markdown).toBe(
      "see \\<https://example.com> and a\\<b",
    );
  });
});

describe("determinism", () => {
  it("rendering the same source twice yields identical results", () => {
    const source = readFileSync(join(here, "fixtures/wiki/camera-not-an-engine.md"), "utf8");
    const a = renderWikiPage(source, { path: "camera-not-an-engine.md", resolve: fixtureResolve });
    const b = renderWikiPage(source, { path: "camera-not-an-engine.md", resolve: fixtureResolve });
    expect(a).toEqual(b);
  });
});

describe("real vault fixtures (exact rendered output)", () => {
  const FIXTURES = [
    "README.md",
    "writing.md",
    "camera-not-an-engine.md",
    "agent-loops-design.md",
    "claude-code-meetup-external-brain.md",
    "people/aina-lemoen-lunde.md",
    "companies/adnuntius.md",
  ];

  for (const rel of FIXTURES) {
    it(`renders ${rel} exactly as reviewed, push-safe, with no warnings`, () => {
      const source = readFileSync(join(here, "fixtures/wiki", rel), "utf8");
      const expected = readFileSync(join(here, "fixtures/wiki-expected", rel), "utf8");
      const out = renderWikiPage(source, { path: rel, resolve: fixtureResolve });
      expect(out.markdown).toBe(expected);
      expect(out.warnings).toEqual([]);
      expect(() => assertPushSafe(out.markdown)).not.toThrow();
    });
  }

  it("camera-not-an-engine: callout map, mentions, escaped raw/ links, table intact", () => {
    const source = readFileSync(join(here, "fixtures/wiki/camera-not-an-engine.md"), "utf8");
    const out = renderWikiPage(source, { path: "camera-not-an-engine.md", resolve: fixtureResolve });
    expect(out.title).toBe(
      "A Camera, Not an Engine — seeing in latent space, and the camera/engine split in agents",
    );
    expect(out.folderHint).toBeUndefined();
    expect(out.markdown).toContain('<callout icon="💡" color="blue">');
    expect(out.markdown).toContain('<callout icon="💬" color="gray">');
    expect(out.markdown).toContain('<callout icon="❗" color="red">');
    expect(out.markdown).toContain(
      '<mention-page url="https://www.notion.so/11111111111111111111111111111111">',
    );
    expect(out.markdown).toContain("\\[\\[raw/a-camera-not-an-engine-ii\\]\\]");
    expect(out.markdown).toContain("| Balance | seeing outruns doing | doing outruns seeing |");
  });

  it("agent-loops-design: warning callout and unresolved links escaped", () => {
    const source = readFileSync(join(here, "fixtures/wiki/agent-loops-design.md"), "utf8");
    const out = renderWikiPage(source, { path: "agent-loops-design.md", resolve: fixtureResolve });
    expect(out.markdown).toContain('<callout icon="⚠️" color="yellow">');
    expect(out.markdown).toContain(
      "\\[\\[loop-engineering-designing-loops-instead-of-prompting-agents\\]\\]",
    );
  });

  it("claude-code-meetup: todo callout keeps its checkbox lines as literal <br>-joined text", () => {
    const source = readFileSync(join(here, "fixtures/wiki/claude-code-meetup-external-brain.md"), "utf8");
    const out = renderWikiPage(source, { path: "claude-code-meetup-external-brain.md", resolve: fixtureResolve });
    expect(out.markdown).toContain('<callout icon="☑️" color="green">');
    expect(out.markdown).toContain("- [ ] **Speak at the Oslo Claude Code meetups.**");
    expect(out.title).toBe(
      "Claude Code Meetup (Oslo) — 'external brain' talk: techniques to steal + a stage to stand on",
    );
  });

  it("people/aina-lemoen-lunde: person title, folder hint, resolved alias mention", () => {
    const source = readFileSync(join(here, "fixtures/wiki/people/aina-lemoen-lunde.md"), "utf8");
    const out = renderWikiPage(source, { path: "people/aina-lemoen-lunde.md", resolve: fixtureResolve });
    expect(out.title).toBe("Aina Lemoen Lunde");
    expect(out.folderHint).toBe("people");
    expect(out.markdown).toContain(
      '<mention-page url="https://www.notion.so/66666666666666666666666666666666">ANFO Annonsørforeningen</mention-page>',
    );
  });

  it("companies/adnuntius: company folder hint and resolved alias mention", () => {
    const source = readFileSync(join(here, "fixtures/wiki/companies/adnuntius.md"), "utf8");
    const out = renderWikiPage(source, { path: "companies/adnuntius.md", resolve: fixtureResolve });
    expect(out.folderHint).toBe("companies");
    expect(out.markdown).toContain(
      '<mention-page url="https://www.notion.so/55555555555555555555555555555555">Rune Danielsen</mention-page>',
    );
  });

  it("README.md: no frontmatter, H1 title, root folder", () => {
    const source = readFileSync(join(here, "fixtures/wiki/README.md"), "utf8");
    const out = renderWikiPage(source, { path: "README.md", resolve: fixtureResolve });
    expect(out.title).toBe("wiki — the synthesis (agent-owned)");
    expect(out.frontmatter).toBe("");
    expect(out.folderHint).toBeUndefined();
  });

  it("writing.md: resolved links become mentions, unsynced ones stay escaped literals", () => {
    const source = readFileSync(join(here, "fixtures/wiki/writing.md"), "utf8");
    const out = renderWikiPage(source, { path: "writing.md", resolve: fixtureResolve });
    expect(out.markdown).toContain(
      '<mention-page url="https://www.notion.so/22222222222222222222222222222222">',
    );
    expect(out.markdown).toContain("\\[\\[martech-strategy-memo\\]\\]");
  });
});
