import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { countClass, countRaw, cssColumnLayouts, cssFixedWidths, cssWidthLimits, read, routeRoots, sourceFiles, widthClasses, type RawCounts } from "./helpers/design-system-scan";
import { CSS_COLUMN_LAYOUTS, CSS_FIXED_WIDTHS, CSS_WIDTH_LIMITS, OPERATIONAL_LEFT, RAW_LEFT } from "./design-system-baseline";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tsx = [...sourceFiles(root, "app", ".tsx"), ...sourceFiles(root, "components", ".tsx")];
const css = [...sourceFiles(root, "app", ".css"), ...sourceFiles(root, "components", ".css")];
// Signed-out doors: full-screen, no navigation, one shared layout of their own.
const DOORS = new Set(["app/sign-in/page.tsx", "app/invite/page.tsx"]);
const ROUTE = /(^|\/)(page|error|not-found|loading)\.tsx$/;

describe("every page sits on the one grid", () => {
  it("each route returns one Page, with nothing beside it", () => {
    const wrong = tsx.filter((file) => ROUTE.test(file) && !DOORS.has(file)).flatMap((file) => {
      const roots = routeRoots(read(root, file));
      if (!roots.length) return [`${file}: returns no page`];
      return roots.filter((name) => name !== "Page").map((name) => `${file}: returns ${name}`);
    });
    expect(wrong, "Wrap the route in <Page> from @lares/ui/patterns: width=\"narrow\" for forms, settings and chat.").toEqual([]);
  });

  it("the page class is only ever written by Page", () => {
    const wrong = tsx.filter((file) => /["'` ]lares-page["'` ]/.test(read(root, file)));
    expect(wrong, "Use <Page> instead of the lares-page class.").toEqual([]);
  });

  it("sections set no page-sized width of their own", () => {
    const limits = css.flatMap((file) => cssWidthLimits(read(root, file)).map((limit) => `${file} ${limit}`));
    expect(limits, "A section fills its page. Choose the Page width instead of adding a max-width.").toEqual([...CSS_WIDTH_LIMITS]);
    const utilities = tsx.filter((file) => /\bmax-w-/.test(read(root, file)));
    expect(utilities, "A section fills its page. Choose the Page width instead of a max-w class.").toEqual([]);
  });

  it("no block is sized by hand: a narrower block is a Col with one of the named spans", () => {
    const classes = tsx.flatMap((file) => widthClasses(read(root, file)).map((name) => `${file} ${name}`));
    expect(classes, "Use <Col span={12 | 8 | 6 | 4 | 3}> from @lares/ui/patterns (or its lares-col-* class) instead of a width class.").toEqual([]);
    const fixed = css.flatMap((file) => cssFixedWidths(read(root, file)).map((width) => `${file} ${width}`));
    expect(fixed, "A fixed width went in, or one came out. Use Col for width; if one came out, delete it from CSS_FIXED_WIDTHS.").toEqual([...CSS_FIXED_WIDTHS]);
  });

  it("no stylesheet lays out columns of its own beyond the ones already listed", () => {
    const columns = css.flatMap((file) => cssColumnLayouts(read(root, file)).map((layout) => `${file} ${layout}`));
    expect(columns, "Page and Col own the columns. A new grid-template-columns is not allowed; if one came out, delete it from CSS_COLUMN_LAYOUTS.").toEqual([...CSS_COLUMN_LAYOUTS]);
  });

  it("the shell sets no page width: Page is the only thing that does", () => {
    const shell = read(root, "components/AppShell.module.css");
    expect(cssWidthLimits(shell)).toEqual([]);
    expect(cssFixedWidths(shell)).toEqual([]);
    expect(shell, "The shell takes every value from the design values.").not.toMatch(/#[0-9a-f]{3,8}\b|oklch\(|rgba?\(/i);
  });
});

describe("the older operational classes are on their way out", () => {
  it("no file uses lares-operational* classes more often than the list allows, and the list stays tight", () => {
    const found: Record<string, number> = {};
    for (const file of tsx) {
      const count = countClass(read(root, file), "lares-operational");
      if (count) found[file] = count;
    }
    expect(found, [
      "A count went up: build the page from Page, Col, Card, Rows, Notice and Badge in @lares/ui instead of a lares-operational class.",
      "A count went down: well done, lower it in tests/design-system-baseline.ts so it stays down.",
    ].join(" ")).toEqual(OPERATIONAL_LEFT);
  });
});

describe("controls and styling come from the design system", () => {
  it("no file has more hand-built controls or inline styles than the list allows, and the list stays tight", () => {
    const found: Record<string, RawCounts> = {};
    for (const file of tsx) {
      const counts = countRaw(read(root, file));
      if (Object.values(counts).some(Boolean)) found[file] = counts;
    }
    expect(found, [
      "A count went up: use Button, Input, Select, Textarea, Checkbox, Radio, Field, Choice or FieldGroup from @lares/ui, classes instead of inline styles, and a lares-table-scroll wrapper around each table.",
      "A count went down: well done, lower it in tests/design-system-baseline.ts so it stays down.",
    ].join(" ")).toEqual(RAW_LEFT);
  });
});

describe("tool lists and messages", () => {
  it("the screens that list outside tools use ToolList, and never join tool names into one line", () => {
    for (const file of ["components/ConnectorAccess.tsx", "components/OutsideToolsSection.tsx"]) {
      const source = read(root, file);
      expect(source, `${file}: list tools with ToolList and ToolRow from @lares/ui/patterns.`).toContain("<ToolList");
      expect(source, `${file}: do not join tool names into a sentence.`).not.toMatch(/tools\.join\(|lookups|others\.join/);
    }
  });

  it("the outside tools screens word every message through a Notice tone, not a bare paragraph", () => {
    for (const file of ["components/ConnectorAccess.tsx", "components/AddConnectorForm.tsx", "components/ConnectorActions.tsx"]) expect(read(root, file)).not.toMatch(/<p role="(alert|status)"/);
  });
});

describe("the scan itself", () => {
  it("catches a section placed beside the page, the way a page once outgrew its grid", () => {
    expect(routeRoots(`export default function A() { return <><Page /><Section /></>; }`)).toEqual(["fragment"]);
    expect(routeRoots(`export default async function A() { if (x) return <div />; return <Page>{y.map(() => { return <li />; })}</Page>; }`)).toEqual(["div", "Page"]);
    expect(routeRoots(`function Helper() { return <div />; } export default function A() { return ok ? <Page /> : <Other />; }`)).toEqual(["Page", "Other"]);
  });

  it("counts drawn controls, and not hidden fields or design-system parts", () => {
    expect(countRaw(`<form><input type="hidden" /><input type="date" /><select /><Select /><Button /><button style={{ maxWidth: 1 }} /></form>`))
      .toEqual({ button: 1, select: 1, textarea: 0, fieldset: 0, input: 1, unscrolledTable: 0, style: 1, inlineMaxWidth: 1 });
  });

  it("counts a table that cannot scroll sideways on a phone", () => {
    expect(countRaw(`<div><table /></div>`).unscrolledTable).toBe(1);
    expect(countRaw(`<div className="lares-table-scroll"><table /></div>`).unscrolledTable).toBe(0);
  });

  it("reads column layouts, fixed widths, width classes and class counts", () => {
    expect(cssColumnLayouts(`.a { display: grid; grid-template-columns: 1fr 2fr; } /* .x { grid-template-columns: 1fr } */ .b { color: red }`)).toEqual([".a: 1fr 2fr"]);
    expect(cssFixedWidths(`.a { width: 300px; min-width: 0 } .b { width: 100%; min-width: 20rem } .c { max-width: 9px; width: min(100%, 4rem) }`))
      .toEqual([".a width: 300px", ".b min-width: 20rem"]);
    expect(cssFixedWidths(`.icon { width: 26px; min-width: 1rem } .dot { width: 6px }`)).toEqual([]);
    expect(widthClasses(`<div className="w-[320px] lares-col-8 lares-col-5 max-w-md flow-root lares-wide-input" />`)).toEqual(["w-[320px]", "max-w-md", "lares-col-5"]);
    expect(countClass(`<p className="lares-operational-note lares-operational"><b className="lares-status-error not-lares-operational-x" />`, "lares-operational")).toBe(2);
  });

  it("reads width limits, and ignores media conditions and comments", () => {
    expect(cssWidthLimits(`/* .x { max-width: 1px } */ .a { color: red; max-width: 10rem; } @media (max-width: 760px) { .b { max-width: 2px } } .c { min-width: 0 }`))
      .toEqual([".a: 10rem", ".b: 2px"]);
  });
});
