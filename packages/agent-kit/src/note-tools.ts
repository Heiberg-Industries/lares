import { defineTool } from "eve/tools";
import { z } from "zod";

import { getPool } from "./db.js";
import { resolveUser, type ResolvedUser } from "./identity.js";
import {
  findBacklinks,
  listNotes,
  readNote,
  searchNotes,
  storeForArea,
  storeRootForArea,
  type Reader,
  type StoreName,
} from "./notes-store.js";
import type { VaultArea } from "./skill-grants.js";

/**
 * Tool factories for the Vault's note areas.
 *
 * ONE SET OF TOOLS, TOLD WHICH AREA TO READ (ADR-0017 rule 1, W5C-s3). There used to be two
 * sets — four tools bound to the personal store at construction and three more bound to the
 * shared one — which is how the two drifted: a fix landed on one and not the other, and the
 * difference was invisible until someone asked the shared store a question only the personal
 * one answered correctly. Now the area is an INPUT, checked against what the session was
 * granted, and there is one implementation to fix.
 *
 * Each `agent/tools/<name>.ts` is a one-line default export of one of these, because eve
 * derives a tool's runtime name from its filename.
 *
 * All three read via `node:fs` directly, NOT through eve's sandbox. That is not a style
 * preference: eve's own `read_file`/`glob`/`grep` proxy into a `just-bash` sandbox that
 * wants a writable `<appRoot>/.eve/sandbox-cache`, and this container's rootfs is
 * read-only — so those tools fail with ENOENT here (see the runbook). These hands work.
 *
 * ORB-143 Task 2: relocated here from `services/chief-of-staff/lib/note-tools.ts` as a PLAIN
 * shared module — not extension-scoped. No factory function touches extension config: each
 * resolves `storeRootForArea(area)`, which reads `VAULT_PATH`/`ATLAS_PATH` from `process.env`
 * directly (Owner decision C4 — the settings keep their names; only what an agent is GRANTED
 * changes), so this module works identically whether the tool it builds ends up mounted in an
 * extension or not.
 */

/** The areas a NOTE tool can open: the two that are backed by a markdown store. `taste` has no
 *  mount (Owner decision C2) and `facts` names database tables, so neither is offered to the
 *  model here — `storeForArea` returns `undefined` for both and the guard below refuses them
 *  even when something bypasses this schema. */
export const NOTE_AREAS = ["private", "shared"] as const satisfies readonly VaultArea[];

/** Descriptions keyed by Vault area rather than by the legacy store name (ADR-0017 rule 1).
 *  `taste` and `facts` are not file stores but still get an honest sentence, for anything that
 *  lists all four areas rather than only the two a note tool can actually open. */
export const DESCRIBE_AREA: Record<VaultArea, string> = {
  private: "the personal knowledge vault — notes, meeting records, thinking",
  shared: "the shared knowledge vault — ventures, positioning, commercial context",
  taste: "the taste store — life-context notes: places, tracks, dishes, playlists",
  facts: "the standing-facts tables — dated facts and preferences, not markdown notes",
};

// ── Reader resolution (multi-user substrate, spec Part 2, Task 6) ──────────────────────

/** The speaking human this turn, in the identity registry's own vocabulary — see
 *  `speakerFromAuth` below for where this comes from. */
export interface TurnSpeaker {
  system: string;
  alias: string;
}

/**
 * eve's per-channel `authenticator` string → the `system` column `user_aliases` uses
 * (`sql/014_identity.sql`: 'slack' | 'telegram' | 'email' | 'google' | 'legacy'). eve
 * documents no public contract for these strings; verified against the bundled dist
 * (`eve/dist/src/public/channels/{slack,telegram}/*.js`) exactly as
 * `services/chief-of-staff/lib/principals.ts`'s `AUTHENTICATOR_FOR` already documents — that
 * table is duplicated here, narrowly, because agent-kit is upstream of eve-saga and
 * cannot import its consumer's code. An authenticator with no entry (a channel this
 * store has never seen a human on) is passed through as-is: `resolveUser` then finds no
 * matching alias and the stranger path below refuses it — never a silent unfiltered read.
 */
const SYSTEM_FOR_AUTHENTICATOR: Readonly<Record<string, string>> = {
  "slack-webhook": "slack",
  "telegram-webhook": "telegram",
};

/**
 * Decodes `ctx.session?.auth?.current` into the `{system, alias}` pair the identity
 * registry resolves — mirroring the access pattern and caveats documented at
 * `services/chief-of-staff/agent/tools/remember.ts:20-80`: `current` is null/undefined on a
 * turn with no human in it (a schedule turn — the 08:00/20:00 briefs run as the app
 * principal), and only THAT case means "no speaker". Any other value is a real caller and
 * is always handed to `readerForTurn` for resolution, even if the shape here can't be
 * fully decoded — an unresolvable `alias` still fails closed as a stranger, never as
 * "no one is asking".
 */
export function speakerFromAuth(auth: { current?: unknown } | null | undefined): TurnSpeaker | undefined {
  const current = auth?.current;
  if (current === null || current === undefined) return undefined;
  const c = current as { authenticator?: unknown; principalType?: unknown; attributes?: Record<string, unknown> };
  const authenticator = typeof c.authenticator === "string" ? c.authenticator : "unknown";
  const raw = c.attributes?.["user_id"];
  // eve's own app principal — what a schedule's `to(...).send(prompt, { auth: appAuth })` lands
  // in `auth.current` (authenticator "app", principalType "runtime", no user attribute) — is the
  // AGENT acting, not a person asking. Decoding it as a speaker made every scheduled Atlas/vault
  // read fail as "unknown is not a member of this installation" (2026-09-07, crm-routing). With
  // no member named it is "no speaker", so `readerForTurn`'s rule (a) applies and the agent reads
  // as its configured owner. A per-member schedule that DOES name a member in `attributes.user_id`
  // keeps resolving that member — the multi-user shape, unchanged.
  const isApp = authenticator === "app" || c.principalType === "runtime";
  if (isApp && raw === undefined) return undefined;
  const system = SYSTEM_FOR_AUTHENTICATOR[authenticator] ?? authenticator;
  const alias = typeof raw === "string" ? raw : typeof raw === "number" ? String(raw) : "unknown";
  return { system, alias };
}

/**
 * ALL the branching for "who is this store being read for?" lives here, so the tool
 * factories below stay thin single calls into it. Resolution rules (spec Part 2 Task 6):
 *
 * (a) no speaker (a schedule turn) → the agent reads as its OWN configured user, via
 *     `AGENT_OWNER_USER_ID` (set per agent in compose); unset → the legacy unfiltered
 *     path, today's behaviour, preserved for any agent not yet given an owner.
 * (b) a speaker → resolve them against the identity registry.
 * (c) unresolved (a stranger) → throw, naming the refusal — NEVER the unfiltered path.
 * (d) a resolve failure (`IdentityUnavailableError` or any other registry error) →
 *     propagates unchanged. An outage must read as an error, not as an empty result
 *     (the ORB-51 posture) and never as permission to skip filtering.
 */
export async function readerForTurn(
  speaker: TurnSpeaker | undefined,
  store: StoreName,
  env: NodeJS.ProcessEnv,
  resolve: (system: string, alias: string) => Promise<ResolvedUser | undefined>,
): Promise<Reader | undefined> {
  if (speaker === undefined) {
    const ownerId = env["AGENT_OWNER_USER_ID"]?.trim();
    if (ownerId === undefined || ownerId.length === 0) return undefined;
    return { userId: ownerId, store };
  }
  const resolved = await resolve(speaker.system, speaker.alias);
  if (resolved === undefined) {
    throw new Error(`${speaker.alias} is not a member of this installation`);
  }
  return { userId: resolved.id, store };
}

/** The reader for THIS tool call: decode the turn's speaker off `ctx`, then resolve it.
 *  Every factory below calls this and passes the result straight to its store function —
 *  a thrown stranger/outage error is NOT caught here, matching how `storeRoot` already
 *  lets `StorePathNotConfiguredError` propagate out of these tools uncaught; eve renders
 *  a thrown tool error as this tool's failure, which is the existing "store unavailable"
 *  answer shape these tools have always had. Reusing that path — not inventing a second,
 *  returned-object refusal shape — is deliberate. */
async function readerFor(store: StoreName, ctx: { session?: { auth?: { current?: unknown } | null } }): Promise<Reader | undefined> {
  const speaker = speakerFromAuth(ctx.session?.auth);
  return readerForTurn(speaker, store, process.env, (system, alias) => resolveUser(getPool(), system, alias));
}

// ── The area guard (W5C-s3) ───────────────────────────────────────────────────────────────

/**
 * Which Vault areas THIS session may open, injected by whichever catalogue file builds the
 * tool — the same seam, and for the same reason, as `onRead` below: agent-kit is shared by
 * every role service and cannot import one service's per-session definition read. A service
 * passes `(ctx) => grantedVaultAreas(definition-for-this-session)`; `manifest.ts` owns that
 * derivation so the session's tool LIST and the tool's own refusal can never disagree.
 */
export type VaultAreaAuthority = (
  ctx: { session?: { id?: string } | undefined },
) => readonly VaultArea[] | Promise<readonly VaultArea[]>;

export interface NoteToolDeps {
  /** Omitted = NO area is open. Fail closed, deliberately: a tool built without an authority
   *  refuses every area rather than defaulting to the personal store on a caller's behalf. */
  areas?: VaultAreaAuthority;
}

/** The area's file store, once the grant has been checked. Throws — a rejected promise the
 *  model reads as this tool's failure, the same shape `storeRoot` has always thrown — naming
 *  the area in both refusals, so the answer says which door was tried and closed. */
async function storeForGrantedArea(
  area: VaultArea,
  deps: NoteToolDeps | undefined,
  ctx: { session?: { id?: string } | undefined },
): Promise<StoreName> {
  const open = deps?.areas === undefined ? [] : await deps.areas(ctx);
  if (!open.includes(area)) {
    throw new Error(`the "${area}" area of the Vault was not granted to this agent`);
  }
  const store = storeForArea(area);
  if (store === undefined) throw new Error(`the "${area}" area of the Vault holds no notes to read`);
  return store;
}

/** The area sentence every one of the four descriptions ends with, so the model is told the
 *  same thing about areas whichever tool it reaches for first. */
const AREA_INPUT_DOC =
  `Say which area: "private" is ${DESCRIBE_AREA.private}; "shared" is ${DESCRIBE_AREA.shared}. ` +
  `They are separate stores and a path in one is not a path in the other. An area this agent ` +
  `was not granted is refused.`;

const areaInput = z.enum(NOTE_AREAS);

export function searchTool(deps?: NoteToolDeps) {
  return defineTool({
    description:
      `Search one area of the Vault for notes matching a query. Send natural words, not a ` +
      `regex. Returns store-relative paths plus that area's total note count — a result ` +
      `with zero hits and a non-zero count means the query found nothing, not that the ` +
      `area is unavailable. ${AREA_INPUT_DOC}`,
    inputSchema: z.object({ area: areaInput, q: z.string() }),
    // async so a typed refusal arrives as a rejected promise, matching the guarded file
    // tools — eve awaits tool executors and a sync throw escapes that await in some paths.
    async execute({ area, q }, ctx) {
      const store = await storeForGrantedArea(area, deps, ctx);
      return searchNotes(q, storeRootForArea(area), await readerFor(store, ctx));
    },
  });
}

/** The turn a read happened in, decoded off a tool's `ctx` the same defensive way
 *  `origin-taint.ts`'s `turnKeyFrom` does — a half-decoded id is `undefined`, never a guess. */
function sessionTurnFrom(ctx: unknown): { sessionId: string | undefined; turnId: string | undefined } {
  const session = (ctx as { session?: { id?: unknown; turn?: { id?: unknown } } } | undefined)?.session;
  const sessionId = typeof session?.id === "string" ? session.id : undefined;
  const turnId = typeof session?.turn?.id === "string" ? session.turn.id : undefined;
  return { sessionId, turnId };
}

export interface ReadToolDeps extends NoteToolDeps {
  /**
   * Fired after a read SUCCEEDS — a read that threw opened nothing, so this never runs for one.
   * `sessionId`/`turnId` are `undefined` when `ctx` cannot name them; the caller decides what
   * that means (W5A-s3's callers record nothing rather than guess).
   *
   * Deliberately NOT a call into `services/chief-of-staff/lib/memory-reads.ts` from here:
   * agent-kit is shared by every role service and must not depend on one service's lib. Each
   * catalogue file that wants a read recorded injects its own callback (see `atlas_read.ts`,
   * `agent-kit__vault_read.ts`).
   */
  onRead?: (store: StoreName, path: string, sessionId: string | undefined, turnId: string | undefined) => void;
}

export function readTool(deps?: ReadToolDeps) {
  return defineTool({
    description:
      `Read one note from one area of the Vault by its store-relative path, exactly as ` +
      `returned by the search tool (for example "ventures/soma.md"). Absolute ` +
      `paths are refused — this tool reaches nothing outside the area it is given. ` +
      AREA_INPUT_DOC,
    inputSchema: z.object({ area: areaInput, path: z.string() }),
    async execute({ area, path }, ctx) {
      const store = await storeForGrantedArea(area, deps, ctx);
      const note = readNote(path, storeRootForArea(area), await readerFor(store, ctx));
      if (deps?.onRead) {
        const { sessionId, turnId } = sessionTurnFrom(ctx);
        deps.onRead(store, path, sessionId, turnId);
      }
      return note;
    },
  });
}

export function listTool(deps?: NoteToolDeps) {
  return defineTool({
    description:
      `List every note in one area of the Vault by its store-relative path (for example ` +
      `"ventures/soma.md") — a directory listing, not a search. Use this to see what's ` +
      `there before searching or reading. An empty area is a misconfiguration (unmounted ` +
      `volume, wrong path, empty clone), never a valid "nothing here" answer, and throws ` +
      `instead of returning an empty list. ${AREA_INPUT_DOC}`,
    inputSchema: z.object({ area: areaInput }),
    // STAYS ON THE LEGACY, UNFILTERED PATH (multi-user substrate Task 6, deliberate cut).
    // `searchNotes`/`readNote`/`findBacklinks` filter by scope for free because they
    // already open every candidate file's content for scoring/reading; a plain listing
    // does not — filtering it would mean reading every note's frontmatter just to build a
    // directory index, the same cost as a full-store search on every call. A leaked TITLE
    // is a smaller wound than a leaked BODY, so this is an honest, recorded cut rather
    // than a silent one. The second-user runbook (Task 10/11) re-checks this call
    // specifically before a second real member is ever seated.
    async execute({ area }, ctx) {
      await storeForGrantedArea(area, deps, ctx);
      const notes = listNotes(storeRootForArea(area));
      return { notes, files: notes.length };
    },
  });
}

export function backlinksTool(deps?: NoteToolDeps) {
  return defineTool({
    description:
      `List the notes in one area of the Vault that link to a given note, by its ` +
      `store-relative path. Links are Obsidian wikilinks ([[note-name]]), so this answers ` +
      `"what else refers to this?" — useful for finding the context around a note. ` +
      AREA_INPUT_DOC,
    inputSchema: z.object({ area: areaInput, path: z.string() }),
    async execute({ area, path }, ctx) {
      const store = await storeForGrantedArea(area, deps, ctx);
      return findBacklinks(path, storeRootForArea(area), await readerFor(store, ctx));
    },
  });
}
