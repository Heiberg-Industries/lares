import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

export type RawCounts = {
  button: number;
  select: number;
  textarea: number;
  fieldset: number;
  input: number;
  unscrolledTable: number;
  style: number;
  inlineMaxWidth: number;
};

const CONTROLS = ["button", "select", "textarea", "fieldset"] as const;

// A wide table scrolls inside one of these instead of stretching the page on a phone.
const SCROLL_WRAPPER = /lares-table-scroll|lares-event-table|styles\.frame/;

const parse = (source: string) =>
  ts.createSourceFile("scan.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

function attribute(node: ts.JsxOpeningLikeElement, name: string) {
  return node.attributes.properties.find(
    (property): property is ts.JsxAttribute => ts.isJsxAttribute(property) && property.name.getText() === name,
  );
}

function scrolls(node: ts.JsxOpeningLikeElement) {
  const wrapper = (ts.isJsxSelfClosingElement(node) ? node : node.parent).parent;
  if (!ts.isJsxElement(wrapper)) return false;
  return SCROLL_WRAPPER.test(attribute(wrapper.openingElement, "className")?.getText() ?? "");
}

function literal(attr: ts.JsxAttribute | undefined) {
  return attr?.initializer && ts.isStringLiteral(attr.initializer) ? attr.initializer.text : undefined;
}

/** Controls and styling written by hand in one source file. Hidden inputs draw nothing, so they do not count. */
export function countRaw(source: string): RawCounts {
  const counts: RawCounts = { button: 0, select: 0, textarea: 0, fieldset: 0, input: 0, unscrolledTable: 0, style: 0, inlineMaxWidth: 0 };
  const visit = (node: ts.Node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText();
      if ((CONTROLS as readonly string[]).includes(tag)) counts[tag as (typeof CONTROLS)[number]]++;
      if (tag === "input" && literal(attribute(node, "type")) !== "hidden") counts.input++;
      if (tag === "table" && !scrolls(node)) counts.unscrolledTable++;
      if (attribute(node, "style")) counts.style++;
    }
    ts.forEachChild(node, visit);
  };
  visit(parse(source));
  counts.inlineMaxWidth = source.match(/\bmaxWidth\s*:/g)?.length ?? 0;
  return counts;
}

function jsxRoots(expression: ts.Expression): ts.Node[] {
  if (ts.isParenthesizedExpression(expression)) return jsxRoots(expression.expression);
  if (ts.isConditionalExpression(expression)) return [...jsxRoots(expression.whenTrue), ...jsxRoots(expression.whenFalse)];
  if (ts.isBinaryExpression(expression)) return jsxRoots(expression.right);
  return ts.isJsxElement(expression) || ts.isJsxSelfClosingElement(expression) || ts.isJsxFragment(expression) ? [expression] : [];
}

function rootName(node: ts.Node) {
  if (ts.isJsxElement(node)) return node.openingElement.tagName.getText();
  if (ts.isJsxSelfClosingElement(node)) return node.tagName.getText();
  return "fragment";
}

/** What a route's default export hands back at each return. A route may also redirect or throw, which draws nothing. */
export function routeRoots(source: string): string[] {
  const roots: string[] = [];
  const sourceFile = parse(source);
  const visit = (node: ts.Node) => {
    if (ts.isFunctionLike(node) && !isDefaultExport(node)) return;
    if (ts.isReturnStatement(node) && node.expression) roots.push(...jsxRoots(node.expression).map(rootName));
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return roots;
}

function isDefaultExport(node: ts.Node) {
  return ts.isFunctionDeclaration(node)
    && !!node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword);
}

/** Every `max-width` limit in a stylesheet, as "selector: value". Media conditions are not limits. */
export function cssWidthLimits(css: string): string[] {
  const limits: string[] = [];
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const [, selector, body] of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const value = body.match(/(?:^|[;\s])max-width\s*:\s*([^;]+)/)?.[1];
    if (value) limits.push(`${selector.trim().replace(/\s+/g, " ")}: ${value.trim()}`);
  }
  return limits;
}

/** Every value of one property in a stylesheet, as "selector: value", one entry per declaration. */
function cssValues(css: string, property: string): string[] {
  const found: string[] = [];
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const declaration = new RegExp(`(?:^|[;\\s])${property}\\s*:\\s*([^;]+)`, "g");
  for (const [, selector, body] of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    for (const [, value] of body.matchAll(declaration)) found.push(`${selector.trim().replace(/\s+/g, " ")}: ${value.trim()}`);
  }
  return found;
}

/** Every column layout a stylesheet sets for itself (`grid-template-columns`). Page and Col own the page's columns. */
export const cssColumnLayouts = (css: string): string[] => cssValues(css, "grid-template-columns");

// The size from which a fixed width is layout rather than the size of an icon or a dot.
const BLOCK_SIZED: Record<string, number> = { px: 120, rem: 8, em: 8, ch: 20, vw: 0 };

/** Every block-sized fixed `width` or `min-width` (a length, not a share of the space on offer) in a stylesheet. */
export function cssFixedWidths(css: string): string[] {
  const fixed = (entry: string) => {
    const [, amount, unit] = /: (\d*\.?\d+)(px|rem|em|ch|vw)$/.exec(entry) ?? [];
    return !!unit && Number(amount) >= BLOCK_SIZED[unit]!;
  };
  return [...cssValues(css, "width").map((entry) => entry.replace(": ", " width: ")), ...cssValues(css, "min-width").map((entry) => entry.replace(": ", " min-width: "))]
    .filter(fixed);
}

/** Classes in a source file that size a block by hand, or name a column span the grid does not have. */
export function widthClasses(source: string): string[] {
  const sized = source.match(/(?<![\w-])(?:max-w|min-w|w|basis)-(?:\[[^\]]+\]|\d[\w./]*|full|screen|xs|sm|md|lg|xl|\dxl|prose)(?![\w-])/g) ?? [];
  const spans = (source.match(/lares-col-[\w-]+/g) ?? []).filter((name) => !/^lares-col-(12|8|6|4|3)$/.test(name) && name !== "lares-col-");
  return [...sized, ...spans];
}

/** How many times a file writes a class that starts with the given prefix. */
export const countClass = (source: string, prefix: string): number =>
  source.match(new RegExp(`(?<![\\w-])${prefix}[\\w-]*`, "g"))?.length ?? 0;

export function sourceFiles(root: string, directory: string, extension: string): string[] {
  const found: string[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "api") walk(path);
      } else if (path.endsWith(extension)) found.push(relative(root, path));
    }
  };
  walk(join(root, directory));
  return found.sort();
}

export const read = (root: string, file: string) => readFileSync(join(root, file), "utf8");
