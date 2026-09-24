/** One vault folder ↔ one Notion `Project` select value. Config, never code. */
export interface ProjectMapping {
  notionProject: string;
  vaultFolder: string;
}

/**
 * The wiki mirror (Phase 2), assembled from the flat config keys
 * `docsDataSourceId` / `docsDatabaseId` / `wikiDir` / `wikiProject`. Present only
 * when `docsDataSourceId` is set — its absence is how a Phase 1 deployment says
 * "no wiki pass", and the pass then skips cleanly instead of failing.
 */
export interface WikiConfig {
  /** Data source (collection) id of the Docs database — creates and queries. */
  docsDataSourceId: string;
  /**
   * Database id of Docs. No API call needs it today (creates parent on the data
   * source id), but ops keeps it next to the data source id so the pair stays
   * identifiable — a bare data source id cannot be looked up in the Notion UI.
   */
  docsDatabaseId?: string;
  /** Vault-relative directory the pass mirrors. Defaults to "wiki". */
  wikiDir: string;
  /**
   * The Notion `Project` select value every wiki row carries (config key
   * `wikiProject`). Spec §1: the folder→Project mapping is config, never code.
   */
  project: string;
}

/**
 * One desk folder ↔ the Notion `Project` select value its rows carry (Phase 3).
 * Same "folder→Project is config, never code" rule as `projects[]` and
 * `wikiProject`; the push pass runs the Phase 2 engine once per entry.
 */
export interface DeskDirConfig {
  /** Vault-relative directory, bare (no leading or trailing slash). */
  dir: string;
  project: string;
  /**
   * Dir-relative bare sub-paths carved out of this desk's scope (Phase 4).
   * `{dir: "zero7", exclude: ["transcripts"]}` takes the vault path
   * `zero7/transcripts/**` out of the desk pass entirely, so the transcript
   * pull engine (`transcripts`, below) can own that folder instead of two
   * passes pushing the same files under two different `vault_path`
   * identities. Dir-relative rather than vault-relative so an entry stays
   * self-describing without its parent `dir` alongside it. Absent or `[]`
   * behaves exactly as before this field existed.
   */
  exclude?: string[];
}

/**
 * The desk folders (Phase 3), assembled from the flat config keys `deskDirs` /
 * `twoWayDirs` / `mirrorFilePrefixes`. Present only when `deskDirs` is set — its
 * absence is how a Phase 2 deployment says "no desk folders", and the desk push
 * then skips cleanly, exactly like `wiki`.
 */
export interface DesksConfig {
  deskDirs: DeskDirConfig[];
  /**
   * The pilot dial (spec §18.5): only files under these dirs are eligible for
   * `notion-sync enable-two-way`. Every entry must be one of `deskDirs`' dirs.
   * Being listed here does NOT flip any row on its own — direction changes only
   * through the explicit command, per file, after both fidelity legs pass.
   */
  twoWayDirs: string[];
  /**
   * Vault-path prefixes that stay one-way md→Notion whatever dir they live in
   * (plan decision 8 — e.g. a folder's machine-generated files). `enable-two-way`
   * refuses them, so their direction never leaves `md_to_notion`.
   */
  mirrorFilePrefixes: string[];
}

/**
 * The transcript pull (Phase 4): Meetings rows land at
 * `<vaultFolder>/<dir>/<date>-<slug>.md`, one `dir` shared by every project
 * (config key `transcripts.dir`, default "transcripts"). The `transcripts`
 * object itself is the presence flag — its absence is how a deployment says
 * "no transcript pass", and the pass then skips cleanly, exactly like `wiki`
 * and `desks`. `meetingsDataSourceId` (top-level) is the data source this
 * pass reads from; it is not repeated here.
 */
export interface TranscriptsConfig {
  /** Vault-relative sub-folder inside each project folder. Defaults to "transcripts". */
  dir: string;
  /**
   * Notion `Project` select value -> vault project folder, scoped to the
   * transcript pull. Same shape as the top-level `projects`, because both
   * answer "which vault folder does this Project belong to" for two
   * different passes reading two different databases.
   */
  projects: ProjectMapping[];
}

/**
 * The People projection (Phase 4, spec §8.3): populated from
 * `services/network` + Twenty, keyed by email, read-mostly — never a fourth
 * contact store, and commercial-relationship promotion still happens in
 * Twenty. The `people` object itself is the presence flag; its absence is
 * how a deployment says "no People pass", same contract as `wiki`/`desks`/
 * `transcripts`.
 */
export interface PeopleConfig {
  /** Data source (collection) id of the People database — creates and queries. */
  dataSourceId: string;
  /**
   * Database id of People. No API call needs it today (creates parent on the
   * data source id), but ops keeps it next to the data source id so the pair
   * stays identifiable — a bare data source id cannot be looked up in the
   * Notion UI. Same rationale as `WikiConfig.docsDatabaseId`.
   */
  databaseId?: string;
}

export interface NotionSyncConfig {
  /** Pinned Notion API version. Must be >= MIN_NOTION_VERSION. */
  notionVersion: string;
  /** Data source (collection) id of the Meetings database. */
  meetingsDataSourceId: string;
  vaultPath: string;
  /**
   * The owner's own address(es) — sorted last in the attendee string. A principal
   * with enrolled mailboxes in more than one org has more than one, and a meeting in
   * the second org would otherwise sort the owner mid-list. The config key is
   * `selfEmail` and accepts either a single string or a list.
   *
   * The CLI additionally unions this with every mailbox address the calendar
   * resolver actually resolves, so the config only has to name aliases it cannot see.
   */
  selfEmails: string[];
  projects: ProjectMapping[];
  /** How far back to fetch calendar events when matching. */
  calendarWindowDays: number;
  /** The wiki one-way md→Notion pass. Absent ⇒ the pass logs a skip and does nothing. */
  wiki?: WikiConfig;
  /** The desk folders (Phase 3). Absent ⇒ the desk push logs a skip and does nothing. */
  desks?: DesksConfig;
  /** The transcript pull (Phase 4). Absent ⇒ the pass logs a skip and does nothing. */
  transcripts?: TranscriptsConfig;
  /** The People projection (Phase 4). Absent ⇒ the pass logs a skip and does nothing. */
  people?: PeopleConfig;
}
