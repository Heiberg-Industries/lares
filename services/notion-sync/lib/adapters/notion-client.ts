// The ONLY file that knows Notion's HTTP shape. Lives under adapters/ so the
// vendor-neutrality test exempts it (spec §11).
//
// Markdown Content API shapes (getPageMarkdown / patchPageMarkdown / createDocPage)
// verified against developers.notion.com on 2026-08-04 — reference pages
// retrieve-page-markdown, update-page-markdown, post-page — matching the live probe
// recorded in the Phase 2 plan. Do not adjust them from memory.

export interface NotionMeetingRow {
  pageId: string;
  lastEditedTime: string;
  /** ORB-27 — see MeetingRow's twins in lib/attendees.ts; read here, decided there. */
  hasSummary: boolean;
  status: string | null;
  statusType: "status" | "select";
  /** `created_time` — the last-resort time source, and the starvation window's clock. */
  createdAt: string;
  /**
   * The `Meeting Title` property, VERBATIM — date mention text and all. It is the
   * transcript's H1 and its filename stem, and every transcript already on disk was
   * named from it, so it must keep saying exactly what it said before ORB-155.
   * The matcher reads `matchTitle` instead.
   */
  title: string;
  /**
   * The same title with Notion's date MENTIONS removed (ORB-155). A mention's
   * `plain_text` is the raw ISO string, so today's Folkepuls title reads
   * "Folkepuls 2026-08-24T10:00:00.000+02:00" — seven words of date noise around
   * one real word. Fed to the title tie-break, the event "Folkepuls" scores 1/7,
   * under the 0.5 gate, so the tie-break could never separate anything again.
   * Stripped STRUCTURALLY (the item's type says it is a date) rather than by
   * regexing a shape out of the flattened text.
   */
  matchTitle: string;
  project: string | null;
  /**
   * When the meeting started, from the best source available — see
   * `deriveMeetingStart`. NOT the raw `Date` property any more (ORB-155).
   */
  startsAt: string | null;
  /** Which source `startsAt` came from. Governs tolerance, the title gate and write-back. */
  startsAtSource: StartsAtSource;
  /**
   * Does the `Date` property already hold a datetime? The write-back's whole
   * permission: an existing datetime is never overwritten, a date-only value (or a
   * missing one) may be upgraded to the matched event's start.
   */
  dateHasTime: boolean;
  attendees: string;
  /**
   * The `Series` rich_text — the calendar recurring-event id this meeting belongs to
   * (ORB-156). "" when the row predates the property, or when the meeting is a one-off.
   * Both read as "not part of a series", which is the safe answer: ORB-156 never grants
   * autonomy to a row that cannot name its series.
   */
  series: string;
  /**
   * The `People` RELATION as Notion currently holds it (Phase 4, T7) — the page
   * ids of the People rows this meeting is linked to. Empty when the property
   * does not exist on the database yet, which is what makes the People pass safe
   * to ship before the property is added: it READS as "no links", and only a
   * write would fail.
   */
  people: string[];
  /**
   * Notion returns at most 25 relation targets inline and sets `has_more` when
   * there are more. A truncated read cannot be compared against a desired set
   * without risking a write that DROPS the links it could not see, so the People
   * pass refuses to touch such a row rather than guessing at the rest.
   */
  peopleTruncated: boolean;
  /** `People Unmatched` rich_text — the flag half of blank-and-flag (T7). */
  peopleUnmatched: string;
}

/**
 * One row of the People database as the projection reads it (Phase 4, T7).
 *
 * `Email` and `Source ID` are BOTH read because they are two independent
 * identities for the same row, and the pass needs both: `Source ID` is the
 * source system's own record id (stable across an email change), `Email` is
 * what an attendee string can be matched on. A row carrying neither cannot be
 * indexed at all and is left alone.
 */
export interface NotionPersonRow {
  pageId: string;
  name: string;
  /** `Email` property, lower-cased here so every comparison downstream is on one form. */
  email: string;
  /** `Source` select — which system this row is projected FROM. "" when unset. */
  source: string;
  /** `Source ID` rich_text — that system's record id. "" when unset (a hand-made row). */
  sourceId: string;
}

/**
 * The People-database properties this service owns. Keys are engine vocabulary;
 * the Notion property names they map to (Name/Email/Source/Source ID) are part of
 * the database contract documented in the README, exactly like Meetings'
 * `Attendees` and Docs' `Name`/`Project`/`Folder`/`Vault Path`.
 *
 * FOUR properties and no more, deliberately. Every one of them is a value the
 * source system holds verbatim, so nothing about a person can originate here —
 * which is the whole point of a projection (spec §8.3). Company, LinkedIn and
 * relationship strength were all available and all left out: they would each need
 * either a second API call or a judgement, and every extra projected field is one
 * more thing that can drift away from the system that actually owns it.
 */
export interface PersonPageProps {
  name: string;
  /** Primary address, lower-cased. The projection's match key. */
  email: string;
  /** Human-readable source label (e.g. "Twenty"). Supplied by the source adapter. */
  source: string;
  /** The source system's record id — the pointer back to where this is editable. */
  sourceId: string;
}

export interface NotionDocRow {
  pageId: string;
  lastEditedTime: string;
  /** The join key back to the vault — empty when the row was created by hand. */
  vaultPath: string;
  /**
   * The three properties a Notion-BORN page is placed by (Phase 4, T6): its `Name`
   * becomes the file's title and slug, and `Project`/`Folder` decide the folder.
   *
   * Read on every Docs query rather than by a second reader, because the pass that
   * needs them (`notion-born-sync.ts`) selects on `vaultPath === ""` — the same row
   * this mapper already produces. A page that HAS a vault path ignores all three.
   */
  title: string;
  /** `Project` select. NULL is a real state: a page a human made may carry none. */
  project: string | null;
  /** `Folder` rich_text — free text, vault-relative; overrides Project when filled. */
  folder: string;
}

/**
 * The Docs-database properties this service owns. Keys are engine vocabulary;
 * the Notion property names they map to (Name/Project/Folder/Vault Path/
 * Frontmatter/Archived) are part of the database contract documented in the
 * README, same as Meetings' `Attendees`.
 */
export interface DocPageProps {
  name: string;
  project: string;
  folder: string;
  vaultPath: string;
  /** Raw YAML frontmatter, preserved verbatim (spec §4.1). */
  frontmatter: string;
  archived: boolean;
  /**
   * Mirror-stamp marker (e.g. "mirror") — a `select` property, added to the
   * Docs DB schema by hand at deploy (plan-context §5, not by this service).
   * Optional: only mirror rows carry it, and `docProperties` only emits it
   * when set, same partial contract as every other field here.
   */
  sync?: string;
}

export interface NotionClientOptions {
  token: string;
  /** Pinned API version, e.g. "2026-03-11". */
  version: string;
  fetchImpl?: typeof globalThis.fetch;
  baseUrl?: string;
  /** Minimum gap between requests. Notion sustains ~3 req/s. */
  minIntervalMs?: number;
}

const NOTION_API = "https://api.notion.com";
const DEFAULT_MIN_INTERVAL_MS = 350;
const MAX_ATTEMPTS = 4;

/**
 * Notion caps `text.content` at 2000 characters per rich-text item. One long
 * value (a data-heavy frontmatter block, say) would otherwise fail the whole
 * page write with a validation error, so values are split across items —
 * Notion renders consecutive items seamlessly, and plainText() joins them
 * back on read. An empty value yields an empty array, which is Notion's
 * representation of a cleared property (not a zero-length text item).
 */
const RICH_TEXT_MAX_CHARS = 2000;

type RichTextItem = { type: "text"; text: { content: string } };

function richText(value: string): RichTextItem[] {
  const items: RichTextItem[] = [];
  for (let i = 0; i < value.length; i += RICH_TEXT_MAX_CHARS) {
    items.push({ type: "text", text: { content: value.slice(i, i + RICH_TEXT_MAX_CHARS) } });
  }
  return items;
}

function plainText(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .map((part) => {
      const text = (part as { plain_text?: unknown }).plain_text;
      return typeof text === "string" ? text : "";
    })
    .join("");
}

/**
 * Property-value JSON per the create-a-page reference: title/rich_text carry
 * text-item arrays, select is `{ name }`, checkbox a bare boolean. Partial on
 * purpose — updateDocProps must be able to flip `Archived` without re-sending
 * (and so re-asserting) every other property.
 */
function docProperties(props: Partial<DocPageProps>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (props.name !== undefined) out.Name = { title: richText(props.name) };
  if (props.project !== undefined) out.Project = { select: { name: props.project } };
  if (props.folder !== undefined) out.Folder = { rich_text: richText(props.folder) };
  if (props.vaultPath !== undefined) out["Vault Path"] = { rich_text: richText(props.vaultPath) };
  if (props.frontmatter !== undefined) out.Frontmatter = { rich_text: richText(props.frontmatter) };
  if (props.archived !== undefined) out.Archived = { checkbox: props.archived };
  if (props.sync !== undefined) out.Sync = { select: { name: props.sync } };
  return out;
}

/**
 * Property-value JSON for a People row. Partial for the same reason
 * `docProperties` is: the projection emits only the fields it is actually
 * setting, so a name-only refresh never re-asserts (and so never re-writes) the
 * email that keys the row.
 */
function personProperties(props: Partial<PersonPageProps>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (props.name !== undefined) out.Name = { title: richText(props.name) };
  // Notion's `email` property value is a bare string, not a rich-text array —
  // and `null` is how it is cleared. A person the source holds no address for is
  // never projected at all (people-sync.ts), so "" only arises from a caller bug;
  // sending null rather than "" keeps Notion's own representation honest.
  if (props.email !== undefined) out.Email = { email: props.email === "" ? null : props.email };
  if (props.source !== undefined) out.Source = { select: { name: props.source } };
  if (props.sourceId !== undefined) out["Source ID"] = { rich_text: richText(props.sourceId) };
  return out;
}

/**
 * A relation property value as Notion returns it inside a page object: the
 * targets it chose to inline, plus `has_more` when it withheld some. Both halves
 * matter — see NotionMeetingRow.peopleTruncated.
 */
function relationIds(value: Record<string, unknown> | undefined): { ids: string[]; truncated: boolean } {
  const raw = value?.relation;
  const ids = Array.isArray(raw)
    ? raw
      .map((entry) => String((entry as { id?: unknown }).id ?? ""))
      .filter((id) => id !== "")
    : [];
  return { ids, truncated: value?.has_more === true };
}

/**
 * Where a meeting row's start time came from (ORB-155). Not decoration: the matcher
 * widens its window and makes the title gate mandatory for `created-time`, and the
 * date write-back only fires when the `Date` property was not already authoritative.
 */
export type StartsAtSource = "date-property" | "title-mention" | "created-time" | "none";

/** A Notion date string that carries a clock time, not just a calendar day. */
function hasTime(value: string | null | undefined): boolean {
  return typeof value === "string" && value.includes("T");
}

/** The rich-text items of a title, or [] for anything that is not one. */
function titleItems(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value as Array<Record<string, unknown>> : [];
}

/** True for the one item type ORB-155 is about: an inline `@date` mention. */
function isDateMention(item: Record<string, unknown>): boolean {
  const mention = item.mention as { type?: unknown } | undefined;
  return item.type === "mention" && mention?.type === "date";
}

/**
 * The first datetime a title's date mentions carry, or null.
 *
 * Notion's REST payload gives the mention a fully-resolved `start`
 * (`2026-08-24T10:00:00.000+02:00`) — the workspace timezone is already folded into
 * the offset, so there is nothing here to assemble or guess. A mention that is
 * itself date-only is NOT a time source: it parses to midnight, which is the exact
 * failure this whole change exists to end.
 */
export function titleMentionStart(titleValue: unknown): string | null {
  for (const item of titleItems(titleValue)) {
    if (!isDateMention(item)) continue;
    const start = (item.mention as { date?: { start?: unknown } }).date?.start;
    if (hasTime(typeof start === "string" ? start : null)) return start as string;
  }
  return null;
}

/** The title with its date mentions dropped — see NotionMeetingRow.matchTitle. */
export function titleWithoutDateMentions(titleValue: unknown): string {
  return titleItems(titleValue)
    .filter((item) => !isDateMention(item))
    .map((item) => (typeof item.plain_text === "string" ? item.plain_text : ""))
    .join("")
    // Removing an item leaves the space that separated it behind.
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Resolves a meeting's start from the three places it can now live, best first.
 *
 *  1. **`Date` with a time.** What the property meant before Notion's change, and
 *     still what a human means when they type a time in. Authoritative.
 *  2. **A date mention in the title.** Where Notion's meeting-notes feature now puts
 *     the real start. Exact to the minute — it is the invite's own time.
 *  3. **`created_time`.** A transcription page is created when the recording starts,
 *     so it is within minutes of the meeting for a note taken live — but it is an
 *     INFERENCE, not a statement, so the matcher treats it differently (a wider
 *     window, and the title gate becomes mandatory) rather than trusting it here.
 *
 * A date-ONLY `Date` is deliberately not a source at any level: it parses to
 * midnight and matches nothing real, which is how a row "fixed" by hand in the
 * Notion UI still filled nothing for two weeks.
 */
export function deriveMeetingStart(
  page: Record<string, unknown>,
): { startsAt: string | null; source: StartsAtSource } {
  const props = (page.properties ?? {}) as Record<string, Record<string, unknown> | undefined>;
  const date = props.Date?.date as { start?: string } | null | undefined;
  if (hasTime(date?.start)) return { startsAt: date!.start!, source: "date-property" };

  const mention = titleMentionStart(props["Meeting Title"]?.title);
  if (mention !== null) return { startsAt: mention, source: "title-mention" };

  const created = page.created_time;
  if (typeof created === "string" && created !== "") {
    return { startsAt: created, source: "created-time" };
  }
  return { startsAt: null, source: "none" };
}

export function toMeetingRow(page: Record<string, unknown>): NotionMeetingRow {
  const props = (page.properties ?? {}) as Record<string, Record<string, unknown> | undefined>;
  const select = props.Project?.select as { name?: string } | null | undefined;
  const date = props.Date?.date as { start?: string } | null | undefined;
  const people = relationIds(props.People);
  const { startsAt, source } = deriveMeetingStart(page);
  return {
    pageId: String(page.id ?? ""),
    lastEditedTime: String(page.last_edited_time ?? ""),
    createdAt: String(page.created_time ?? ""),
    title: plainText(props["Meeting Title"]?.title),
    matchTitle: titleWithoutDateMentions(props["Meeting Title"]?.title),
    project: select?.name ?? null,
    startsAt,
    startsAtSource: source,
    dateHasTime: hasTime(date?.start),
    attendees: plainText(props.Attendees?.rich_text),
    // ORB-27 — the auto-advance trigger and its guard. `Status` may be a status- or
    // select-type property; both are read, and the TYPE rides along so the write uses the
    // shape Notion will actually accept. A Summary read failure yields hasSummary=false,
    // which fails SAFE: the row is skipped, never wrongly advanced.
    hasSummary: plainText(props.Summary?.rich_text).length > 0,
    status:
      ((props.Status?.status as { name?: string } | null | undefined)?.name ??
        (props.Status?.select as { name?: string } | null | undefined)?.name) ?? null,
    statusType: props.Status?.type === "select" ? ("select" as const) : ("status" as const),
    series: plainText(props.Series?.rich_text),
    people: people.ids,
    peopleTruncated: people.truncated,
    peopleUnmatched: plainText(props["People Unmatched"]?.rich_text),
  };
}

export function toPersonRow(page: Record<string, unknown>): NotionPersonRow {
  const props = (page.properties ?? {}) as Record<string, Record<string, unknown> | undefined>;
  const email = props.Email?.email;
  const select = props.Source?.select as { name?: string } | null | undefined;
  return {
    pageId: String(page.id ?? ""),
    name: plainText(props.Name?.title),
    // Lower-cased at the boundary, once. Every comparison downstream — the source
    // index, the attendee index, the change diff — is then on one form, so a row
    // typed `Ada@Example.CO` by hand cannot silently become a second person.
    email: typeof email === "string" ? email.trim().toLowerCase() : "",
    source: select?.name ?? "",
    sourceId: plainText(props["Source ID"]?.rich_text).trim(),
  };
}

export function toDocRow(page: Record<string, unknown>): NotionDocRow {
  const props = (page.properties ?? {}) as Record<string, Record<string, unknown> | undefined>;
  const select = props.Project?.select as { name?: string } | null | undefined;
  return {
    pageId: String(page.id ?? ""),
    lastEditedTime: String(page.last_edited_time ?? ""),
    vaultPath: plainText(props["Vault Path"]?.rich_text),
    title: plainText(props.Name?.title),
    // `?? null` and not `?? ""`: an unset select is a state a proposer must be able
    // to report ("this page has no Project"), and an empty string would read as a
    // Project value nothing maps to — the same fact with a worse sentence.
    project: select?.name ?? null,
    folder: plainText(props.Folder?.rich_text),
  };
}

interface QueryResponse {
  results: Array<Record<string, unknown>>;
  has_more: boolean;
  next_cursor: string | null;
}

interface PageMarkdownResponse {
  markdown?: unknown;
  truncated?: unknown;
}

/**
 * request()'s one thrown shape (fix round 1, Minor 1) — every field a caller
 * might need to classify a failure STRUCTURALLY rather than by regexing the
 * rendered message text (the bug this replaces: `/failed: 404\b/` against
 * `this.message`, which matched only by coincidence and could not
 * distinguish a 400 from a 404 at all). `.code` and `.notionMessage` are
 * Notion's own `error.code`/`error.message` fields, best-effort parsed from
 * the JSON error body — both `undefined` when the body isn't the shape
 * Notion's docs promise (a non-JSON body, a proxy's plain-text error, …),
 * which callers must treat as "unclassifiable", never guess a specific code
 * from. `.message` (inherited) is unchanged from before this type existed, so
 * every existing message-based assertion in this codebase keeps working.
 */
export class NotionRequestError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly notionMessage: string | undefined;

  constructor(method: string, path: string, status: number, bodyText: string) {
    super(`notion ${method} ${path} failed: ${status} ${bodyText}`);
    this.name = "NotionRequestError";
    this.status = status;
    const parsed = parseErrorBody(bodyText);
    this.code = parsed?.code;
    this.notionMessage = parsed?.message;
  }
}

function parseErrorBody(bodyText: string): { code?: string; message?: string } | undefined {
  try {
    const parsed = JSON.parse(bodyText) as { code?: unknown; message?: unknown };
    return {
      code: typeof parsed.code === "string" ? parsed.code : undefined,
      message: typeof parsed.message === "string" ? parsed.message : undefined,
    };
  } catch {
    return undefined;
  }
}

/**
 * Notion's own wording for "you tried to trash a page that is already
 * trashed," at API version 2026-03-11 — verified LIVE 2026-08-05 against the
 * real Docs data source, not assumed (fix round 1, Critical finding; see
 * trashPage's doc comment for the full probe). Tight on purpose: a
 * `validation_error` fires for many unrelated bad-request shapes — including
 * a genuinely malformed `Archived` PROPERTY value on this very database,
 * whose message also contains the word "archived" and MUST NOT be
 * misclassified as this case. Both the code AND this exact phrase have to
 * match; the loose word alone is not enough.
 */
const ALREADY_ARCHIVED_MESSAGE = /\bblock that is archived\b/i;

/**
 * True for either shape a repeat/late trash can report as "nothing left to
 * do" — see trashPage's doc comment for the live probe both branches are
 * pinned against. False (never classifies) for anything this file did not
 * itself throw, so a bug elsewhere can never be silently absorbed here.
 */
function isAlreadyDone(err: unknown): boolean {
  if (!(err instanceof NotionRequestError)) return false;
  // Genuinely gone — purged from trash, or a stale/wrong id. This endpoint
  // has no other reason to 404, so status alone is sufficient (unlike the 400
  // case below, where the code is shared by many unrelated failures).
  if (err.status === 404) return true;
  // Already trashed — by an earlier call within this same run's retry path,
  // or a prior run's successful trash whose orphan write then failed (see
  // runArchiveExcluded's orphanFailed handling). NOT a 200 — see above.
  return err.status === 400 && err.code === "validation_error"
    && err.notionMessage !== undefined && ALREADY_ARCHIVED_MESSAGE.test(err.notionMessage);
}

export function makeNotionClient(opts: NotionClientOptions) {
  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  const base = opts.baseUrl ?? NOTION_API;
  const minInterval = opts.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
  let lastRequestAt = 0;

  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms));

  async function throttle(): Promise<void> {
    const wait = lastRequestAt + minInterval - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
  }

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      await throttle();
      const res = await doFetch(`${base}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${opts.token}`,
          "Notion-Version": opts.version,
          "Content-Type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (res.status === 429) {
        const retryAfter = Number(res.headers.get("Retry-After") ?? "1");
        await sleep(Math.max(0, retryAfter) * 1000);
        continue;
      }
      if (!res.ok) {
        throw new NotionRequestError(method, path, res.status, await res.text());
      }
      return (await res.json()) as T;
    }
    throw new Error(`notion ${method} ${path} failed: rate limited after ${MAX_ATTEMPTS} attempts`);
  }

  async function queryDataSource<T>(
    dataSourceId: string,
    toRow: (page: Record<string, unknown>) => T,
  ): Promise<T[]> {
    const rows: T[] = [];
    let cursor: string | undefined;
    do {
      const res = await request<QueryResponse>(
        "POST",
        `/v1/data_sources/${dataSourceId}/query`,
        { page_size: 100, ...(cursor === undefined ? {} : { start_cursor: cursor }) },
      );
      for (const page of res.results) rows.push(toRow(page));
      cursor = res.has_more && res.next_cursor ? res.next_cursor : undefined;
    } while (cursor !== undefined);
    return rows;
  }

  async function queryMeetings(dataSourceId: string): Promise<NotionMeetingRow[]> {
    return queryDataSource(dataSourceId, toMeetingRow);
  }

  async function queryDocs(dataSourceId: string): Promise<NotionDocRow[]> {
    return queryDataSource(dataSourceId, toDocRow);
  }

  async function queryPeople(dataSourceId: string): Promise<NotionPersonRow[]> {
    return queryDataSource(dataSourceId, toPersonRow);
  }

  /**
   * Creates a People row — properties only, no body. The People database is a
   * projection of records that live somewhere else (spec §8.3), so a page body
   * would be content this service invented, which is precisely what a projection
   * must never hold. `data_source_id` parent for the same reason createDocPage
   * uses it: it is the id `queryPeople` already reads from.
   */
  async function createPersonPage(
    dataSourceId: string,
    props: PersonPageProps,
  ): Promise<{ pageId: string }> {
    const res = await request<{ id?: unknown }>("POST", "/v1/pages", {
      parent: { type: "data_source_id", data_source_id: dataSourceId },
      properties: personProperties(props),
    });
    // Same refusal as createDocPage: a page we cannot identify can never be
    // patched or related, and an empty id would be indistinguishable from "no
    // People row" on the next tick — which is how one create becomes a duplicate
    // every hour, forever.
    if (typeof res.id !== "string" || res.id === "") {
      throw new Error("notion POST /v1/pages returned no page id for a People row");
    }
    return { pageId: res.id };
  }

  /** Property-only update of a People row. Partial — see personProperties. */
  async function updatePersonProps(pageId: string, props: Partial<PersonPageProps>): Promise<void> {
    await request("PATCH", `/v1/pages/${pageId}`, { properties: personProperties(props) });
  }

  /**
   * Writes the two Meetings properties the People pass owns (Phase 4, T7): the
   * `People` relation and the `People Unmatched` flag beside it.
   *
   * ONE PATCH carrying BOTH, never two, because they are two halves of a single
   * statement — "these are the attendees I could verify, and these are the ones I
   * could not". Sent separately, a failure between them leaves a relation whose
   * flag contradicts it, and the row then reads as complete when it is not.
   */
  async function updateMeetingPeople(
    pageId: string,
    value: { people: string[]; unmatched: string },
  ): Promise<void> {
    await request("PATCH", `/v1/pages/${pageId}`, {
      properties: {
        People: { relation: value.people.map((id) => ({ id })) },
        "People Unmatched": { rich_text: richText(value.unmatched) },
      },
    });
  }

  /**
   * Writes what the attendee pass concluded about one meeting row: the `Attendees`
   * string, and — only when `startsAt` is given — the `Date` it was matched on
   * (ORB-155), and — only when `seriesKey` is given — the `Series` id it belongs to
   * (ORB-156).
   *
   * ONE PATCH carrying all three, never split, for the same reason `updateMeetingPeople`
   * sends its pair together: they are facets of one statement, "this note is that
   * meeting, these were the people, and this is the series it repeats in". A failure
   * between separate writes would leave attendees whose date or series contradicts
   * them, and the row could never self-correct — the next tick skips it, because
   * `Attendees` is no longer empty.
   *
   * `startsAt`/`seriesKey` ABSENT means "leave that property alone", which is the
   * common case and the safe one: the caller only supplies `startsAt` for a row whose
   * `Date` held no time of its own, and `seriesKey` only for a row matched to a
   * recurring event. Omitting the key rather than sending null is what makes that a
   * no-op — a `{date: null}` would CLEAR the property, which is the opposite instruction.
   *
   * `Attendees`, `Date` AND `Series` must all already exist on the Meetings database
   * before this ships: because `Series` now rides in the SAME patch, it is a hard
   * precondition of the whole write, not just its own field. If it is missing or
   * renamed, the combined PATCH 400s and `Attendees`/`Date` silently stop being written
   * too — for every recurring meeting, not only the series id. Contrast
   * `updateMeetingPeople`, which is its own call and degrades alone. Add the `Series`
   * property to Notion BEFORE deploying code that calls this with `seriesKey` set.
   */
  async function updateMeetingMatch(
    pageId: string,
    value: { attendees: string; startsAt?: string; seriesKey?: string },
  ): Promise<void> {
    await request("PATCH", `/v1/pages/${pageId}`, {
      properties: {
        Attendees: { rich_text: [{ type: "text", text: { content: value.attendees } }] },
        ...(value.startsAt === undefined ? {} : { Date: { date: { start: value.startsAt } } }),
        ...(value.seriesKey === undefined
          ? {}
          : { Series: { rich_text: [{ type: "text", text: { content: value.seriesKey } }] } }),
      },
    });
  }

  /**
   * ORB-27 — sets the Meetings `Status` when a summary exists. Its own PATCH, degrading
   * alone like `updateMeetingPeople` and unlike the combined match write: a Status failure
   * must never cost a row its attendees. The property TYPE decides the payload shape —
   * a status-type and a select-type property take different bodies, and the wrong one 400s.
   * PRECONDITION: the target option (e.g. "Summarized") must already exist on the property;
   * Notion's API will not create select/status options on write.
   */
  async function updateMeetingStatus(
    pageId: string,
    value: { name: string; type: "status" | "select" },
  ): Promise<void> {
    await request("PATCH", `/v1/pages/${pageId}`, {
      properties: {
        Status:
          value.type === "select" ? { select: { name: value.name } } : { status: { name: value.name } },
      },
    });
  }

  /**
   * Reads a page as Notion-flavored markdown. This is the read half of
   * hash-after-write, the sole defence against the sync conflicting with
   * itself (spec §3) — so a response we cannot hash truthfully must throw,
   * never degrade: a truncated body (Notion truncates past ~20k blocks;
   * no wiki page is within two orders of magnitude of that) or a missing
   * `markdown` field would otherwise store the hash of half a page.
   */
  async function getPageMarkdown(pageId: string): Promise<string> {
    const res = await request<PageMarkdownResponse>("GET", `/v1/pages/${pageId}/markdown`);
    if (res.truncated === true) {
      throw new Error(`notion page ${pageId} returned truncated markdown; refusing to hash a partial read`);
    }
    if (typeof res.markdown !== "string") {
      throw new Error(`notion page ${pageId} returned no markdown string`);
    }
    return res.markdown;
  }

  /**
   * Replaces page content wholesale — the wiki mirror's contract ("Notion wiki
   * rows are overwritten on change", stated in the DB description). The PATCH
   * body is a discriminated union; `replace_content` is the overwrite variant.
   * `allow_deleting_content` stays false: child pages/databases nested under a
   * mirror row by a human are then protected — Notion fails the write instead
   * of deleting them, and the failure surfaces through the per-doc error path.
   * That is the never-delete posture (spec §7) enforced server-side.
   */
  async function patchPageMarkdown(pageId: string, markdown: string): Promise<void> {
    await request("PATCH", `/v1/pages/${pageId}/markdown`, {
      type: "replace_content",
      replace_content: { new_str: markdown, allow_deleting_content: false },
    });
  }

  /**
   * Creates a Docs row with properties and a markdown body in one call.
   * The create-a-page reference allows both `database_id` and `data_source_id`
   * parents for markdown-body creates; we send `data_source_id` because it is
   * the id queryDocs already uses and stays unambiguous if a database ever
   * grows a second source.
   */
  async function createDocPage(
    dataSourceId: string,
    props: DocPageProps,
    markdown: string,
  ): Promise<{ pageId: string }> {
    const res = await request<{ id?: unknown }>("POST", "/v1/pages", {
      parent: { type: "data_source_id", data_source_id: dataSourceId },
      properties: docProperties(props),
      markdown,
    });
    // A page we cannot identify can never be patched, hashed or archived, and
    // an empty id would collide in the store's UNIQUE notion_page_id column —
    // better to error the doc now and retry next tick than to record garbage.
    if (typeof res.id !== "string" || res.id === "") {
      throw new Error("notion POST /v1/pages returned no page id");
    }
    return { pageId: res.id };
  }

  /** Property-only update — Archived flag, Frontmatter refresh. Content untouched. */
  async function updateDocProps(pageId: string, props: Partial<DocPageProps>): Promise<void> {
    await request("PATCH", `/v1/pages/${pageId}`, { properties: docProperties(props) });
  }

  /**
   * Mirror-stamp metadata: `icon` and `is_locked` are top-level PATCH /v1/pages/:id
   * fields, siblings of `properties` rather than entries inside it (unlike Sync,
   * which is a real database property) — spec plan-context §"Mirror stamping",
   * design decision 6.
   *
   * Verified against developers.notion.com/reference/patch-page (fetched
   * 2026-08-04, both the rendered page and its underlying OpenAPI schema, for
   * API version 2026-03-11+):
   *   - `icon`: `anyOf: [pageIconRequest, null]`. The emoji variant
   *     (`emojiPageIconRequest`) is `{ type: "emoji", emoji: <character> }`.
   *     Passing `null` clears the icon.
   *   - `is_locked`: a bare boolean. The docs' own words on API interaction —
   *     load-bearing for T7's live probe — are: "Use the `is_locked` boolean
   *     parameter to lock or unlock the page from being further edited in the
   *     Notion app UI. Note that this setting doesn't affect the ability to
   *     update the page using the API." So a locked mirror row is NOT expected
   *     to reject this service's own writes (only the Notion app UI is fenced);
   *     the plan's unlock→patch→relock contingency should not be needed, but
   *     T7 confirms live against the scratch DB before this is relied on.
   *
   * Throws instead of sending a no-op PATCH when neither field is provided —
   * that shape only arises from a caller bug.
   */
  async function updatePageMeta(
    pageId: string,
    meta: { icon?: string | null; isLocked?: boolean },
  ): Promise<void> {
    const body: Record<string, unknown> = {};
    if (meta.icon !== undefined) {
      body.icon = meta.icon === null ? null : { type: "emoji", emoji: meta.icon };
    }
    if (meta.isLocked !== undefined) body.is_locked = meta.isLocked;
    if (Object.keys(body).length === 0) {
      throw new Error("updatePageMeta called with no fields to update");
    }
    await request("PATCH", `/v1/pages/${pageId}`, body);
  }

  /**
   * Moves a page to Notion's trash — Phase 4 T3's "archive" (plan decision:
   * `in_trash`, never the database's own `Archived` checkbox PROPERTY, which is a
   * DocPageProps field this function does not touch). `in_trash` is a top-level
   * PATCH /v1/pages/:id field, a sibling of `properties` exactly like `icon` and
   * `is_locked` in updatePageMeta — not a database property, so docProperties()
   * plays no part here. Body shape is the T3 brief's exact spec, not re-derived
   * from memory (see this file's header note).
   *
   * Trash beats the checkbox for T3's purpose: a ticked Archived leaves the row
   * live and returned by every future queryDocs, permanently in reach of the
   * adoption path. Trash removes it from the database outright, while staying
   * recoverable from Notion's own UI for 30 days.
   *
   * `alreadyDone: true` covers BOTH shapes this PATCH uses to say "there was
   * nothing left to trash" — live-probed 2026-08-05 against the real Docs data
   * source at the pinned version, corrected here after the probe caught the
   * ORIGINAL version of this function assuming the second one wrongly (fix
   * round 1, Critical finding — do not re-introduce without re-probing):
   *
   *   1. Genuinely gone — purged from trash, or a stale/wrong id — 404s with
   *      `code: "object_not_found"`.
   *   2. Already trashed, by an earlier call — 400s with `code:
   *      "validation_error"`, message "Can't edit block that is archived. You
   *      must unarchive the block before editing." This is NOT a 200: PATCHing
   *      `in_trash: true` on a page that already has it does not succeed
   *      idempotently, whatever its symmetry with `updatePageMeta` might
   *      suggest. See isAlreadyDone/ALREADY_ARCHIVED_MESSAGE above for why the
   *      match is narrow — `validation_error` alone is not enough, because a
   *      genuinely malformed `Archived` PROPERTY value 400s with the same code
   *      and must still be thrown.
   *
   * Every OTHER failure (rate limits exhausted, auth, a 5xx, an unrelated
   * validation_error) still throws, same as every other write in this file.
   */
  async function trashPage(pageId: string): Promise<{ alreadyDone: boolean }> {
    try {
      await request("PATCH", `/v1/pages/${pageId}`, { in_trash: true });
      return { alreadyDone: false };
    } catch (err) {
      if (isAlreadyDone(err)) return { alreadyDone: true };
      throw err;
    }
  }

  return {
    queryMeetings, updateMeetingMatch,
    updateMeetingStatus,
    queryDocs, getPageMarkdown, patchPageMarkdown, createDocPage, updateDocProps, updatePageMeta,
    trashPage,
    queryPeople, createPersonPage, updatePersonProps, updateMeetingPeople,
  };
}
