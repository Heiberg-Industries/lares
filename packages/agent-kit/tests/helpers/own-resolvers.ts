/**
 * Every file in a role's `agent/` that hands a conversation something outside the catalogue: the
 * own-resolver tools (`agent/tools/*.ts`, less the catalogue resolver itself), the skills
 * (`agent/skills/*.ts`) and the connections (`agent/connections/*.ts`). Read from disk, so a file
 * added tomorrow is in the list without anyone editing a test.
 */
import { readdirSync } from "node:fs";
import { runDynamic } from "./eve-dynamic.js";

export type OwnResolverKind = "tools" | "skills" | "connections";
export interface OwnResolverFile { readonly kind: OwnResolverKind; readonly name: string; readonly url: URL }

export function ownResolverFiles(agentDir: URL): OwnResolverFile[] {
  const files: OwnResolverFile[] = [];
  for (const kind of ["tools", "skills", "connections"] as const) {
    const dir = new URL(`${kind}/`, agentDir);
    for (const entry of readdirSync(dir).sort()) {
      if (!entry.endsWith(".ts") || entry.endsWith(".d.ts")) continue;
      const name = entry.slice(0, -".ts".length);
      if (kind === "tools" && name === "catalogue") continue;
      files.push({ kind, name, url: new URL(entry, dir) });
    }
  }
  return files;
}

/**
 * What one file offers this session, by the name the room rule is asked about: each tool's key for
 * a file that returns several, the file's name for a skill or a single tool, and `connection <name>`
 * for a connection (no connection is on the room list). Nothing offered is an empty list.
 */
export async function offeredBy(file: OwnResolverFile, session: Record<string, unknown>): Promise<string[]> {
  const value = await runDynamic((await import(file.url.href)).default, session);
  if (value === null || value === undefined) return [];
  if (file.kind === "connections") return [`connection ${file.name}`];
  if (file.kind === "skills") return [file.name];
  if (typeof (value as { execute?: unknown }).execute === "function") return [file.name];
  return Object.keys(value as Record<string, unknown>);
}
