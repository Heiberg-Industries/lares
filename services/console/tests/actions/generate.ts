/**
 * Console action inventory generator. See README.md next to this file.
 *
 * Reads the console's code (no running app, no database) and produces one sorted JSON document that lists
 * every page, every server action and every route handler, who may see and who may act, and which pages
 * reach which actions. Run it by hand with:  node tests/actions/generate.ts --write   (from services/console)
 *
 * Who-may-act is DERIVED, never typed in: each page, action and route is parsed, the guard calls it makes are
 * followed into lib/auth.ts, and the strictest guard that really refuses (a throw, a redirect or a null check
 * on the result) decides the level. Anything that cannot be derived is "unknown"; overrides.json can resolve
 * it, each with a reason, and the test refuses unknown rows and stale overrides.
 */
import ts from "typescript";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const consoleRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const inventoryPath = join(consoleRoot, "tests/actions/action-inventory.json");
export const overridesPath = join(consoleRoot, "tests/actions/overrides.json");

export type Who = "owner" | "member" | "public" | "none" | "unknown";
export interface Overrides {
  /** Resolves a row the generator marked unknown. Key is the row id. */
  guards: Record<string, { level: "public" | "member" | "owner"; reason: string }>;
  /** GET handlers that change state although GET normally does not. Key is the row id. */
  getChangesState: Record<string, string>;
  /** Pages (other than chat and membership) that a non-owner can reach, by design. */
  publicByDesign: Record<string, string>;
  /** Pages (other than chat and membership) a member can reach today, until the owner decides. */
  awaitingOwnerDecision: Record<string, string>;
}
export interface Row {
  id: string;
  kind: "page" | "layout" | "action" | "route";
  file: string;
  /** Who may open or see it (pages, actions: the most open page that reaches it). */
  see?: Who;
  /** Who may act: pages = through their actions; actions and routes = their own guard. */
  act: Who;
  /** True when a member passes the guard but part of it is owner-only (a branch or a section). */
  ownerExtras?: true;
  /** The functions in lib/auth.ts that the guard reaches. */
  guards: string[];
  source: "derived" | "override" | "unknown";
  reason?: string;
  actions?: string[];
  routes?: string[];
  usedBy?: string[];
  methods?: string;
  changesState?: boolean;
}
export interface Inventory { note: string; pages: Row[]; actions: Row[]; routes: Row[] }

const rank: Record<string, number> = { none: 0, member: 1, owner: 2 };
const posix = (p: string) => p.split("\\").join("/");
const rel = (p: string) => posix(relative(consoleRoot, p));

// ---------- parsing and import resolution ----------
const parsed = new Map<string, ts.SourceFile>();
function parse(path: string): ts.SourceFile {
  let source = parsed.get(path);
  if (!source) {
    source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, path.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    parsed.set(path, source);
  }
  return source;
}
function resolveSpecifier(from: string, spec: string): string | undefined {
  let base: string;
  if (spec.startsWith(".")) base = resolve(dirname(from), spec);
  else if (spec.startsWith("@/")) base = join(consoleRoot, spec.slice(2));
  else return undefined;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
    if (/\.tsx?$/.test(candidate) && existsSync(candidate) && !candidate.includes("node_modules")) return candidate;
  }
  return undefined;
}
interface ImportedName { file: string; name: string; typeOnly: boolean }
const importCache = new Map<string, { names: Map<string, ImportedName>; namespaces: Map<string, string>; all: string[] }>();
function importsOf(file: string) {
  let found = importCache.get(file);
  if (found) return found;
  found = { names: new Map(), namespaces: new Map(), all: [] };
  const source = parse(file);
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const target = resolveSpecifier(file, node.moduleSpecifier.text);
      if (target) {
        found!.all.push(target);
        const clause = node.importClause;
        if (clause?.name) found!.names.set(clause.name.text, { file: target, name: "default", typeOnly: clause.isTypeOnly });
        const bindings = clause?.namedBindings;
        if (bindings && ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) found!.names.set(element.name.text, { file: target, name: (element.propertyName ?? element.name).text, typeOnly: clause!.isTypeOnly || element.isTypeOnly });
        } else if (bindings && ts.isNamespaceImport(bindings)) found!.namespaces.set(bindings.name.text, target);
      }
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
      const target = resolveSpecifier(file, node.arguments[0].text);
      if (target) found!.all.push(target);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  importCache.set(file, found);
  return found;
}

type FnNode = ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression;
function functionIndex(file: string): Map<string, FnNode> {
  const index = new Map<string, FnNode>();
  for (const statement of parse(file).statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && statement.body) index.set(statement.name.text, statement);
    else if (ts.isVariableStatement(statement)) {
      for (const d of statement.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) index.set(d.name.text, d.initializer);
      }
    }
  }
  return index;
}
const isExported = (node: ts.Node) => !!ts.canHaveModifiers(node) && !!ts.getModifiers(node)?.some(m => m.kind === ts.SyntaxKind.ExportKeyword);
function exportedFunctionNames(file: string): string[] {
  const names: string[] = [];
  for (const statement of parse(file).statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && isExported(statement)) names.push(statement.name.text);
    else if (ts.isVariableStatement(statement) && isExported(statement)) {
      for (const d of statement.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) names.push(d.name.text);
      }
    }
  }
  return names;
}
function directive(body: ts.Node | undefined): boolean {
  const first = body && (ts.isSourceFile(body) ? body.statements[0] : ts.isBlock(body) ? body.statements[0] : undefined);
  return !!first && ts.isExpressionStatement(first) && ts.isStringLiteral(first.expression) && first.expression.text === "use server";
}

// ---------- guard analysis ----------
interface Analysis { level: "none" | "member" | "owner"; throws: boolean; nullable: boolean; ownerExtras: boolean; via: Set<string> }
const none = (): Analysis => ({ level: "none", throws: false, nullable: false, ownerExtras: false, via: new Set() });
const authFile = join(consoleRoot, "lib/auth.ts");
const analysisCache = new Map<string, Analysis>();
const strip = (node: ts.Expression): ts.Expression => {
  for (;;) {
    if (ts.isParenthesizedExpression(node) || ts.isAwaitExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)) node = node.expression;
    else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) node = node.left;
    else return node;
  }
};
const exitsWith = (node: ts.Node): { throws: boolean; returns: boolean } => {
  const out = { throws: false, returns: false };
  const visit = (n: ts.Node) => {
    if (ts.isThrowStatement(n)) out.throws = true;
    else if (ts.isReturnStatement(n)) out.returns = true;
    else if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && (n.expression.text === "redirect" || n.expression.text === "notFound")) out.throws = true;
    ts.forEachChild(n, visit);
  };
  visit(node);
  return out;
};

interface Ref { node: ts.CallExpression; special?: "ownerCheck" | "lookup"; name: string; callee?: Analysis; calleeFile?: string; cond: boolean; boundVar?: string; inReturn: boolean; direct: boolean }
interface Gate { vars: Set<string>; calls: Set<ts.Node>; ownerCheck: boolean; throws: boolean }

function calleeOf(file: string, call: ts.CallExpression): { special?: "ownerCheck" | "lookup"; name: string; fn?: { file: string; node: FnNode; name: string } } | undefined {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) {
    if (callee.text === "isConsoleOwner") return { special: "ownerCheck", name: "isConsoleOwner" };
    const local = functionIndex(file).get(callee.text);
    if (local) return { name: callee.text, fn: { file, node: local, name: callee.text } };
    const imported = importsOf(file).names.get(callee.text);
    if (imported && !imported.typeOnly) {
      const node = functionIndex(imported.file).get(imported.name);
      if (node) return { name: callee.text, fn: { file: imported.file, node, name: imported.name } };
    }
    return undefined;
  }
  if (ts.isPropertyAccessExpression(callee) && (callee.name.text === "sessionMember" || callee.name.text === "signedInMember")) return { special: "lookup", name: callee.name.text };
  return undefined;
}

function analyseFunction(file: string, name: string, fn: FnNode): Analysis {
  const key = `${file}#${name}`;
  const cached = analysisCache.get(key);
  if (cached) return cached;
  analysisCache.set(key, none()); // cycles count as no guard
  const result = analyseBody(file, fn);
  if (file === authFile) result.via = new Set([name]);
  analysisCache.set(key, result);
  return result;
}

function analyseBody(file: string, fn: FnNode): Analysis {
  const refs: Ref[] = [];
  const gates: Gate[] = [];
  // A throw from a call stops the function unless it is swallowed: the call is the receiver of .catch/.then/.finally
  // or an element of Promise.allSettled. (Calls inside callbacks or branches are already conditional.)
  const swallowed = new Set<ts.Node>();
  const directContext = new Map<ts.Node, { boundVar?: string; inReturn: boolean }>();
  const addRef = (call: ts.CallExpression, cond: boolean) => {
    const ctx = directContext.get(call);
    const boundVar = ctx?.boundVar, inReturn = ctx?.inReturn ?? false, direct = !swallowed.has(call);
    const c = calleeOf(file, call);
    if (!c) return;
    if (c.fn) {
      const callee = analyseFunction(c.fn.file, c.fn.name, c.fn.node);
      if (callee.level === "none") return;
      refs.push({ node: call, name: c.name, callee, calleeFile: c.fn.file, cond, boundVar, inReturn, direct });
    } else refs.push({ node: call, special: c.special, name: c.name, cond, boundVar, inReturn, direct });
  };
  const bangOperands = (expr: ts.Node, out: Gate) => {
    if (ts.isPrefixUnaryExpression(expr) && expr.operator === ts.SyntaxKind.ExclamationToken) {
      const operand = strip(expr.operand as ts.Expression);
      if (ts.isIdentifier(operand)) out.vars.add(operand.text);
      else if (ts.isCallExpression(operand)) {
        out.calls.add(operand);
        if (ts.isIdentifier(operand.expression) && operand.expression.text === "isConsoleOwner") out.ownerCheck = true;
      }
    }
    ts.forEachChild(expr, child => bangOperands(child, out));
  };
  const visit = (node: ts.Node, cond: boolean): void => {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const direct = strip(node.initializer);
      if (ts.isCallExpression(direct)) directContext.set(direct, { boundVar: ts.isIdentifier(node.name) ? node.name.text : undefined, inReturn: false });
    } else if (ts.isReturnStatement(node) && node.expression) {
      const direct = strip(node.expression);
      if (ts.isCallExpression(direct)) directContext.set(direct, { inReturn: true });
    } else if (ts.isExpressionStatement(node)) {
      const direct = strip(node.expression);
      if (ts.isCallExpression(direct)) directContext.set(direct, { inReturn: false });
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isPropertyAccessExpression(callee) && ["catch", "then", "finally"].includes(callee.name.text)) swallowed.add(strip(callee.expression));
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === "allSettled" && node.arguments[0] && ts.isArrayLiteralExpression(node.arguments[0])) {
        for (const element of node.arguments[0].elements) swallowed.add(strip(element));
      }
      addRef(node, cond);
    }
    if (ts.isIfStatement(node)) {
      if (!cond) {
        const gate: Gate = { vars: new Set(), calls: new Set(), ownerCheck: false, throws: false };
        bangOperands(node.expression, gate);
        const exit = exitsWith(node.thenStatement);
        if ((gate.vars.size || gate.calls.size) && (exit.throws || exit.returns)) { gate.throws = exit.throws; gates.push(gate); }
      }
      visit(node.expression, cond);
      visit(node.thenStatement, true);
      if (node.elseStatement) visit(node.elseStatement, true);
      return;
    }
    if (ts.isConditionalExpression(node)) { visit(node.condition, cond); visit(node.whenTrue, true); visit(node.whenFalse, true); return; }
    if (ts.isBinaryExpression(node) && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(node.operatorToken.kind)) {
      visit(node.left, cond); visit(node.right, true); return;
    }
    if (ts.isFunctionLike(node) && node !== fn) { ts.forEachChild(node, child => visit(child, true)); return; }
    if (ts.isTryStatement(node)) {
      visit(node.tryBlock, cond);
      if (node.catchClause) visit(node.catchClause, true);
      if (node.finallyBlock) visit(node.finallyBlock, true);
      return;
    }
    if (ts.isIterationStatement(node, false) || ts.isSwitchStatement(node)) { ts.forEachChild(node, child => visit(child, true)); return; }
    ts.forEachChild(node, child => visit(child, cond));
  };
  if (fn.body) visit(fn.body, false);

  const levelOf = (r: Ref): "member" | "owner" => r.special === "lookup" ? "member" : r.callee!.level as "member" | "owner";
  let level = 0 as 0 | 1 | 2, throws = false, passthroughNullable = false, gateNullable = false;
  const via = new Set<string>();
  const consumedOwnerChecks = new Set<ts.Node>();
  const enforced = new Set<Ref>();
  const bump = (n: number) => { if (n > level) level = n as 1 | 2; };
  for (const gate of gates) {
    let matched = false, gateLevel = 0;
    for (const r of refs) {
      if (r.cond || r.special === "ownerCheck") continue;
      if ((r.boundVar && gate.vars.has(r.boundVar)) || gate.calls.has(r.node)) {
        matched = true; enforced.add(r); gateLevel = Math.max(gateLevel, rank[levelOf(r)]);
      }
    }
    for (const r of refs) if (r.special === "ownerCheck" && gate.calls.has(r.node)) { matched = true; gateLevel = 2; consumedOwnerChecks.add(r.node); via.add("isConsoleOwner"); }
    if (matched) { bump(gateLevel); if (gate.throws) throws = true; else gateNullable = true; }
  }
  for (const r of refs) {
    if (r.special === "ownerCheck" || r.cond) continue;
    if (r.inReturn) {
      enforced.add(r); bump(rank[levelOf(r)]);
      if (r.special === "lookup" || !r.callee!.throws) passthroughNullable = true; else throws = true;
    } else if (r.callee?.throws && r.direct) { enforced.add(r); bump(rank[levelOf(r)]); throws = true; }
  }
  for (const r of enforced) {
    if (r.special === "lookup") via.add(r.name);
    else if (r.calleeFile === authFile) via.add(r.name);
    else for (const v of r.callee!.via) via.add(v);
  }
  let ownerExtras = false;
  for (const r of refs) {
    if (r.special === "ownerCheck") { if (!consumedOwnerChecks.has(r.node)) ownerExtras = true; }
    else if (!enforced.has(r) && r.callee?.level === "owner") ownerExtras = true;
  }
  if (level === 2) ownerExtras = false;
  if (ownerExtras) via.add("isConsoleOwner");
  return { level: (["none", "member", "owner"] as const)[level], throws, nullable: !throws && level > 0 && (passthroughNullable || gateNullable), ownerExtras, via };
}

// ---------- row building ----------
const walk = (folder: string): string[] => readdirSync(folder, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(join(folder, e.name)) : [join(folder, e.name)]);
function defaultExport(file: string): FnNode | undefined {
  const source = parse(file);
  const index = functionIndex(file);
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.body && ts.getModifiers(statement)?.some(m => m.kind === ts.SyntaxKind.DefaultKeyword)) return statement;
    if (ts.isExportAssignment(statement) && ts.isIdentifier(statement.expression)) return index.get(statement.expression.text);
  }
  return undefined;
}
function derivedWho(a: Analysis): Who { return a.level === "none" ? "unknown" : a.level; }
const pageId = (file: string) => {
  const route = posix(relative(join(consoleRoot, "app"), dirname(file)));
  return route === "." ? "/" : `/${route}`;
};
const routePattern = (file: string) => {
  const p = posix(relative(join(consoleRoot, "app"), dirname(file)));
  return `/${p}`;
};
const patternRegex = (pattern: string) => new RegExp(`^${pattern.replace(/[.*+?^${}()|\\]/g, "\\$&").replace(/\\\[\\\.\\\.\\\.[^\]]+\\\]/g, ".+").replace(/\\\[[^\]]+\\\]/g, "[^/]+")}/?$`);

function actionFiles(): { file: string; names: string[] }[] {
  const found: { file: string; names: string[] }[] = [];
  for (const folder of ["app", "components", "lib"]) {
    for (const file of walk(join(consoleRoot, folder)).filter(f => /\.tsx?$/.test(f)).sort()) {
      const source = parse(file);
      if (directive(source)) found.push({ file, names: exportedFunctionNames(file) });
    }
  }
  return found;
}

export function generate(overrides: Overrides = JSON.parse(readFileSync(overridesPath, "utf8")) as Overrides): Inventory {
  analysisCache.clear();
  const actionFileList = actionFiles();
  const actionByFile = new Map(actionFileList.map(a => [a.file, a]));
  const actionId = (file: string, name: string) => `${posix(relative(join(consoleRoot, "app/actions"), file)).replace(/\.tsx?$/, "")}.${name}`;

  // routes first: pages refer to them by string
  const routeRows: Row[] = [];
  const routeFiles = walk(join(consoleRoot, "app")).filter(f => /\/route\.ts$/.test(posix(f))).sort();
  const routePatterns: { pattern: string; regex: RegExp; ids: string[] }[] = [];
  for (const file of routeFiles) {
    const source = parse(file);
    const index = functionIndex(file);
    const pattern = routePattern(file);
    const ids: string[] = [];
    const handlers: { method: string; fn?: { file: string; node: FnNode; name: string } }[] = [];
    const lookupHandler = (expr: ts.Expression): { file: string; node: FnNode; name: string } | undefined => {
      const e = strip(expr);
      if (ts.isCallExpression(e) && e.arguments[0]) return lookupHandler(e.arguments[0]); // withConsoleAdmission(handler)
      if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) return { file, node: e, name: "inline" };
      if (ts.isIdentifier(e)) {
        const local = index.get(e.text);
        if (local) return { file, node: local, name: e.text };
        const imported = importsOf(file).names.get(e.text);
        const node = imported && functionIndex(imported.file).get(imported.name);
        if (imported && node) return { file: imported.file, node, name: imported.name };
      }
      return undefined;
    };
    for (const statement of source.statements) {
      if (ts.isFunctionDeclaration(statement) && statement.name && isExported(statement) && /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(statement.name.text)) {
        handlers.push({ method: statement.name.text, fn: { file, node: statement, name: statement.name.text } });
      } else if (ts.isVariableStatement(statement) && isExported(statement)) {
        for (const d of statement.declarationList.declarations) {
          if (ts.isIdentifier(d.name) && /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(d.name.text) && d.initializer) handlers.push({ method: d.name.text, fn: lookupHandler(d.initializer) });
        }
      }
    }
    for (const { method, fn } of handlers.sort((a, b) => a.method.localeCompare(b.method))) {
      const id = `${method} ${pattern}`;
      const a = fn ? analyseFunction(fn.file, fn.name, fn.node) : none();
      routeRows.push(finish({
        id, kind: "route", file: rel(file), act: derivedWho(a), guards: [...a.via].sort(), source: "derived",
        ...(a.ownerExtras ? { ownerExtras: true as const } : {}), methods: method,
        changesState: !["GET", "HEAD", "OPTIONS"].includes(method) || id in overrides.getChangesState,
      }, overrides));
      ids.push(id);
    }
    routePatterns.push({ pattern, regex: patternRegex(pattern), ids });
  }

  // which action files and routes each page reaches
  const reach = (start: string) => {
    const seen = new Set<string>([start]);
    const queue = [start];
    const used = new Set<string>();
    const routes = new Set<string>();
    while (queue.length) {
      const file = queue.pop()!;
      const imports = importsOf(file);
      for (const [local, imp] of imports.names) {
        void local;
        const action = actionByFile.get(imp.file);
        if (action && !imp.typeOnly && action.names.includes(imp.name)) used.add(actionId(imp.file, imp.name));
      }
      for (const [, target] of imports.namespaces) {
        const action = actionByFile.get(target);
        if (action) for (const n of action.names) used.add(actionId(target, n));
      }
      for (const target of imports.all) {
        if (seen.has(target) || actionByFile.has(target) || target.includes("/tests/")) continue;
        seen.add(target); queue.push(target);
      }
      const visit = (node: ts.Node) => {
        if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
          if (/^\/(api|v1)\//.test(node.text)) {
            const path = node.text.split(/[?#]/)[0];
            for (const r of routePatterns) if (r.regex.test(path)) for (const id of r.ids) routes.add(id);
          }
        } else if (ts.isTemplateExpression(node) && /^\/(api|v1)\//.test(node.head.text)) {
          // A template with holes names a family of paths: match its fixed parts against each route, holes as one segment.
          const text = node.head.text + node.templateSpans.map(s => `\u0000${s.literal.text}`).join("");
          const fixed = text.split("\u0000").map(part => part.split(/[?#]/)[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
          const query = text.includes("?") || text.includes("#");
          const regex = new RegExp(`^${fixed.join("[^/]*")}${query ? "" : "(?:/|$)"}`);
          for (const r of routePatterns) if (regex.test(r.pattern.replace(/\[(?:\.\.\.)?[^\]]+\]/g, "x"))) for (const id of r.ids) routes.add(id);
        }
        ts.forEachChild(node, visit);
      };
      visit(parse(file));
    }
    return { used: [...used].sort(), routes: [...routes].sort() };
  };

  // actions
  const actionRows = new Map<string, Row>();
  for (const { file, names } of actionFileList) {
    const index = functionIndex(file);
    for (const name of names) {
      const id = actionId(file, name);
      const a = analyseFunction(file, name, index.get(name)!);
      actionRows.set(id, finish({ id, kind: "action", file: rel(file), act: derivedWho(a), guards: [...a.via].sort(), source: "derived", ...(a.ownerExtras ? { ownerExtras: true as const } : {}), usedBy: [] }, overrides));
    }
  }

  // pages and the shared layout
  const pageRows: Row[] = [];
  const pageFiles = walk(join(consoleRoot, "app")).filter(f => /\/(page|layout)\.tsx$/.test(posix(f))).sort();
  for (const file of pageFiles) {
    const isLayout = posix(file).endsWith("/layout.tsx");
    const id = isLayout ? `layout ${pageId(file) === "/" ? "(root)" : pageId(file)}` : pageId(file);
    const fn = defaultExport(file);
    const a = fn ? analyseFunction(file, "default", fn) : none();
    const { used, routes } = reach(file);
    const row: Row = finish({
      id, kind: isLayout ? "layout" : "page", file: rel(file), see: derivedWho(a), act: "none", guards: [...a.via].sort(), source: "derived",
      ...(a.ownerExtras ? { ownerExtras: true as const } : {}), actions: used, routes,
    }, overrides);
    pageRows.push(row);
    for (const u of used) actionRows.get(u)!.usedBy!.push(id);
  }
  // routes used by pages
  for (const row of routeRows) {
    const users = pageRows.filter(p => p.routes!.includes(row.id)).map(p => p.id);
    row.usedBy = users.sort();
  }
  // page "act" and action "see"
  for (const page of pageRows) {
    if (!page.actions!.length) { page.act = "none"; continue; }
    const levels = page.actions!.map(a => actionRows.get(a)!.act);
    if (levels.includes("unknown")) page.act = "unknown";
    else if (page.see === "owner") page.act = "owner";
    else page.act = levels.includes("public") ? "public" : levels.includes("member") ? "member" : "owner";
  }
  const open = (w?: Who) => (w === "public" ? 3 : w === "member" ? 2 : w === "owner" ? 1 : 0);
  const byId = new Map(pageRows.map(p => [p.id, p]));
  for (const action of actionRows.values()) {
    action.usedBy!.sort();
    const seen = action.usedBy!.map(u => byId.get(u)!.see);
    action.see = seen.includes("unknown") ? "unknown" : seen.length ? (["none", "owner", "member", "public"] as const)[Math.max(...seen.map(open))] : "none";
  }
  const byRowId = (a: Row, b: Row) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return {
    note: "Generated by tests/actions/generate.ts. Do not edit by hand; see README.md in this folder.",
    pages: pageRows.sort(byRowId), actions: [...actionRows.values()].sort(byRowId), routes: routeRows.sort(byRowId),
  };
}

/** Apply an override to a row whose guard could not be derived. */
function finish(row: Row, overrides: Overrides): Row {
  const key = row.kind === "page" || row.kind === "layout" ? "see" : "act";
  if (row[key] !== "unknown") return row;
  const o = overrides.guards[row.id];
  if (!o) return { ...row, source: "unknown" };
  return { ...row, [key]: o.level, source: "override", reason: o.reason };
}

export function render(inventory: Inventory): string {
  // One entry per line keeps a diff to the rows that changed; short lists stay on one line.
  const text = JSON.stringify(inventory, null, 2).replace(/\[\n((?:\s+"[^\n"]*",?\n)+)\s*\]/g, (all, body: string) => {
    const items = body.trim().split(/,\n\s*/);
    const line = `[${items.join(", ")}]`;
    return line.length <= 90 ? line : all;
  });
  return `${text}\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const text = render(generate());
  if (process.argv.includes("--write")) { writeFileSync(inventoryPath, text); console.log(`wrote ${rel(inventoryPath)}`); }
  else process.stdout.write(text);
}
