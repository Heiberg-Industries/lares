import { readFileSync } from "node:fs";
import type {
  DeskDirConfig, DesksConfig, NotionSyncConfig, PeopleConfig, ProjectMapping, TranscriptsConfig, WikiConfig,
} from "./types.js";

const DEFAULT_CONFIG_PATH = "/etc/lares/notion-sync.config.json";
const DEFAULT_WINDOW_DAYS = 400;
const DEFAULT_WIKI_DIR = "wiki";
const DEFAULT_TRANSCRIPTS_DIR = "transcripts";

/** The Markdown Content endpoints do not exist before this version (spec §2). */
export const MIN_NOTION_VERSION = "2026-03-11";

function requireString(obj: Record<string, unknown>, key: string, where: string): string {
  const value = obj[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`notion-sync config: ${where}.${key} must be a non-empty string`);
  }
  return value;
}

/**
 * Reads `selfEmail`, which is either one address or a list of them. A principal with
 * enrolled mailboxes in several orgs owns several addresses; the single-string form
 * stays valid because a one-org deployment has no reason to write a list.
 */
function requireSelfEmails(root: Record<string, unknown>): string[] {
  const raw = root.selfEmail;
  if (!Array.isArray(raw)) return [requireString(root, "selfEmail", "config")];
  if (raw.length === 0) {
    throw new Error("notion-sync config: selfEmail must be a non-empty array when given as a list");
  }
  return raw.map((value, i) => {
    if (typeof value !== "string" || value.trim() === "") {
      throw new Error(`notion-sync config: selfEmail[${i}] must be a non-empty string`);
    }
    return value;
  });
}

/**
 * Parses a `{notionProject, vaultFolder}[]` mapping — the shape the top-level
 * `projects` list and `transcripts.projects` (Phase 4) share, because both
 * answer the same question ("which vault folder does this Notion Project
 * select value belong to?") for two different passes reading two different
 * databases. One parser, so a malformed entry reads the same wherever the
 * shape appears, and a duplicate `notionProject` is caught the same way too.
 */
function parseProjectMappings(raw: unknown, where: string): ProjectMapping[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(`notion-sync config: ${where} must be a non-empty array`);
  }
  const mappings: ProjectMapping[] = raw.map((entry, i) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(`notion-sync config: ${where}[${i}] must be an object`);
    }
    const o = entry as Record<string, unknown>;
    return {
      notionProject: requireString(o, "notionProject", `${where}[${i}]`),
      vaultFolder: requireString(o, "vaultFolder", `${where}[${i}]`),
    };
  });

  const seen = new Set<string>();
  for (const p of mappings) {
    if (seen.has(p.notionProject)) {
      throw new Error(`notion-sync config: duplicate notionProject "${p.notionProject}" in ${where}`);
    }
    seen.add(p.notionProject);
  }
  return mappings;
}

/**
 * Assembles the optional wiki-pass group (Phase 2). `docsDataSourceId` is the
 * presence flag: absent, the wiki pass is not configured and skips cleanly, so
 * every Phase 1 config file stays valid unchanged. A wiki key WITHOUT the data
 * source id is rejected rather than ignored — a typo'd `docsDataSourceId` would
 * otherwise turn "configured" into "silently skips every tick forever", the
 * worst failure mode a config can have.
 */
function parseWikiConfig(root: Record<string, unknown>): WikiConfig | undefined {
  if (root.docsDataSourceId === undefined) {
    for (const key of ["docsDatabaseId", "wikiDir", "wikiProject"]) {
      if (root[key] !== undefined) {
        throw new Error(
          `notion-sync config: ${key} is set but docsDataSourceId is not — ` +
          `the wiki pass only runs when docsDataSourceId is present`,
        );
      }
    }
    return undefined;
  }
  const wikiDir = root.wikiDir === undefined
    ? DEFAULT_WIKI_DIR
    : requireString(root, "wikiDir", "config");
  // vault_path (the store's join key) and the Notion Folder property are both
  // built as `${wikiDir}/...`, so a leading or trailing slash would silently
  // corrupt every identity the pass writes on both sides.
  if (wikiDir.startsWith("/") || wikiDir.endsWith("/")) {
    throw new Error(
      `notion-sync config: wikiDir must be a bare vault-relative folder path, got "${wikiDir}"`,
    );
  }
  return {
    docsDataSourceId: requireString(root, "docsDataSourceId", "config"),
    ...(root.docsDatabaseId === undefined
      ? {}
      : { docsDatabaseId: requireString(root, "docsDatabaseId", "config") }),
    wikiDir,
    // The engine calls it `project`; the config key is `wikiProject` to keep it
    // visually distinct from the per-brand `projects` mapping list beside it.
    project: requireString(root, "wikiProject", "config"),
  };
}

/**
 * A vault-relative directory that can safely be used as a `vault_path` prefix:
 * bare, no leading or trailing slash, non-empty, not a relative-path escape, and
 * not padded with whitespace. The same rule wikiDir already carries, for the same
 * reason — `${dir}/...` is the identity every store row and Notion `Folder` value
 * is built from.
 *
 * The whitespace check is separate, and loud, because it is the ONE malformation
 * an operator cannot see (Phase 4 review): `"transcripts "` is a non-empty string
 * with no slash edges and no `..`, so every other guard here passes it — and the
 * value it then produces (`zero7/transcripts `) matches no file and no row, which
 * turns a `deskDirs[].exclude` entry into a silent no-op. For that field a silent
 * no-op is the exact catastrophe the exclusion exists to prevent, so this refuses
 * rather than trims: a config file that says something it does not mean is a
 * mistake to show the operator, never one to quietly correct underneath them.
 * (Trimming in `requireString` instead would have silently normalised every
 * string in the file — ids, emails, project names — which is the same quiet
 * correction, applied far more widely.)
 *
 * Only the EDGES: an inner space is legitimate, and a real desk folder has one.
 */
function requireBareDir(obj: Record<string, unknown>, key: string, where: string): string {
  const value = requireString(obj, key, where);
  if (value !== value.trim()) {
    throw new Error(
      `notion-sync config: ${where}.${key} has leading or trailing whitespace ` +
      `(${JSON.stringify(value)}) — it would silently match nothing; write it without the padding`,
    );
  }
  if (value.startsWith("/") || value.endsWith("/") || value === "." || value.split("/").includes("..")) {
    throw new Error(
      `notion-sync config: ${where}.${key} must be a bare vault-relative folder path, got "${value}"`,
    );
  }
  return value;
}

/** True when two vault dirs are the same folder, or one contains the other. */
function dirsOverlap(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/**
 * `deskDirs[i].exclude` (Phase 4): dir-relative bare sub-paths carved out of
 * one desk's scope. For `{dir: "zero7", exclude: ["transcripts"]}` this takes
 * the vault path `zero7/transcripts/**` out of the desk pass entirely, so the
 * transcript pull engine can own that folder instead of two passes pushing
 * the same files under two different `vault_path` identities.
 *
 * Each entry is validated with the same requireBareDir rule as `dir` itself
 * (reused, not reimplemented), then the list is checked against itself with
 * dirsOverlap — `["a", "a/b"]` is a configuration mistake worth failing
 * loudly on, same spirit as the deskDirs-vs-deskDirs overlap check below.
 * (dirsOverlap treats equal strings as overlapping, so an exact duplicate
 * like `["a", "a"]` is caught by the same loop, not a separate one.)
 * Absent or `[]` returns `[]` — the caller omits the field in that case, so
 * behaviour stays byte-identical to before this field existed.
 */
function parseExcludeDirs(raw: unknown, deskIndex: number): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new Error(
      `notion-sync config: deskDirs[${deskIndex}].exclude must be an array of dir-relative sub-paths`,
    );
  }
  const exclude = raw.map((value, j) => {
    const entryKey = `exclude[${j}]`;
    return requireBareDir({ [entryKey]: value }, entryKey, `deskDirs[${deskIndex}]`);
  });
  for (const [j, dir] of exclude.entries()) {
    for (const other of exclude.slice(0, j)) {
      if (dirsOverlap(dir, other)) {
        throw new Error(
          `notion-sync config: deskDirs[${deskIndex}].exclude "${dir}" and "${other}" overlap — ` +
          `list each excluded sub-path once`,
        );
      }
    }
  }
  return exclude;
}

/**
 * Assembles the optional desk-folder group (Phase 3). `deskDirs` is the presence
 * flag — the same shape as parseWikiConfig's `docsDataSourceId`, and for the same
 * reason: a typo'd key must fail loudly rather than turn "configured" into
 * "silently skips every tick forever".
 *
 * Desk rows live in the SAME Notion Docs database as the wiki mirror (spec
 * §18.1), so `docsDataSourceId` — i.e. a parsed `wiki` group — is a hard
 * precondition rather than an independent switch. Dirs may not overlap the wiki
 * dir or each other: a file reachable from two dirs would be pushed twice, under
 * two `vault_path` identities, and so as two Notion pages.
 */
function parseDesksConfig(root: Record<string, unknown>, wiki: WikiConfig | undefined): DesksConfig | undefined {
  if (root.deskDirs === undefined) {
    for (const key of ["twoWayDirs", "mirrorFilePrefixes"]) {
      if (root[key] !== undefined) {
        throw new Error(
          `notion-sync config: ${key} is set but deskDirs is not — ` +
          `the desk passes only run when deskDirs is present`,
        );
      }
    }
    return undefined;
  }

  if (wiki === undefined) {
    throw new Error(
      "notion-sync config: deskDirs is set but docsDataSourceId is not — " +
      "desk folders sync into the same Docs database as the wiki mirror",
    );
  }

  const raw = root.deskDirs;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error("notion-sync config: deskDirs must be a non-empty array");
  }
  const deskDirs: DeskDirConfig[] = raw.map((entry, i) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(`notion-sync config: deskDirs[${i}] must be an object`);
    }
    const o = entry as Record<string, unknown>;
    const exclude = parseExcludeDirs(o.exclude, i);
    return {
      dir: requireBareDir(o, "dir", `deskDirs[${i}]`),
      project: requireString(o, "project", `deskDirs[${i}]`),
      ...(exclude.length === 0 ? {} : { exclude }),
    };
  });

  for (const [i, entry] of deskDirs.entries()) {
    if (dirsOverlap(entry.dir, wiki.wikiDir)) {
      throw new Error(
        `notion-sync config: deskDirs[${i}].dir "${entry.dir}" overlaps wikiDir "${wiki.wikiDir}" — ` +
        `a file must belong to exactly one directory`,
      );
    }
    for (const other of deskDirs.slice(0, i)) {
      if (dirsOverlap(entry.dir, other.dir)) {
        throw new Error(
          `notion-sync config: deskDirs "${entry.dir}" and "${other.dir}" overlap — ` +
          `a file must belong to exactly one directory`,
        );
      }
    }
  }

  const dirs = new Set(deskDirs.map((entry) => entry.dir));
  const twoWayRaw = root.twoWayDirs ?? [];
  if (!Array.isArray(twoWayRaw)) {
    throw new Error("notion-sync config: twoWayDirs must be an array of desk dir names");
  }
  const twoWayDirs = twoWayRaw.map((value, i) => {
    if (typeof value !== "string" || !dirs.has(value)) {
      throw new Error(
        `notion-sync config: twoWayDirs[${i}] must be one of the deskDirs dirs ` +
        `(${[...dirs].join(", ")}), got ${JSON.stringify(value)}`,
      );
    }
    return value;
  });

  const prefixesRaw = root.mirrorFilePrefixes ?? [];
  if (!Array.isArray(prefixesRaw)) {
    throw new Error("notion-sync config: mirrorFilePrefixes must be an array of vault-path prefixes");
  }
  const mirrorFilePrefixes = prefixesRaw.map((value, i) => {
    if (typeof value !== "string" || value.trim() === "" || value.startsWith("/")) {
      throw new Error(
        `notion-sync config: mirrorFilePrefixes[${i}] must be a non-empty vault-relative path prefix`,
      );
    }
    return value;
  });

  return { deskDirs, twoWayDirs, mirrorFilePrefixes };
}

/**
 * Assembles the optional transcript-pull group (Phase 4). Unlike wiki/desks,
 * the `transcripts` object itself is the presence flag: every field it needs
 * lives nested inside it, so there is no flat sibling key a typo could leave
 * dangling outside the section. Absent ⇒ the transcript pass does not run,
 * the same "log and continue" contract as wiki and desks. Meetings is
 * already top-level (`meetingsDataSourceId`) and read directly by the
 * transcript pass, so it is not repeated here — this section only says where
 * pulled rows land.
 */
function parseTranscriptsConfig(root: Record<string, unknown>): TranscriptsConfig | undefined {
  if (root.transcripts === undefined) return undefined;
  if (typeof root.transcripts !== "object" || root.transcripts === null || Array.isArray(root.transcripts)) {
    throw new Error("notion-sync config: transcripts must be an object");
  }
  const o = root.transcripts as Record<string, unknown>;

  const dir = o.dir === undefined ? DEFAULT_TRANSCRIPTS_DIR : requireBareDir(o, "dir", "transcripts");

  return {
    dir,
    projects: parseProjectMappings(o.projects, "transcripts.projects"),
  };
}

/**
 * Assembles the optional People-projection group (Phase 4, spec §8.3). The
 * `people` object is the presence flag — absent, the People pass does not
 * run and the vault gains no fourth contact store by omission. Once present,
 * `dataSourceId` is required rather than defaulted or inferred — the same
 * `docsDataSourceId` precedent as parseWikiConfig, and for the same reason: a
 * typo'd or forgotten id would otherwise turn "configured" into "silently
 * skips every tick forever", the worst failure mode a config can have.
 * `databaseId` is optional ops convenience, same rationale as
 * `WikiConfig.docsDatabaseId`.
 */
function parsePeopleConfig(root: Record<string, unknown>): PeopleConfig | undefined {
  if (root.people === undefined) return undefined;
  if (typeof root.people !== "object" || root.people === null || Array.isArray(root.people)) {
    throw new Error("notion-sync config: people must be an object");
  }
  const o = root.people as Record<string, unknown>;
  return {
    dataSourceId: requireString(o, "dataSourceId", "people"),
    ...(o.databaseId === undefined ? {} : { databaseId: requireString(o, "databaseId", "people") }),
  };
}

export function parseNotionSyncConfig(raw: unknown): NotionSyncConfig {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("notion-sync config: root must be an object");
  }
  const root = raw as Record<string, unknown>;

  const notionVersion = requireString(root, "notionVersion", "config");
  // Notion versions are ISO dates, so lexicographic comparison is chronological.
  if (notionVersion < MIN_NOTION_VERSION) {
    throw new Error(
      `notion-sync config: notionVersion must be >= ${MIN_NOTION_VERSION} ` +
      `(Markdown Content API), got ${notionVersion}`,
    );
  }

  const projects = parseProjectMappings(root.projects, "projects");

  const windowRaw = root.calendarWindowDays ?? DEFAULT_WINDOW_DAYS;
  if (typeof windowRaw !== "number" || !Number.isFinite(windowRaw) || windowRaw <= 0) {
    throw new Error("notion-sync config: calendarWindowDays must be a positive number");
  }

  const wiki = parseWikiConfig(root);
  const desks = parseDesksConfig(root, wiki);
  const transcripts = parseTranscriptsConfig(root);
  const people = parsePeopleConfig(root);

  return {
    notionVersion,
    meetingsDataSourceId: requireString(root, "meetingsDataSourceId", "config"),
    vaultPath: requireString(root, "vaultPath", "config"),
    selfEmails: requireSelfEmails(root),
    projects,
    calendarWindowDays: windowRaw,
    ...(wiki === undefined ? {} : { wiki }),
    ...(desks === undefined ? {} : { desks }),
    ...(transcripts === undefined ? {} : { transcripts }),
    ...(people === undefined ? {} : { people }),
  };
}

export function loadNotionSyncConfig(
  path: string = process.env.NOTION_SYNC_CONFIG ?? DEFAULT_CONFIG_PATH,
): NotionSyncConfig {
  return parseNotionSyncConfig(JSON.parse(readFileSync(path, "utf8")));
}
