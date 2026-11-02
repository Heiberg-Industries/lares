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
