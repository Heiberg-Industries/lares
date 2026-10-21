import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
const app = new URL("../app/", import.meta.url).pathname;
function files(folder: string): string[] {
  return readdirSync(folder, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(folder, entry.name)) : [join(folder, entry.name)]);
}
function syntax(path: string) { return ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, path.endsWith("tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS); }
function functions(source: ts.SourceFile) { return source.statements.filter(ts.isFunctionDeclaration); }
function exported(fn: ts.FunctionDeclaration) { return fn.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword); }
function awaits(node: ts.Node | undefined, names: Set<string>): boolean {
  if (!node) return false;
  if (ts.isAwaitExpression(node) && ts.isCallExpression(node.expression) && ts.isIdentifier(node.expression.expression) && names.has(node.expression.expression.text)) return true;
  let found = false; node.forEachChild(child => { if (awaits(child, names)) found = true; }); return found;
}
const guards = new Set(["verify", "requireConsolePage", "requireConsoleMember", "requireMember", "credentialActor"]);
function localGuards(source: ts.SourceFile) {
  const result = new Set(guards);
  for (const fn of functions(source)) {
    if (fn.name && (awaits(fn.body?.statements[0], guards) || fn.body?.statements[0]?.getText(source).startsWith("return verify("))) {
      // Helpers returning nullable legacy transport identity must also refuse its absence.
      const text = fn.body?.getText(source) ?? "";
      if (text.includes("throw") || text.includes("return verify(")) result.add(fn.name.text);
    }
  }
  return result;
}
describe("all console member entry points guard before reading data", () => {
  for (const file of files(app).filter(p => p.endsWith("/page.tsx"))) {
    const path = relative(app, file);
    if (path === "invite/page.tsx") continue; // Public bearer-invitation explanation, no data lookup.
    it(`page ${path}`, () => {
      const source = syntax(file);
      const fn = functions(source).find(exported)!;
      const expected = path === "sign-in/page.tsx" ? "signedInMember" : path === "membership/page.tsx" ? "requireMember" : "requireConsolePage";
      // Sign-in reads only its query parameters before checking admission; every data page
      // awaits its guard as its first statement, before invoking any data reader.
      const first = path === "sign-in/page.tsx" ? fn.body!.statements[1] : fn.body!.statements[0];
      expect(awaits(first, new Set([expected]))).toBe(true);
    });
  }
  for (const file of files(join(app, "actions")).filter(p => p.endsWith(".ts"))) {
    const source = syntax(file), accepted = localGuards(source);
    for (const fn of functions(source).filter(exported)) {
      it(`action ${relative(app, file)}:${fn.name!.text}`, () => {
        expect(awaits(fn.body?.statements[0], accepted), "first statement must await current DB admission, including delegated keeper calls").toBe(true);
      });
    }
  }
  for (const file of files(join(app, "api")).filter(p => p.endsWith("/route.ts"))) {
    const path = relative(app, file);
    if (path === "api/auth/[...route]/route.ts") continue; // OIDC, state and revocation tests exercise this public flow.
    if (path === "api/doors/[name]/[kind]/events/route.ts") {
      it("platform webhook delegates to its original platform authentication boundary", () => {
        expect(readFileSync(file, "utf8")).toContain("return forwardDoor(request,name,kind");
        const source = readFileSync(new URL("../lib/door-forwarder.ts", import.meta.url), "utf8");
        expect(source).toMatch(/slack|telegram/);
      });
      continue;
    }
    if (path === "api/chat/[name]/[...path]/route.ts") {
      it("chat route delegates current admission before the proxy reads data or forwards", () => {
        const source = readFileSync(file, "utf8");
        expect(source).toContain('signedInEmail: async () => verify((await cookies()).get("lares_session")?.value)');
        const proxy = syntax(new URL("../lib/chat-proxy.ts", import.meta.url).pathname);
        const fn = functions(proxy).find(fn => fn.name?.text === "forwardChat")!;
        expect(fn.body!.statements[0].getText(proxy)).toContain("await deps.signedInMember()");
        expect(fn.body!.statements[1].getText(proxy)).toMatch(/if \(!stableMember\).*refuse\(401/s);
      });
      continue;
    }
    const source = syntax(file), accepted = localGuards(source);
    expect(functions(source).filter(exported)).toHaveLength(0);
    for (const statement of source.statements.filter(ts.isVariableStatement).filter(node => node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword))) {
      for (const declaration of statement.declarationList.declarations) {
        if (!/^(GET|POST|PUT|PATCH|DELETE)$/.test(declaration.name.getText(source))) continue;
        expect(declaration.initializer?.getText(source)).toMatch(/^withConsoleAdmission\(/);
      }
    }
    expect(readFileSync(file, "utf8")).toMatch(/export const (?:GET|POST) = withConsoleAdmission\(/);
    for (const fn of functions(source).filter(fn => /^handle(?:GET|POST)$/.test(fn.name?.text ?? ""))) {
      it(`API ${path}:${fn.name!.text}`, () => { expect(awaits(fn.body?.statements[0], accepted)).toBe(true); });
    }
  }
  it("credentialActor itself performs current Node admission", () => {
    const source = readFileSync(new URL("../lib/credentials.ts", import.meta.url), "utf8");
    expect(source).toContain(`await verify((await cookies()).get('lares_session')?.value)`);
  });
});
