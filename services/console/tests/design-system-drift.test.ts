import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { countRaw, cssWidthLimits, read, routeRoots, sourceFiles, type RawCounts } from "./helpers/design-system-scan";
import { CSS_WIDTH_LIMITS, RAW_LEFT } from "./design-system-baseline";

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

  it("reads width limits, and ignores media conditions and comments", () => {
    expect(cssWidthLimits(`/* .x { max-width: 1px } */ .a { color: red; max-width: 10rem; } @media (max-width: 760px) { .b { max-width: 2px } } .c { min-width: 0 }`))
      .toEqual([".a: 10rem", ".b: 2px"]);
  });
});
