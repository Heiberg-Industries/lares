/**
 * Where the digest files articles: the installation's setting, and whether this agent may use it.
 *
 * THE SETTING. One installation-level choice, `LARES_ARTICLE_AREA`: `shared` (the engine default)
 * or `private`. It is an environment setting on the filing agent, bound by the keeper with the
 * agent's other installation settings, so changing it needs no migration and no new screen. An
 * installation whose shared folder is not writable for the filing agent sets `private`; the digest
 * then files privately without a warning on every pass. A value this code does not know is read as
 * `private` (the narrower choice) and logged.
 *
 * THE SHARED AGENT. Which agent files into the shared area is the installation's choice, expressed
 * only through that agent's own `vault` grant in its definition (ADR-0017, amendment 2026-10-09;
 * the default is the chief of staff). So the shared root is offered to the filer only when the
 * running agent's definition grants WRITE on the `shared` area. Otherwise the filer is given no
 * shared root: it files privately and the pass says so, because the setting asked for shared.
 * Nothing here adds to a grant; it only reads one, and an unreadable definition is not an open
 * door.
 */
import { canWriteVaultArea, type AgentManifest } from "@lares/agent-kit/manifest";

import type { ArticleArea } from "./article.js";

export interface ArticleAreaSetting {
  area: ArticleArea;
  /** The value that was set but is not `shared` or `private`; the area is then `private`. */
  unrecognised?: string;
}

/** The setting as the environment has it. Unset or blank is the engine default, `shared`. */
export function readArticleAreaSetting(env: NodeJS.ProcessEnv = process.env): ArticleAreaSetting {
  const raw = (env["LARES_ARTICLE_AREA"] ?? "").trim().toLowerCase();
  if (raw === "" || raw === "shared") return { area: "shared" };
  if (raw === "private") return { area: "private" };
  return { area: "private", unrecognised: raw };
}

export interface ArticleTargets {
  articleArea: ArticleArea;
  /** The shared area's root when the filer may write there, otherwise undefined. */
  sharedRoot: string | undefined;
}

/**
 * The article area for one pass and the shared root the filer may use. Read once at the start of a
 * pass, so a pass is consistent with itself.
 */
export async function articleTargets(deps: {
  env?: NodeJS.ProcessEnv;
  /** The running agent's definition (its grants). */
  readDefinition: () => Promise<AgentManifest>;
  /** The shared area's root, or undefined when it is not connected. */
  resolveShared: () => string | undefined;
  log: (message: string) => void;
}): Promise<ArticleTargets> {
  const setting = readArticleAreaSetting(deps.env ?? process.env);
  if (setting.unrecognised !== undefined) {
    deps.log(`articles: LARES_ARTICLE_AREA is "${setting.unrecognised}", which is not shared or private; filing privately`);
  }
  if (setting.area === "private") return { articleArea: "private", sharedRoot: undefined };

  let mayWrite = false;
  try {
    mayWrite = canWriteVaultArea(await deps.readDefinition(), "shared");
  } catch (e) {
    deps.log(`articles: could not read this agent's definition (${String(e instanceof Error ? e.message : e)}); filing privately`);
    return { articleArea: "shared", sharedRoot: undefined };
  }
  if (!mayWrite) {
    deps.log("articles: this agent has no write grant on the shared area; filing privately");
    return { articleArea: "shared", sharedRoot: undefined };
  }
  return { articleArea: "shared", sharedRoot: deps.resolveShared() };
}
