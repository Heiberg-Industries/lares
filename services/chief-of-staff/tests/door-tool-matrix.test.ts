// WHICH TOOLS EACH DOOR SHOWS, AND WHICH IT LETS THROUGH.
//
// People reach this agent through doors: Slack, Telegram and the console's private web chat.
// What a conversation is offered depends on the door, on who is speaking and on who else can
// read the answer. This file writes that down as one table and holds the code to it, so a tool
// that works on one door and quietly does not on another fails here, not on a test server.
//
// TWO QUESTIONS, ASKED SEPARATELY, for every tool on every door:
//   - VISIBILITY: is the tool in the list the model is handed when the conversation starts?
//   - INVOCATION: when the tool is called, does the call run, does it raise an approval card
//     first, or is it refused?
//
// WHAT IS REAL HERE AND WHAT IS A STAND-IN.
//   Real: each door's own admission code (`agent/channels/*.ts`), the tool resolver
//   (`agent/tools/catalogue.ts`), the private-surface rules, the approval policies and the
//   execution guard (`lib/approvals.ts`). Each conversation below starts from a fake door message
//   handed to that door's own code; the session it returns is what the tools are asked with.
//   Stand-ins: there is no database, no network and no chat platform. The few database answers
//   these paths need are fixed in `fake` below (who owns the agent, that both chat doors are
//   connected, the approval card table, and "the console vouches for this member"). The checks
//   behind those answers have their own database tests (`console-turn-authority.test.ts` and
//   `exact-approval-execution.test.ts`). A database read this file did not expect fails the test.
//
// A call "runs" here means it passed the door's guard and its approval policy. No tool body is
// executed: that would reach a mail, calendar or note provider.
//
// THE TABLE IS TODAY'S BEHAVIOUR, read from the code. Where today's behaviour looks wrong, the
// table still records it (so this file is green) and an `it.fails` test further down states what
// should hold instead. Each of those is marked "Found".
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const INCARNATION = "11111111-1111-4111-8111-111111111111";
const NONCE = "a".repeat(43);
const ROUTE_PASSWORD = "route-password-for-this-test";
const SLACK_OWNER = "U0OWNER";
const SLACK_STRANGER = "U0STRANGER";
const TELEGRAM_OWNER = "1001";
const TELEGRAM_STRANGER = "2002";
const WEB_OWNER = "member-owner";
const WEB_MEMBER = "member-other";
const WEB_STRANGER = "member-unknown";

const fake = vi.hoisted(() => {
  const asks = new Map<string, Record<string, unknown>>();
  const unexpected: string[] = [];
  const claims = [
    { kind: "slack", principal: "U0OWNER", revision: "rev-slack", applied_revision: "rev-slack" },
    { kind: "telegram", principal: "1001", revision: "rev-telegram", applied_revision: "rev-telegram" },
  ];
  return {
    definition: undefined as unknown,
    /** The member the installation's database names as this agent's owner. */
    owner: "member-owner",
    /** Members the console vouches for (signed in, with use of this agent). */
    vouched: new Set(["member-owner", "member-other"]),
    asks,
    unexpected,
    /** The database, reduced to the five answers these paths ask it for. */
    pool: {
      async query(sql: string, values: unknown[] = []): Promise<{ rows: unknown[] }> {
        // "Is this still the ready, applied runtime?" (`assertManagedRuntimeCurrent`)
        if (/^SELECT 1 FROM agent_resources r JOIN agent_definitions a/.test(sql)) return { rows: [{}] };
        // "Which chat doors has the owner connected?" Both, and both are applied.
        if (/^SELECT kind,principal,revision,applied_revision FROM agent_door_connections/.test(sql)) return { rows: claims };
        // "Is this door enabled and claimed?" (`currentDoor`, asked by the door before admission)
        if (/^SELECT c\.\*,d\.enabled,r\.pending/.test(sql)) {
          const claim = claims.find((c) => c.kind === values[2]);
          return { rows: claim ? [{ ...claim, enabled: true, applied_enabled: true, pending: false, claimed_at: "2026-01-01" }] : [] };
        }
        // The approval card table: one row per reserved card, never rewritten.
        if (/^INSERT INTO approval_asks/.test(sql)) {
          const [callId, agent, tool, payloadHash, authority, member, sessionId] = values as string[];
          if (!asks.has(callId!)) {
            asks.set(callId!, { request_id: null, call_id: callId, agent, tool, payload_hash: payloadHash, used_at: null,
              session_id: sessionId, original_authority: JSON.parse(authority!), acting_member_id: member,
              resolved_by_member_id: null, outcome: null });
          }
          return { rows: [] };
        }
        if (/^SELECT \* FROM approval_asks WHERE call_id=\$1/.test(sql)) {
          const row = asks.get(values[0] as string);
          return { rows: row ? [row] : [] };
        }
        unexpected.push(sql.replace(/\s+/g, " ").slice(0, 120));
        throw new Error("door-tool-matrix: a database read this test did not expect");
      },
    },
  };
});

// No matrix turn asks a card, and outside eve there is no session state to read (which the real
// module treats as "a card was asked"). The durable mark itself: tests/approval-card-turns.test.ts.
vi.mock("../lib/approval-card-turns.js", async (original) => ({
  ...(await original<typeof import("../lib/approval-card-turns.js")>()),
  turnAskedACard: (session: { turn?: { id?: unknown } | null } | null | undefined) => typeof session?.turn?.id !== "string" || !session.turn.id,
}));
vi.mock("@lares/agent-kit/db", async (original) => ({
  ...(await original<typeof import("@lares/agent-kit/db")>()),
  getPool: () => fake.pool,
}));
vi.mock("@lares/agent-kit/console-turn-authority", async (original) => {
  const real = await original<typeof import("@lares/agent-kit/console-turn-authority")>();
  const { turnAuthoritySchema } = await import("@lares/agent-kit/authority-contract");
  return {
    ...real,
    // The database confirms the session's binding. Covered with a database in agent-kit.
    requireConsoleSessionBinding: async () => ({}),
    guardConsoleToolContext: async () => undefined,
    // What the real function returns once that binding is confirmed, for a human turn only.
    requireConsoleTurnAuthority: async (ctx: { session?: { id?: string; turn?: { id?: string }; auth?: { current?: unknown } | null } }) => {
      const admission = real.consoleAdmission(ctx.session?.auth?.current);
      if (!admission || admission.purpose !== "human" || !ctx.session?.id) throw new Error(real.CONSOLE_AUTHORITY_REFUSED);
      const placeId = `console:helper:11111111-1111-4111-8111-111111111111:${ctx.session.id}`;
      return turnAuthoritySchema.parse({ origin: "human", agentId: "helper", sessionId: ctx.session.id, turnId: ctx.session.turn?.id,
        actingMemberId: admission.memberId, spokenByMemberId: admission.memberId, placeId,
        audience: { placeId, revision: 1, participants: [{ kind: "member", memberId: admission.memberId }] },
        policyRevision: real.CONSOLE_AUTHORITY_REVISION });
    },
    // The console's vouching for a member, which the real function reads from the database.
    // No member named: no claim at all. A member the installation does not know: refused.
    consoleRouteAdmission: async (request: Request) => {
      const member = request.headers.get(real.CONSOLE_MEMBER_ID_HEADER);
      const nonce = request.headers.get(real.CONSOLE_ADMISSION_HEADER);
      const purpose = request.headers.get(real.CONSOLE_PURPOSE_HEADER);
      if (!member && !nonce && !purpose) return undefined;
      if (!member || !nonce || !purpose || !fake.vouched.has(member)) throw new Error(real.CONSOLE_AUTHORITY_REFUSED);
      return { lares_member_id: member, lares_admission_nonce: nonce, lares_purpose: purpose };
    },
  };
});
vi.mock("../lib/definition.js", async (original) => ({
  ...(await original<typeof import("../lib/definition.js")>()),
  thisAgent: async () => ({ loaded: { definition: fake.definition } }),
}));
vi.mock("../lib/agent-mailbox.js", async (original) => ({
  ...(await original<typeof import("../lib/agent-mailbox.js")>()),
  loadOwner: async () => fake.owner,
}));
// Archived-conversation context for a direct message is read from the database. It never
// changes who is admitted or what they are offered, so it is switched off here.
vi.mock("../lib/conversation-continuity.js", async (original) => ({
  ...(await original<typeof import("../lib/conversation-continuity.js")>()),
  nativeConversationContinuity: async () => ({ context: [] }),
}));

import { defaultTelegramAuth } from "eve/channels/telegram";
import { setBoardDeps } from "@lares/agent-kit/board-approval";
import { CONSOLE_AUTHORITY_REFUSED } from "@lares/agent-kit/console-turn-authority";
import { SHARED_ROOM_REFUSED, SHARED_ROOM_UNAVAILABLE, sharedRoomHiddenTool } from "@lares/agent-kit/private-console-surface";
import { parseDefinition } from "@lares/agent-kit/definition";
import { interceptSlackClaim, interceptTelegramClaim } from "@lares/agent-kit/door-channels";

import { basicFromSecretFile } from "../agent/channels/eve.js";
import { admitSlackDirectMessage, admitSlackMessage } from "../agent/channels/slack.js";
import { hasDispatchableContent, isAllowedTelegramMessage } from "../agent/channels/telegram.js";
import catalogueResolver from "../agent/tools/catalogue.js";
import commercialResolver from "../agent/tools/commercial_who_to_contact.js";
import publicDocResolver from "../agent/tools/public_doc.js";
import laresDocsSkill from "../agent/skills/lares-docs.js";
import salesOutreachSkill from "../agent/skills/sales-outreach.js";
import signalsSkill from "../agent/skills/signals.js";
import { CATALOGUE } from "../catalogue/index.js";
import { runDynamic, type MemoStore } from "../../../packages/agent-kit/tests/helpers/eve-dynamic.js";
import { approverFrom, assertApprover, catalogueApprovalResponse, humanTurnRefusal } from "../lib/approvals.js";
import { calendarApprovalAdapter } from "../lib/calendar-approval.js";
import { tracksApprovalAdapter } from "../lib/tracks-approval.js";
import { vaultNoteApprovalAdapter } from "../lib/vault-note-write.js";

// ─── The table ────────────────────────────────────────────────────────────────────────────────
//
// One row per tool, one column per door. Each cell answers both questions:
const R = "runs"; //             shown; a call goes straight through
const C = "card"; //             shown; a call raises an approval card first
const X = "shown, refused"; //   shown, but every call is refused
const H = "hidden"; //           not shown; a call is refused
type Cell = typeof R | typeof C | typeof X | typeof H;

const DOOR_KEYS = ["slackDm", "slackRoom", "telegram", "webOwner", "webMember"] as const;
type DoorKey = (typeof DOOR_KEYS)[number];
type Row = readonly [tool: string, slackDm: Cell, slackRoom: Cell, telegram: Cell, webOwner: Cell, webMember: Cell];

// The agent is the neutral default this service ships (`agent.json`), which is also what the
// baseline snapshot was captured against. On Slack and Telegram, tools that ask first follow that
// definition ("gated"); no permissions-board row overrides it here. `read_url` runs because the
// turn has not yet read anyone else's words; after it has, it asks first on those doors.
// The Slack room column hides what the private console treats as one person's own, plus note
// search and backlinks (`sharedRoomHiddenTool` in agent-kit): the room reads along with the answer.
//
//                                        Slack    Slack    Tele-    Web      Web
//                                        owner    owner    gram     owner    member
//                                        DM       room     owner
const TABLE: readonly Row[] = [
  // Mail
  ["gmail_read",                          R,       H,       R,       R,       R],
  ["gmail_search",                        R,       H,       R,       R,       R],
  ["gmail_signature",                     R,       R,       R,       H,       H],
  ["gmail_send",                          C,       C,       C,       H,       H],
  // Found: web chat shows the owner these two and refuses every call (see the `it.fails` below).
  ["gmail_draft",                         R,       H,       R,       X,       H],
  ["gmail_draft_recipients",              R,       H,       R,       X,       H],
  // Calendar
  ["calendar_list_events",                R,       H,       R,       R,       H],
  ["calendar_list_calendars",             R,       H,       R,       R,       H],
  ["calendar_free_busy",                  R,       H,       R,       R,       H],
  ["calendar_conflicts",                  R,       H,       R,       R,       H],
  ["calendar_create_event",               C,       H,       C,       C,       H],
  ["calendar_update_event",               C,       H,       C,       C,       H],
  ["calendar_delete_event",               C,       H,       C,       C,       H],
  // Notes (the Vault). Found: Slack and Telegram search notes but cannot read or list them.
  ["agent-kit__vault_read",               H,       H,       H,       R,       R],
  ["agent-kit__vault_list",               H,       H,       H,       R,       R],
  ["agent-kit__vault_search",             R,       H,       R,       H,       H],
  ["agent-kit__vault_backlinks",          R,       H,       R,       H,       H],
  ["agent-kit__vault_write",              C,       H,       C,       C,       C],
  ["agent-kit__vault_file",               C,       C,       C,       H,       H],
  ["agent-kit__vault_drop",               C,       C,       C,       H,       H],
  ["save_note",                           R,       R,       R,       H,       H],
  ["atlas_proposals",                     R,       R,       R,       H,       H],
  ["atlas_resolve_proposal",              C,       C,       C,       H,       H],
  // Links. Found: same as the drafts, shown to the owner in web chat and always refused.
  ["read_url",                            R,       H,       R,       X,       H],
  // What the agent remembers
  ["remember",                            R,       R,       R,       H,       H],
  ["forget",                              C,       C,       C,       H,       H],
  ["facts_list",                          R,       R,       R,       H,       H],
  ["memory_used",                         R,       R,       R,       H,       H],
  ["memory_proposals",                    R,       R,       R,       H,       H],
  ["memory_resolve_proposal",             C,       C,       C,       H,       H],
  // Deadlines, reminders, obligations
  ["deadline_list",                       R,       R,       R,       H,       H],
  ["deadline_add",                        R,       R,       R,       H,       H],
  ["deadline_reset",                      R,       R,       R,       H,       H],
  ["deadline_done",                       C,       C,       C,       H,       H],
  ["deadline_dismiss",                    C,       C,       C,       H,       H],
  ["deadline_mint_statutory",             C,       C,       C,       H,       H],
  ["remind_list",                         R,       R,       R,       H,       H],
  ["remind_set",                          C,       C,       C,       H,       H],
  ["remind_cancel",                       C,       C,       C,       H,       H],
  ["obligation_dismiss",                  R,       R,       R,       H,       H],
  // People and the CRM
  ["person_lookup",                       R,       H,       R,       H,       H],
  ["identity_my_addresses",               R,       R,       R,       H,       H],
  ["twenty_lookup",                       R,       R,       R,       H,       H],
  ["twenty_get_person",                   R,       R,       R,       H,       H],
  ["twenty_company_for_person",           R,       R,       R,       H,       H],
  ["twenty_comm_state",                   C,       C,       C,       H,       H],
  ["twenty_create_opportunity",           C,       C,       C,       H,       H],
  ["twenty_do_not_contact",               C,       C,       C,       H,       H],
  ["twenty_note",                         C,       C,       C,       H,       H],
  ["twenty_set_stage",                    C,       C,       C,       H,       H],
  ["outreach_track",                      R,       R,       R,       H,       H],
  // Meetings
  ["meeting_followup_auto",               C,       C,       C,       H,       H],
  ["meeting_followup_redraft",            C,       C,       C,       H,       H],
  ["meeting_followup_send",               C,       C,       C,       H,       H],
  ["meeting_followup_record_denial",      R,       R,       R,       H,       H],
  // Notion proposals
  ["notion_proposals",                    R,       R,       R,       H,       H],
  ["notion_resolve_proposal",             C,       C,       C,       H,       H],
  // The rest
  ["agent-kit__signals_recent",           R,       R,       R,       H,       H],
  ["digest_run",                          R,       R,       R,       H,       H],
  ["echo_note",                           C,       C,       C,       H,       H],
  ["set_language",                        R,       R,       R,       H,       H],
  ["voice_guide",                         R,       R,       R,       H,       H],
  // Shown on a door but missing from the baseline snapshot (see NOT_IN_BASELINE).
  ["gmail_accounts",                      R,       H,       R,       R,       R],
  ["tracks_list",                         H,       H,       H,       R,       R],
  ["track_items",                         H,       H,       H,       R,       R],
  ["track_add_item",                      H,       H,       H,       C,       C],
  ["track_move_item",                     H,       H,       H,       C,       C],
  ["track_create",                        H,       H,       H,       C,       C],
  ["track_set_steps",                     H,       H,       H,       C,       C],
];

// Tools that are not in the catalogue: each has its own resolver file under `agent/tools/`, so
// each is asked through that file. Only visibility fits a table; what a call does is asserted in
// "tools with their own resolver" below.
const S = "shown";
type OwnCell = typeof S | typeof H;
type OwnRow = readonly [tool: string, slackDm: OwnCell, slackRoom: OwnCell, telegram: OwnCell, webOwner: OwnCell, webMember: OwnCell];
const OWN_RESOLVER: readonly OwnRow[] = [
  ["commercial_who_to_contact",           S,       S,       S,       H,       H],
  ["lares_read_public_doc",               S,       S,       S,       S,       S],
  // The skills replace main's `load_skill` rows. On eve 1.0 a skill the conversation may not have is simply absent
  // (there is no authored loader to refuse it), so what a door can load is what its skill files return.
  ["skill lares-docs",                    S,       S,       S,       S,       S],
  ["skill sales-outreach",                S,       S,       S,       H,       H],
  ["skill signals",                       S,       S,       S,       H,       H],
];

/** Baseline tools no door decides. Every other baseline tool must have a row above. */
const NOT_DOOR_DEPENDENT: Readonly<Record<string, string>> = {
  ask_question: "eve's own tool for asking the person a question; no code in this repository adds, removes or guards it per door",
  todo: "eve's own task list for the model; no code in this repository adds, removes or guards it per door",
  load_skill: "gone on eve 1.0: skills are loaded with eve's own eve__skill; the per-door rows `skill lares-docs`, `skill sales-outreach` and `skill signals` below replace it",
};

/** Rows for tools the baseline snapshot does not list, each with why. The snapshot is evidence
 *  of an earlier capture and is not regenerated here; this list makes the gap explicit. */
const NOT_IN_BASELINE: Readonly<Record<string, string>> = {
  "skill lares-docs": "an instruction skill, not a tool: the tool snapshot never lists skills (main's matrix reached it through load_skill)",
  "skill sales-outreach": "an instruction skill, not a tool: the tool snapshot never lists skills (main's matrix reached it through load_skill)",
  "skill signals": "an instruction skill, not a tool: the tool snapshot never lists skills (main's matrix reached it through load_skill)",
  gmail_accounts: "shown on every door today; the snapshot predates it",
  lares_read_public_doc: "shown on every door today; the snapshot predates it",
  tracks_list: "web chat only; the snapshot was captured from a session that was not web chat",
  track_items: "web chat only; the snapshot was captured from a session that was not web chat",
  track_add_item: "web chat only; the snapshot was captured from a session that was not web chat",
  track_move_item: "web chat only; the snapshot was captured from a session that was not web chat",
  track_create: "web chat only; the snapshot was captured from a session that was not web chat",
  track_set_steps: "web chat only; the snapshot was captured from a session that was not web chat",
};

/** The representative set, by what each tool is to the person. */
const REPRESENTATIVE: ReadonlyArray<readonly [label: string, tool: string]> = [
  ["the mail read", "gmail_read"],
  ["the mail draft", "gmail_draft"],
  ["the mail send", "gmail_send"],
  ["the calendar read", "calendar_list_events"],
  ["the calendar write", "calendar_create_event"],
  ["the private note read", "agent-kit__vault_read"],
  ["the note search", "agent-kit__vault_search"],
  ["the note write", "agent-kit__vault_write"],
  ["the owner-only link read", "read_url"],
];

/** What a conversation started in a shared Slack room is not offered: the room's H cells that a DM shows. */
const SHARED_ROOM_HIDDEN: readonly string[] = [
  "gmail_accounts", "gmail_read", "gmail_search", "gmail_draft", "gmail_draft_recipients",
  "calendar_list_events", "calendar_list_calendars", "calendar_free_busy", "calendar_conflicts",
  "calendar_create_event", "calendar_update_event", "calendar_delete_event",
  "agent-kit__vault_search", "agent-kit__vault_backlinks", "agent-kit__vault_write", "read_url",
  "person_lookup",
];

// ─── The doors, and the fake messages that knock on them ──────────────────────────────────────

type SessionAuth = { authenticator: string; attributes: Record<string, unknown> } & Record<string, unknown>;

function slackMessage(o: { user: string; room?: boolean; bot?: boolean }) {
  const channelId = o.room ? "C0SHAREDROOM" : "D0DIRECT";
  return { channelId, text: o.room ? "<@U0AGENT> hello" : "hello", markdown: "hello", ts: "1700000000.000100",
    threadTs: "1700000000.000100", teamId: "T0TEAM", attachments: [], author: { userId: o.user, isBot: o.bot === true },
    raw: { channel_type: o.room ? "channel" : "im" } };
}
/** The Slack door, composed exactly as `agent/channels/slack.ts` wires its two handlers:
 *  the claim check first, then the mention or the direct-message admission. */
async function knockOnSlack(message: ReturnType<typeof slackMessage>): Promise<SessionAuth | null> {
  if (await interceptSlackClaim(message, fake.pool, process.env)) return null;
  const eveCtx = { slack: { channelId: message.channelId, threadTs: message.threadTs } } as never;
  const admitted = message.raw.channel_type === "im"
    ? await admitSlackDirectMessage(eveCtx, message as never)
    : admitSlackMessage(eveCtx, message as never);
  return (admitted?.auth as SessionAuth | null | undefined) ?? null;
}

function telegramMessage(o: { user: string; chat?: "private" | "group"; bot?: boolean }) {
  return { text: "hello", caption: "", attachments: [], messageId: "7",
    chat: { id: o.chat === "group" ? "-100500" : o.user, type: o.chat ?? "private" },
    from: { id: o.user, isBot: o.bot === true, firstName: "Example" } };
}
/** The Telegram door's gates, in the order `agent/channels/telegram.ts` applies them. */
async function knockOnTelegram(message: ReturnType<typeof telegramMessage>): Promise<SessionAuth | null> {
  if (await interceptTelegramClaim(message, fake.pool, process.env)) return null;
  if (!isAllowedTelegramMessage(message as never) || !hasDispatchableContent(message as never)) return null;
  return defaultTelegramAuth(message as never) as SessionAuth | null;
}

/** A web chat envelope as the console's proxy sends it: the agent's route password, and (when a
 *  member is signed in) the member the console vouches for. */
function webEnvelope(o: { member?: string; password?: string }): Request {
  const headers: Record<string, string> = {
    authorization: `Basic ${Buffer.from(`eve:${o.password ?? ROUTE_PASSWORD}`).toString("base64")}`,
    "content-type": "application/json",
  };
  if (o.member) {
    Object.assign(headers, { "x-lares-member": `${o.member}@example.invalid`, "x-lares-member-id": o.member,
      "x-lares-admission": NONCE, "x-lares-purpose": "human" });
  }
  return new Request("http://agent.invalid/eve/v1/session", { method: "POST", headers, body: JSON.stringify({ message: "hello" }) });
}
const knockOnWebChat = async (envelope: Request): Promise<SessionAuth | null> =>
  ((await basicFromSecretFile(envelope)) as SessionAuth | null | undefined) ?? null;

interface Door { readonly key: DoorKey; readonly title: string; knock(): Promise<SessionAuth | null> }
const DOORS: readonly Door[] = [
  { key: "slackDm", title: "Slack · owner · direct message", knock: () => knockOnSlack(slackMessage({ user: SLACK_OWNER })) },
  { key: "slackRoom", title: "Slack · owner · mention in a shared channel", knock: () => knockOnSlack(slackMessage({ user: SLACK_OWNER, room: true })) },
  { key: "telegram", title: "Telegram · owner · private chat", knock: () => knockOnTelegram(telegramMessage({ user: TELEGRAM_OWNER })) },
  { key: "webOwner", title: "Web chat · owner · private", knock: () => knockOnWebChat(webEnvelope({ member: WEB_OWNER })) },
  { key: "webMember", title: "Web chat · non-owner member · private", knock: () => knockOnWebChat(webEnvelope({ member: WEB_MEMBER })) },
];
const door = (key: DoorKey): Door => DOORS.find((d) => d.key === key)!;
const column = (key: DoorKey): number => DOOR_KEYS.indexOf(key) + 1;
const cellOf = (tool: string, key: DoorKey): Cell => TABLE.find((row) => row[0] === tool)![column(key)] as Cell;

// ─── Asking a session what it sees and what it may call ───────────────────────────────────────

type Session = { session: { id: string; turn: { id: string; sequence: number }; auth: { current: unknown; initiator: unknown } } };
const sessionWith = (id: string, auth: unknown): Session => ({ session: { id, turn: { id: "turn-1", sequence: 0 }, auth: { current: auth, initiator: auth } } });

type EmittedTool = { approval?: { request(ctx: unknown): Promise<unknown> } };
const resolveCatalogue = async (session: Session): Promise<Record<string, EmittedTool>> =>
  // eve 1.0: the resolver is a `defineDynamic` function of the session (it was an `events["session.started"]` map);
  // `runDynamic` calls it with a JSON-only `ctx.memo`, as eve does before a model call.
  (await runDynamic(catalogueResolver, session as never)) as unknown as Record<string, EmittedTool>;

/** Inputs for the tools whose own policy reads its input before it decides. */
const INPUT: Readonly<Record<string, unknown>> = {
  track_add_item: { home: "vault:main", trackId: "example-track", title: "Example" },
  track_move_item: { home: "vault:main", trackId: "example-track", itemId: "example-item", step: "done" },
  track_create: { trackId: "example-track", title: "Example" },
  track_set_steps: { trackId: "example-track", steps: ["todo", "done"] },
};

type Call = typeof R | typeof C | "refused";
let callNumber = 0;
/** One call of one tool in one session: the approval policy first (as eve consults it), then the
 *  execution guard. Stops before the tool's own body. */
async function attempt(session: Session, name: string, emitted: EmittedTool | undefined): Promise<{ call: Call; reason?: string }> {
  const { catalogueApprovalRequest, guardCatalogueExecution } = await import("../lib/approvals.js");
  const toolInput = INPUT[name] ?? {};
  const ctx = { ...session, toolName: name, toolInput, callId: `call-${++callNumber}` };
  const authored = (CATALOGUE[name]!.tool as { approval?: unknown }).approval;
  try {
    // A shown tool is asked through what the resolver handed over, so a resolver that dropped a
    // tool's approval would show up here. A hidden one is asked at the seam a replayed call reaches.
    const decision = emitted !== undefined
      ? await emitted.approval?.request(ctx)
      : authored === undefined ? undefined : await catalogueApprovalRequest(name, ctx, authored);
    if (decision === "user-approval") return { call: C };
    if (decision === "denied") return { call: "refused", reason: "denied" };
    if (typeof decision === "object" && decision !== null && (decision as { type?: unknown }).type === "denied") {
      return { call: "refused", reason: String((decision as { reason?: unknown }).reason) };
    }
    if (decision !== undefined && decision !== "not-applicable") throw new Error(`unexpected approval decision for ${name}: ${JSON.stringify(decision)}`);
    await guardCatalogueExecution(ctx, name, toolInput);
    return { call: R };
  } catch (error) {
    return { call: "refused", reason: error instanceof Error ? error.message : String(error) };
  }
}

interface Observation { session: Session; shown: string[]; calls: Record<string, Call>; reasons: Record<string, string | undefined> }
const observations = new Map<DoorKey, Promise<Observation>>();
/** Knock on the door once, then ask the resulting session about every row of the table. */
function observe(key: DoorKey): Promise<Observation> {
  let seen = observations.get(key);
  if (!seen) {
    seen = (async () => {
      const auth = await door(key).knock();
      if (auth === null) throw new Error(`${door(key).title}: the door did not open a turn`);
      const session = sessionWith(`matrix-${key}`, auth);
      const tools = await resolveCatalogue(session);
      const calls: Record<string, Call> = {};
      const reasons: Record<string, string | undefined> = {};
      for (const [name] of TABLE) {
        const outcome = await attempt(session, name, tools[name]);
        calls[name] = outcome.call;
        reasons[name] = outcome.reason;
      }
      return { session, shown: Object.keys(tools).sort(), calls, reasons };
    })();
    observations.set(key, seen);
  }
  return seen;
}

const NOT_PREPARED = "could not be prepared for approval";
const baseline = (): string[] =>
  readFileSync(new URL("../../../packages/board-evals/snapshots/tools-chief-of-staff.txt", import.meta.url), "utf8")
    .split("\n").filter((line) => line.length > 0);

let secrets: string;
beforeAll(() => {
  secrets = mkdtempSync(join(tmpdir(), "door-tool-matrix-"));
  writeFileSync(join(secrets, "route-password"), `${ROUTE_PASSWORD}\n`, "utf8");
  vi.stubEnv("EVE_ROUTE_PASSWORD_FILE", join(secrets, "route-password"));
  // A managed agent whose owner has connected both chat doors.
  vi.stubEnv("LARES_AGENT_NAME", "helper");
  vi.stubEnv("LARES_AGENT_INCARNATION", INCARNATION);
  vi.stubEnv("LARES_SLACK_PRINCIPAL", SLACK_OWNER);
  vi.stubEnv("LARES_SLACK_CLAIM_REVISION", "rev-slack");
  vi.stubEnv("LARES_TELEGRAM_PRINCIPAL", TELEGRAM_OWNER);
  vi.stubEnv("LARES_TELEGRAM_CLAIM_REVISION", "rev-telegram");
  fake.definition = parseDefinition(JSON.parse(readFileSync(new URL("../agent.json", import.meta.url), "utf8")));
  // No permissions-board row: each capability's level is the definition's own.
  setBoardDeps({ explicitLevel: async () => null, record: async () => {}, now: () => Date.now() });
  // The exact-card adapters read the card's target and policy from the database, Keeper or the
  // mailbox binding. Those reads are fixed here; WHICH tools have an adapter is what is under test.
  const hash = (letter: string) => letter.repeat(64);
  vi.spyOn(calendarApprovalAdapter, "readTarget").mockImplementation(async (_db, _input, memberId, tool) =>
    ({ kind: "calendar-event", id: `calendar:example:${tool}`, ownerMemberId: memberId, fingerprint: hash("a") }));
  vi.spyOn(calendarApprovalAdapter, "readPolicyHash").mockResolvedValue(hash("b"));
  vi.spyOn(vaultNoteApprovalAdapter, "readTarget").mockImplementation(async (_db, _input, memberId) =>
    ({ kind: "vault-note", id: "notes/example.md", ownerMemberId: memberId, fingerprint: hash("c") }));
  vi.spyOn(vaultNoteApprovalAdapter, "readPolicyHash").mockResolvedValue(hash("d"));
  vi.spyOn(tracksApprovalAdapter, "readTarget").mockImplementation(async (_db, _input, memberId) =>
    ({ kind: "track", id: "tracks/example-track/track.md", ownerMemberId: memberId, fingerprint: hash("e") }));
  vi.spyOn(tracksApprovalAdapter, "readPolicyHash").mockResolvedValue(hash("f"));
});
afterAll(() => {
  setBoardDeps(null);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(secrets, { recursive: true, force: true });
});
// A read the stand-in database was not written for would otherwise look like a refusal.
afterEach(() => { expect(fake.unexpected).toEqual([]); });

// ─── The table cannot rot ─────────────────────────────────────────────────────────────────────

describe("the table covers the baseline", () => {
  const rows = [...TABLE.map((row) => row[0]), ...OWN_RESOLVER.map((row) => row[0])];

  it("has a row, or a stated reason, for every tool in the baseline snapshot", () => {
    const uncovered = baseline().filter((tool) => !rows.includes(tool) && !(tool in NOT_DOOR_DEPENDENT));
    // A new tool reached the baseline: add its row above, or list it as not door-dependent with why.
    expect(uncovered).toEqual([]);
  });

  it("names no tool twice, and no tool that is both in the table and excused from it", () => {
    expect(rows.filter((tool, index) => rows.indexOf(tool) !== index)).toEqual([]);
    expect(rows.filter((tool) => tool in NOT_DOOR_DEPENDENT)).toEqual([]);
    for (const reason of Object.values(NOT_DOOR_DEPENDENT)) expect(reason.length).toBeGreaterThan(20);
  });

  it("excuses only tools the baseline still lists", () => {
    expect(Object.keys(NOT_DOOR_DEPENDENT).filter((tool) => !baseline().includes(tool))).toEqual([]);
  });

  it("has no row for a catalogue tool that no longer exists", () => {
    expect(TABLE.map((row) => row[0]).filter((tool) => !(tool in CATALOGUE))).toEqual([]);
  });

  it("lists every row the baseline does not, with why", () => {
    expect(rows.filter((tool) => !baseline().includes(tool)).sort()).toEqual(Object.keys(NOT_IN_BASELINE).sort());
  });
});

// ─── Each door, for the people it admits ──────────────────────────────────────────────────────

describe("the door opens a turn for the people it admits", () => {
  it("Slack · owner · direct message: opens a turn as that Slack user", async () => {
    const auth = await knockOnSlack(slackMessage({ user: SLACK_OWNER }));
    expect(auth).toMatchObject({ authenticator: "slack-webhook", attributes: { user_id: SLACK_OWNER, channel_id: "D0DIRECT" } });
  });

  // The room is recorded on the session; the tool list reads it from the session's initiator.
  it("Slack · owner · mention in a shared channel: opens a turn as the owner, the same as a direct message", async () => {
    const auth = await knockOnSlack(slackMessage({ user: SLACK_OWNER, room: true }));
    expect(auth).toMatchObject({ authenticator: "slack-webhook", attributes: { user_id: SLACK_OWNER, channel_id: "C0SHAREDROOM" } });
  });

  it("Telegram · owner · private chat: opens a turn as that Telegram user", async () => {
    const auth = await knockOnTelegram(telegramMessage({ user: TELEGRAM_OWNER }));
    expect(auth).toMatchObject({ authenticator: "telegram-webhook", attributes: { user_id: TELEGRAM_OWNER, chat_type: "private" } });
  });

  it("Web chat · owner · private: opens a turn as the member the console vouched for", async () => {
    const auth = await knockOnWebChat(webEnvelope({ member: WEB_OWNER }));
    expect(auth).toMatchObject({ authenticator: "lares-console", principalId: WEB_OWNER,
      attributes: { lares_member_id: WEB_OWNER, lares_purpose: "human" } });
  });

  it("Web chat · non-owner member · private: opens a turn as that member, not as the owner", async () => {
    const auth = await knockOnWebChat(webEnvelope({ member: WEB_MEMBER }));
    expect(auth).toMatchObject({ authenticator: "lares-console", principalId: WEB_MEMBER, attributes: { lares_member_id: WEB_MEMBER } });
  });
});

describe("what each door shows and allows", () => {
  for (const { key, title } of DOORS) {
    it(`${title}: sees exactly the tools its column says, no more and no fewer`, async () => {
      const { shown } = await observe(key);
      const expected = TABLE.filter((row) => row[column(key)] !== H).map((row) => row[0]).sort();
      expect(shown).toEqual(expected);
    });

    it(`${title}: each call runs, raises a card or is refused as its column says`, async () => {
      const { calls } = await observe(key);
      const expected = Object.fromEntries(TABLE.map((row) => {
        const cell = row[column(key)] as Cell;
        return [row[0], cell === H || cell === X ? "refused" : cell];
      }));
      expect(calls).toEqual(expected);
    });

    it(`${title}: a tool it does not see is refused by the door's own rule, whatever the tool would have asked`, async () => {
      const { reasons } = await observe(key);
      // A shared room says why in words for the room, and points to a direct message only for a
      // tool the direct-message column shows; every other door keeps the console's wording.
      const rule = (row: Row) => key !== "slackRoom" ? CONSOLE_AUTHORITY_REFUSED
        : row[column("slackDm")] === H ? SHARED_ROOM_UNAVAILABLE : SHARED_ROOM_REFUSED;
      for (const row of TABLE) if (row[column(key)] === H) expect(reasons[row[0]], row[0]).toBe(rule(row));
    });

    for (const [label, tool] of REPRESENTATIVE) {
      const cell = cellOf(tool, key);
      const sees = cell === H ? "does not see" : "sees";
      const outcome = cell === R ? "a call runs" : cell === C ? "a call raises an approval card first" : "a call is refused";
      it(`${title}: ${sees} ${label} (${tool}), ${outcome}`, async () => {
        const { shown, calls } = await observe(key);
        expect(shown.includes(tool)).toBe(cell !== H);
        expect(calls[tool]).toBe(cell === R || cell === C ? cell : "refused");
      });
    }
  }
});

// ─── Tools with their own resolver ────────────────────────────────────────────────────────────

describe("tools with their own resolver", () => {
  const started = async (resolver: unknown, session: Session): Promise<unknown> => runDynamic(resolver, session as never);
  const SEEN: Readonly<Record<string, (session: Session) => Promise<boolean>>> = {
    commercial_who_to_contact: async (session) => (await started(commercialResolver, session)) !== null,
    lares_read_public_doc: async (session) =>
      "lares_read_public_doc" in ((await started(publicDocResolver, session)) as Record<string, unknown>),
    "skill lares-docs": async (session) => (await started(laresDocsSkill, session)) !== null,
    "skill sales-outreach": async (session) => (await started(salesOutreachSkill, session)) !== null,
    "skill signals": async (session) => (await started(signalsSkill, session)) !== null,
  };

  for (const { key, title } of DOORS) {
    for (const row of OWN_RESOLVER) {
      const cell = row[column(key)] as OwnCell;
      it(`${title}: ${cell === S ? "sees" : "does not see"} ${row[0]}`, async () => {
        const { session } = await observe(key);
        expect(await SEEN[row[0]]!(session)).toBe(cell === S);
      });
    }
  }

  for (const key of ["webOwner", "webMember"] as const) {
    it(`${door(key).title}: a call of commercial_who_to_contact is refused before the CRM is read`, async () => {
      const native = (await started(commercialResolver, (await observe("slackDm")).session)) as { execute(input: unknown, ctx: unknown): Promise<unknown> };
      await expect(native.execute({}, (await observe(key)).session)).rejects.toThrow(CONSOLE_AUTHORITY_REFUSED);
    });

    // Main's "load_skill offers the public help skill only, and refuses the others": on eve 1.0 the others are not there.
    it(`${door(key).title}: offers the public help skill only; the others are absent, not refused`, async () => {
      const { session } = await observe(key);
      const docs = (await started(laresDocsSkill, session)) as { description?: string; content?: string } | null;
      expect(docs).not.toBeNull();
      expect(JSON.stringify(docs)).toContain("Public Lares documentation");
      expect(await started(signalsSkill, session)).toBeNull();
      expect(await started(salesOutreachSkill, session)).toBeNull();
    });
  }

  // Main's "load_skill offers and loads the agent's own skills" for the chat doors.
  for (const key of ["slackDm", "slackRoom", "telegram"] as const) {
    it(`${door(key).title}: offers the agent's own skills and their text`, async () => {
      const { session } = await observe(key);
      expect(JSON.stringify(await started(signalsSkill, session))).toContain("# Signals");
      expect(await started(salesOutreachSkill, session)).not.toBeNull();
      expect(await started(laresDocsSkill, session)).not.toBeNull();
    });
  }
});

// ─── People the doors do not admit ────────────────────────────────────────────────────────────

describe("an unauthorised or unknown speaker", () => {
  const NO_TURN = "no turn starts, so nothing is seen and nothing can be called";

  it(`Slack · unknown person · direct message: ${NO_TURN}`, async () => {
    expect(await knockOnSlack(slackMessage({ user: SLACK_STRANGER }))).toBeNull();
  });

  it(`Slack · unknown person · mention in a shared channel: ${NO_TURN}`, async () => {
    expect(await knockOnSlack(slackMessage({ user: SLACK_STRANGER, room: true }))).toBeNull();
  });

  it(`Slack · a bot using the owner's id · direct message: ${NO_TURN}`, async () => {
    expect(await knockOnSlack(slackMessage({ user: SLACK_OWNER, bot: true }))).toBeNull();
  });

  it(`Telegram · unknown person · private chat: ${NO_TURN}`, async () => {
    expect(await knockOnTelegram(telegramMessage({ user: TELEGRAM_STRANGER }))).toBeNull();
  });

  it(`Telegram · owner · group chat: ${NO_TURN}`, async () => {
    expect(await knockOnTelegram(telegramMessage({ user: TELEGRAM_OWNER, chat: "group" }))).toBeNull();
  });

  it(`Web chat · wrong route password · private: ${NO_TURN}`, async () => {
    expect(await knockOnWebChat(webEnvelope({ member: WEB_OWNER, password: "not-the-password" }))).toBeNull();
  });

  it(`Web chat · a member the installation does not vouch for · private: ${NO_TURN}`, async () => {
    expect(await knockOnWebChat(webEnvelope({ member: WEB_STRANGER }))).toBeNull();
  });

  // A card in a shared channel can be clicked by anyone who sees it, and the click arrives as the
  // clicker. The tool re-checks who that was before it acts.
  it("Slack · unknown person · shared channel: an Approve click on the owner's card is refused", async () => {
    const owner = (await observe("slackRoom")).session.session.auth.current;
    const clicker = { authenticator: "slack-webhook", attributes: { user_id: SLACK_STRANGER, channel_id: "C0SHAREDROOM" } };
    expect(() => assertApprover(approverFrom({ current: clicker, initiator: owner }))).toThrow(/not an allowed approver/);
    expect(() => assertApprover(approverFrom({ current: owner, initiator: owner }))).not.toThrow();
  });

  // Telegram resumes a tapped card with no identity; it is attributed to whoever opened the chat.
  it("Telegram · owner · private chat: a tap on a card counts as the owner's, and a stranger's session would not", async () => {
    const owner = (await observe("telegram")).session.session.auth.current;
    expect(() => assertApprover(approverFrom({ current: null, initiator: owner }))).not.toThrow();
    const stranger = defaultTelegramAuth(telegramMessage({ user: TELEGRAM_STRANGER }) as never);
    expect(() => assertApprover(approverFrom({ current: null, initiator: stranger }))).toThrow(/not an allowed approver/);
  });

  // On Slack and Telegram the tool list does not look at who is speaking: the door's admission
  // above is the only thing that keeps a stranger from the owner's list. If a turn were ever
  // opened for one, the second checks are these two; a read that asks nothing has none.
  it("Slack · unknown person · direct message: were a turn ever opened for them, it would see the owner's list; only cards and remembered facts check again", async () => {
    const stranger = sessionWith("matrix-stranger", { authenticator: "slack-webhook", attributes: { user_id: SLACK_STRANGER, channel_id: "D0OTHER" } });
    expect(Object.keys(await resolveCatalogue(stranger)).sort()).toEqual((await observe("slackDm")).shown);
    expect(() => assertApprover(approverFrom(stranger.session.auth))).toThrow(/not an allowed approver/);
    expect(humanTurnRefusal(stranger.session, "Not saved.")).toContain("not as the owner");
    expect(humanTurnRefusal((await observe("slackDm")).session.session, "Not saved.")).toBeNull();
  });

  // The agent's route password is held by the console and the keeper. A request that carries it
  // and names no member is not web chat: it is treated like Slack or Telegram, with no person on it.
  it("Web chat · route password with no member named · private: gets the Slack and Telegram list; reads run, and a card has no one who may approve it", async () => {
    const auth = await knockOnWebChat(webEnvelope({}));
    expect(auth).toMatchObject({ authenticator: "http-basic" });
    const session = sessionWith("matrix-no-member", auth);
    const tools = await resolveCatalogue(session);
    expect(Object.keys(tools).sort()).toEqual((await observe("slackDm")).shown);
    expect((await attempt(session, "gmail_read", tools["gmail_read"])).call).toBe(R);
    expect((await attempt(session, "gmail_send", tools["gmail_send"])).call).toBe(C);
    expect(() => assertApprover(approverFrom(session.session.auth))).toThrow(/not an allowed approver/);
  });
});

// ─── Found: what the table records today, and what should hold instead ────────────────────────

describe("Found: what the table records today, and what should hold instead", () => {
  // Fixed: a shared-channel mention no longer gets the direct-message list.
  it("Slack · owner · mention in a shared channel: does not see private mail, calendar or note reads the room would read along with", async () => {
    const { shown } = await observe("slackRoom");
    expect(shown.filter((tool) => ["gmail_read", "gmail_search", "calendar_list_events", "agent-kit__vault_search"].includes(tool))).toEqual([]);
  });

  // The same fix, as the difference it makes: the room sees the direct-message list less exactly the
  // private tools, and a call of one of those is refused; every other call goes as it does in a DM.
  it("Slack · owner · mention in a shared channel: sees and may call what a direct message does, less the private tools", async () => {
    const room = await observe("slackRoom");
    const direct = await observe("slackDm");
    expect(direct.shown).toEqual(expect.arrayContaining([...SHARED_ROOM_HIDDEN]));
    expect(room.shown).toEqual(direct.shown.filter((tool) => !SHARED_ROOM_HIDDEN.includes(tool)));
    for (const tool of SHARED_ROOM_HIDDEN) expect(room.reasons[tool], tool).toBe(SHARED_ROOM_REFUSED);
    const others = (calls: Record<string, Call>) => Object.fromEntries(Object.entries(calls).filter(([tool]) => !SHARED_ROOM_HIDDEN.includes(tool)));
    expect(others(room.calls)).toEqual(others(direct.calls));
  });

  it("the shared room hides exactly the DM tools the private-surface rule names", () => {
    const dm = TABLE.filter((row) => row[column("slackDm")] !== H).map((row) => row[0]);
    expect(dm.filter((tool) => sharedRoomHiddenTool(tool)).sort()).toEqual([...SHARED_ROOM_HIDDEN].sort());
  });

  // A card answered in the room makes the answerer the session's current identity (agent/channels/slack.ts).
  // The room is read from the initiator, so neither the saved list, a rebuilt one, nor the guard changes.
  describe("a card answered in a shared room cannot bring the hidden tools back", () => {
    const roomOwner = { authenticator: "slack-webhook", attributes: { user_id: SLACK_OWNER, channel_id: "C0SHAREDROOM" } };
    const answeredFromDm = { authenticator: "slack-webhook", attributes: { user_id: SLACK_OWNER, channel_id: "D0DIRECT" } };
    const after = (id: string): Session => ({ session: { id, turn: { id: "turn-2", sequence: 1 },
      auth: { current: answeredFromDm, initiator: roomOwner } } });

    it("the saved list of the same conversation, evaluated again after the answer", async () => {
      const store: MemoStore = new Map();
      const before = Object.keys(await runDynamic(catalogueResolver, sessionWith("matrix-room-card", roomOwner) as never, store)).sort();
      const later = Object.keys(await runDynamic(catalogueResolver, after("matrix-room-card") as never, store)).sort();
      expect(later).toEqual(before);
      expect(later.filter((tool) => SHARED_ROOM_HIDDEN.includes(tool))).toEqual([]);
    });

    it("a list rebuilt from nothing (a restart), and a new conversation in the same room", async () => {
      const room = (await observe("slackRoom")).shown;
      expect(Object.keys(await runDynamic(catalogueResolver, after("matrix-room-card") as never, new Map())).sort()).toEqual(room);
      expect(Object.keys(await runDynamic(catalogueResolver, after("matrix-room-next") as never, new Map())).sort()).toEqual(room);
    });

    it("a call of a hidden tool after the answer is refused by the door's own rule", async () => {
      for (const tool of ["gmail_read", "calendar_list_events", "agent-kit__vault_search"]) {
        expect((await attempt(after("matrix-room-card"), tool, undefined)).reason, tool).toBe(SHARED_ROOM_REFUSED);
      }
    });

    // A card for a hidden tool (raised before the room lost it, or replayed): the owner's Approve is
    // refused, and the tool, called with a handle from a direct message's list, never runs its body.
    it("answering a card for a hidden tool does not run the tool", async () => {
      const tool = "calendar_create_event";
      const answer = { session: { id: "matrix-room-card", initiator: roomOwner },
        response: { decision: "approve", principal: roomOwner }, request: { interactionId: "interaction-1", toolInput: {} } };
      await expect(catalogueApprovalResponse(tool, answer)).rejects.toThrow(SHARED_ROOM_REFUSED);

      const body = vi.spyOn(CATALOGUE[tool]!.tool as unknown as { execute: (...args: unknown[]) => unknown }, "execute");
      const handle = (await resolveCatalogue(sessionWith("matrix-dm-handle", answeredFromDm)))[tool] as unknown as
        { execute(input: unknown, ctx: unknown): Promise<unknown> };
      expect(handle).toBeDefined();
      const approved = { ...after("matrix-room-card"), toolName: tool, toolInput: {}, callId: "call-room-card",
        approval: { responder: roomOwner } };
      await expect(handle.execute({}, approved)).rejects.toThrow(SHARED_ROOM_REFUSED);
      expect(body).not.toHaveBeenCalled();
      body.mockRestore();
    });
  });

  // The people lookup reads, in one call, the mail with a person, the meetings with them and note excerpts.
  it("people lookup: hidden and refused in a shared room; unchanged in a direct message, Telegram and web chat", async () => {
    const room = await observe("slackRoom");
    expect(room.shown).not.toContain("person_lookup");
    expect(room.reasons["person_lookup"]).toBe(SHARED_ROOM_REFUSED);
    for (const key of ["slackDm", "telegram"] as const) {
      const { shown, calls } = await observe(key);
      expect(shown, key).toContain("person_lookup");
      expect(calls["person_lookup"], key).toBe(R);
    }
    for (const key of ["webOwner", "webMember"] as const) {
      const { shown, reasons } = await observe(key);
      expect(shown, key).not.toContain("person_lookup");
      expect(reasons["person_lookup"], key).toBe(CONSOLE_AUTHORITY_REFUSED);
    }
  });

  // Fails closed: a Slack conversation the code cannot place in a direct message is treated as a room.
  const UNPLACED: ReadonlyArray<readonly [string, unknown]> = [
    ["no channel on the session", { authenticator: "slack-webhook", attributes: { user_id: SLACK_OWNER } }],
    ["a channel that is not a direct message", { authenticator: "slack-webhook", attributes: { user_id: SLACK_OWNER, channel_id: "G0PRIVATEROOM" } }],
  ];
  for (const [label, auth] of UNPLACED) {
    it(`Slack · owner · ${label}: treated as a shared room`, async () => {
      const session = sessionWith(`matrix-unplaced-${label.length}`, auth);
      expect(Object.keys(await resolveCatalogue(session)).sort()).toEqual((await observe("slackRoom")).shown);
      expect((await attempt(session, "gmail_read", undefined)).reason).toBe(SHARED_ROOM_REFUSED);
    });
  }
  it("Slack · owner · no initiator on the session: treated as a shared room", async () => {
    const dm = { authenticator: "slack-webhook", attributes: { user_id: SLACK_OWNER, channel_id: "D0DIRECT" } };
    const session: Session = { session: { id: "matrix-no-initiator", turn: { id: "turn-1", sequence: 0 }, auth: { current: dm, initiator: null } } };
    expect(Object.keys(await resolveCatalogue(session)).sort()).toEqual((await observe("slackRoom")).shown);
    expect((await attempt(session, "gmail_read", undefined)).reason).toBe(SHARED_ROOM_REFUSED);
  });

  // Unchanged: a direct message, Telegram and the web chat keep the private tools their columns name.
  it("Slack direct message, Telegram and web chat still see the private tools their columns name", async () => {
    for (const key of ["slackDm", "telegram", "webOwner", "webMember"] as const) {
      const { shown } = await observe(key);
      const named = TABLE.filter((row) => row[column(key)] !== H && SHARED_ROOM_HIDDEN.includes(row[0])).map((row) => row[0]);
      expect(named.length, key).toBeGreaterThan(0);
      expect(shown, key).toEqual(expect.arrayContaining(named));
    }
  });

  // Found: web chat sends every tool with an approval policy down the exact-card path, and `adapterFor` in lib/approvals.ts has no card adapter for these three.
  for (const tool of ["gmail_draft", "gmail_draft_recipients", "read_url"]) {
    it.fails(`Web chat · owner · private: sees ${tool}, and a call is not refused out of hand`, async () => {
      const { shown, calls } = await observe("webOwner");
      expect(shown).toContain(tool);
      expect(calls[tool]).not.toBe("refused");
    });

    it(`Web chat · owner · private: today sees ${tool}, and every call is refused as "could not be prepared"`, async () => {
      const { shown, reasons } = await observe("webOwner");
      expect(shown).toContain(tool);
      expect(reasons[tool]).toContain(NOT_PREPARED);
    });
  }

  // Found: the baseline and the agent's own instructions name these two; `privateOnlyTool` in agent-kit keeps them off Slack and Telegram.
  for (const key of ["slackDm", "telegram"] as const) {
    it.fails(`${door(key).title}: sees the note read and list tools that the baseline and its own instructions name`, async () => {
      const { shown } = await observe(key);
      expect(shown).toEqual(expect.arrayContaining(["agent-kit__vault_read", "agent-kit__vault_list"]));
    });
  }

  it("Slack · owner · direct message: its instructions name the note read and list tools it is not shown", async () => {
    const persona = readFileSync(new URL("../agent/persona.md", import.meta.url), "utf8");
    const { shown } = await observe("slackDm");
    for (const tool of ["agent-kit__vault_read", "agent-kit__vault_list"]) {
      expect(persona).toContain(`\`${tool}\``);
      expect(baseline()).toContain(tool);
      expect(shown).not.toContain(tool);
    }
  });
});
