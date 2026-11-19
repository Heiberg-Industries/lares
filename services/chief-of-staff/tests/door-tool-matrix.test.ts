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
//   handed to that door's own code, except the shared-room column, which starts from a signed
//   `app_mention` pushed through the Slack door's real route (`helpers/slack-mention.ts`); the
//   session it returns is what the tools are asked with.
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
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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

// Off unless a test turns it on: then web chat's turn holds a Vault capability and keeper's answers are recorded here.
const keeper = vi.hoisted(() => ({ writeError: undefined as undefined | Error, on: false, realPass: false, refuseDoorPass: false, passUnreachable: false, inbox: [] as string[], calls: [] as Array<{ op: string; input: Record<string, unknown> }> }));
vi.mock("@lares/agent-kit/vault-broker-client", async (original) => {
  const real = await original<typeof import("@lares/agent-kit/vault-broker-client")>();
  return { ...real,
  // The folder listing is built on the module's own request function, so it is stood in for here the way the request is.
  vaultBrokerListFolder: async (turn: Record<string, unknown>, folder: string, ...rest: unknown[]) => {
    if (!keeper.on) return (real.vaultBrokerListFolder as (...args: unknown[]) => unknown)(turn, folder, ...rest);
    keeper.calls.push({ op: "vault.read", input: { ...turn, operation: "list", folder } });
    return keeper.inbox;
  },
  vaultBrokerRequest: async (op: string, input: Record<string, unknown>, ...rest: unknown[]) => {
    if (!keeper.on) return (real.vaultBrokerRequest as (...args: unknown[]) => unknown)(op, input, ...rest);
    keeper.calls.push({ op, input });
    if (op === "door.turn.open" && keeper.passUnreachable) return Promise.reject(new real.VaultBrokerError("Vault reader unavailable (the connection to the keeper failed)", "connection"));
    if (op === "door.turn.open") return keeper.refuseDoorPass ? Promise.reject(new real.VaultBrokerError("Vault reader unavailable (the keeper refused: grant)", "refused", "grant")) : { ok: true, turnCapability: "d".repeat(43), expiresAt: Date.now() + 60_000, memberId: "member-owner" };
    if (op === "vault.write") return keeper.writeError ? Promise.reject(keeper.writeError) : { ok: true, path: "_inbox/oslo-trip.md", commit: "abc1234" };
    if (input.operation === "list" && input.folder === "_inbox") return { ok: true, notes: keeper.inbox };
    if (input.operation === "read") return { ok: true, content: "an existing note" };
    return input.operation === "search" ? { ok: true, hits: ["people/vera.md"], files: 2000 } : { ok: true, notes: ["people/vera.md"], nextCursor: 200 };
  } };
});
vi.mock("../agent/lib/vault-turn.js", async (original) => {
  const real = await original<typeof import("../agent/lib/vault-turn.js")>();
  return { ...real, vaultTurnCapability: (...args: Parameters<typeof real.vaultTurnCapability>) => keeper.on && !keeper.realPass
    ? { turnId: "turn-1", sequence: 0, capability: "turn-capability", expiresAt: Date.now() + 60_000 } : real.vaultTurnCapability(...args) };
});

const fake = vi.hoisted(() => {
  const asks = new Map<string, Record<string, unknown>>();
  const unexpected: string[] = [];
  const claims = [
    { kind: "slack", principal: "U0OWNER", revision: "5c1ac4e0-0000-4000-8000-000000000001", applied_revision: "5c1ac4e0-0000-4000-8000-000000000001" },
    { kind: "telegram", principal: "1001", revision: "5c1ac4e0-0000-4000-8000-000000000002", applied_revision: "5c1ac4e0-0000-4000-8000-000000000002" },
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
        // The card's id arriving, and the owner's Approve being written.
        if (/^UPDATE approval_asks SET request_id=\$2/.test(sql)) {
          const row = asks.get(values[0] as string);
          if (row && (row.request_id == null || row.request_id === values[1])) { row.request_id = values[1]; return { rows: [{ request_id: values[1] }] }; }
          return { rows: [] };
        }
        if (/^UPDATE approval_asks SET outcome='approved'/.test(sql)) {
          const [callId, requestId, member, via] = values as string[];
          const row = asks.get(callId!);
          if (row && row.request_id === requestId && (row.outcome == null || row.outcome === "approved")) {
            Object.assign(row, { outcome: "approved", resolved_by_member_id: member, answered_via: via });
            return { rows: [{ call_id: callId }] };
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
// Likewise no matrix turn applied an answer to a card, so the rule that refuses an action reaching
// other people in that reply does not apply (still refusing a turn with no id, as the real one does);
// the rule itself: tests/turn-after-answered-card.test.ts.
vi.mock("../lib/approval-card-turns.js", async (original) => {
  const real = await original<typeof import("../lib/approval-card-turns.js")>();
  return {
    ...real,
    turnAskedACard: (session: { turn?: { id?: unknown } | null } | null | undefined) => typeof session?.turn?.id !== "string" || !session.turn.id,
    outwardActionAfterAnswerRefusal: (session: { turn?: { id?: unknown } | null } | null | undefined, reason = real.ANSWERED_TURN_REFUSED) =>
      typeof session?.turn?.id === "string" && session.turn.id ? undefined : { type: "denied" as const, reason },
  };
});
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
import { SHARED_ROOM_REFUSED, SHARED_ROOM_UNAVAILABLE, sharedRoomAllows, startedIn } from "@lares/agent-kit/shared-room";
import { parseDefinition } from "@lares/agent-kit/definition";
import { interceptSlackClaim, interceptTelegramClaim } from "@lares/agent-kit/door-channels";

import { basicFromSecretFile } from "../agent/channels/eve.js";
import { admitSlackMessage } from "@lares/agent-kit/slack-door";
import { admitSlackDirectMessage } from "../agent/channels/slack.js";
import { hasDispatchableContent, isAllowedTelegramMessage } from "../agent/channels/telegram.js";
import catalogueResolver from "../agent/tools/catalogue.js";
import commercialResolver from "../agent/tools/commercial_who_to_contact.js";
import publicDocResolver from "../agent/tools/public_doc.js";
import laresDocsSkill from "../agent/skills/lares-docs.js";
import salesOutreachSkill from "../agent/skills/sales-outreach.js";
import signalsSkill from "../agent/skills/signals.js";
import { CATALOGUE } from "../catalogue/index.js";
import { runDynamic, type MemoStore } from "../../../packages/agent-kit/tests/helpers/eve-dynamic.js";
import { offeredBy, ownResolverFiles } from "../../../packages/agent-kit/tests/helpers/own-resolvers.js";
import { frameworkMentionAuth } from "./helpers/slack-mention.js";
import { clearSessionVaultTurnCapabilities } from "../agent/lib/vault-turn.js";
import { VaultBrokerError } from "@lares/agent-kit/vault-broker-client";
import { DOOR_NOTE_APPROVAL_EXPIRED, DOOR_NOTE_CARD_SHORTENED, DOOR_NOTE_CARD_UNCONFIRMED, DOOR_NOTE_READ_FAILED, DOOR_NOTE_SAVE_FAILED, DOOR_NOTE_SAVE_NOT_POSSIBLE, DOOR_NOTE_TITLE_TAKEN, DOOR_NOTE_TOOL_UNAVAILABLE, DOOR_NOTE_UNREACHABLE, DOOR_VAULT_SENTENCES } from "@lares/agent-kit/door-vault-sentences";
import { approverFrom, assertApprover, catalogueApprovalResponse, humanTurnRefusal } from "../lib/approvals.js";
import { calendarApprovalAdapter } from "../lib/calendar-approval.js";
import { deadlineApprovalAdapter } from "../lib/deadlines-store.js";
import { tracksApprovalAdapter } from "../lib/tracks-approval.js";
import { vaultNoteApprovalAdapter } from "../lib/vault-note-write.js";

// ─── The table ────────────────────────────────────────────────────────────────────────────────
//
// One row per tool, one column per door. Each cell answers both questions:
// Note tools Keeper has no door road for: hidden on a managed door and refused with the door sentence.
const DOOR_HIDDEN_NOTE_TOOLS = ["agent-kit__vault_backlinks", "agent-kit__vault_file", "agent-kit__vault_drop"];
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
// The Slack room column is the room rule (`sharedRoomAllows` in `@lares/agent-kit/shared-room`):
// everyone in the room reads the answer, so only public material, the conversation's language and
// read-only looks at contacts, deadlines and reminders are shown; everything else is hidden and
// refused, and no tool shown there raises a card.
//
//                                        Slack    Slack    Tele-    Web      Web
//                                        owner    owner    gram     owner    member
//                                        DM       room     owner
const TABLE: readonly Row[] = [
  // Mail
  ["gmail_read",                          R,       H,       R,       R,       R],
  ["gmail_search",                        R,       H,       R,       R,       R],
  ["gmail_signature",                     R,       H,       R,       H,       H],
  ["gmail_send",                          C,       H,       C,       H,       H],
  // Found: web chat shows the owner these two and refuses every call (see the `it.fails` below).
  ["gmail_draft",                         C,       H,       C,       X,       H],
  ["gmail_draft_recipients",              C,       H,       C,       X,       H],
  // Calendar
  ["calendar_list_events",                R,       H,       R,       R,       H],
  ["calendar_list_calendars",             R,       H,       R,       R,       H],
  ["calendar_free_busy",                  R,       H,       R,       R,       H],
  ["calendar_conflicts",                  R,       H,       R,       R,       H],
  ["calendar_create_event",               C,       H,       C,       C,       H],
  ["calendar_update_event",               C,       H,       C,       C,       H],
  ["calendar_delete_event",               C,       H,       C,       C,       H],
  // Notes (the Vault). Found: Slack and Telegram search notes but cannot read or list them.
  ["agent-kit__vault_read",               R,       H,       R,       R,       R],
  ["agent-kit__vault_list",               R,       H,       R,       R,       R],
  ["agent-kit__vault_search",             R,       H,       R,       R,       R],
  ["agent-kit__vault_backlinks",          H,       H,       H,       H,       H],
  // On a door the note save is a card only through Keeper's pass; this table has no Keeper, so it is refused here ("door notes go to keeper" below holds the card).
  ["agent-kit__vault_write",              X,       H,       X,       C,       C],
  ["agent-kit__vault_file",               H,       H,       H,       H,       H],
  ["agent-kit__vault_drop",               H,       H,       H,       H,       H],
  ["save_note",                           R,       H,       R,       H,       H],
  ["atlas_proposals",                     R,       H,       R,       H,       H],
  ["atlas_resolve_proposal",              C,       H,       C,       H,       H],
  // Links. Found: same as the drafts, shown to the owner in web chat and always refused.
  ["read_url",                            R,       H,       R,       X,       H],
  // What the agent remembers
  ["remember",                            R,       H,       R,       H,       H],
  ["forget",                              C,       H,       C,       H,       H],
  ["facts_list",                          R,       H,       R,       H,       H],
  ["memory_used",                         R,       H,       R,       H,       H],
  ["memory_proposals",                    R,       H,       R,       H,       H],
  ["memory_resolve_proposal",             C,       H,       C,       H,       H],
  // Deadlines, reminders, obligations. Web chat's owner may list, add, restart and dismiss
  // deadlines and list reminders; setting or cancelling a reminder, closing a deadline and minting
  // a year of them have no exact web chat card, so they are not offered there.
  ["deadline_list",                       R,       R,       R,       R,       H],
  ["deadline_add",                        R,       H,       R,       R,       H],
  ["deadline_reset",                      R,       H,       R,       R,       H],
  ["deadline_done",                       C,       H,       C,       H,       H],
  ["deadline_dismiss",                    C,       H,       C,       C,       H],
  ["deadline_mint_statutory",             C,       H,       C,       H,       H],
  ["remind_list",                         R,       R,       R,       R,       H],
  ["remind_set",                          C,       H,       C,       H,       H],
  ["remind_cancel",                       C,       H,       C,       H,       H],
  ["obligation_dismiss",                  R,       H,       R,       H,       H],
  // People and the CRM
  ["person_lookup",                       R,       H,       R,       H,       H],
  ["identity_my_addresses",               R,       H,       R,       H,       H],
  ["twenty_lookup",                       R,       R,       R,       H,       H],
  ["twenty_get_person",                   R,       R,       R,       H,       H],
  ["twenty_company_for_person",           R,       R,       R,       H,       H],
  ["twenty_comm_state",                   C,       H,       C,       H,       H],
  ["twenty_create_opportunity",           C,       H,       C,       H,       H],
  ["twenty_do_not_contact",               C,       H,       C,       H,       H],
  ["twenty_note",                         C,       H,       C,       H,       H],
  ["twenty_set_stage",                    C,       H,       C,       H,       H],
  ["outreach_track",                      R,       H,       R,       H,       H],
  // Meetings
  ["meeting_followup_auto",               C,       H,       C,       H,       H],
  ["meeting_followup_redraft",            C,       H,       C,       H,       H],
  ["meeting_followup_send",               C,       H,       C,       H,       H],
  ["meeting_followup_record_denial",      R,       H,       R,       H,       H],
  // Notion proposals
  ["notion_proposals",                    R,       H,       R,       H,       H],
  ["notion_resolve_proposal",             C,       H,       C,       H,       H],
  // The rest
  ["agent-kit__signals_recent",           R,       H,       R,       H,       H],
  ["digest_run",                          R,       H,       R,       H,       H],
  ["echo_note",                           C,       H,       C,       H,       H],
  ["set_language",                        R,       R,       R,       H,       H],
  ["voice_guide",                         R,       H,       R,       H,       H],
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
  ["commercial_who_to_contact",           S,       H,       S,       H,       H],
  ["lares_read_public_doc",               S,       S,       S,       S,       S],
  // The skills replace main's `load_skill` rows. On eve 1.0 a skill the conversation may not have is simply absent
  // (there is no authored loader to refuse it), so what a door can load is what its skill files return.
  ["skill lares-docs",                    S,       S,       S,       S,       S],
  ["skill sales-outreach",                S,       H,       S,       H,       H],
  ["skill signals",                       S,       H,       S,       H,       H],
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
const SHARED_ROOM_HIDDEN: readonly string[] = TABLE
  .filter((row) => row[1] !== H && row[2] === H).map((row) => row[0]);

/** Catalogue tools with no row: the neutral definition grants none of them, so no door shows them. */
const NOT_GRANTED: Readonly<Record<string, string>> = {
  "agent-kit__transit_plan": "the neutral definition does not grant `transit`; the room rule lists it (public transport)",
  personal_calendar_accounts: "console-only (`privateOnlyTool`); the neutral definition does not grant it",
  personal_calendar_events: "console-only (`privateOnlyTool`); the neutral definition does not grant it",
  personal_mailbox_accounts: "console-only (`privateOnlyTool`); the neutral definition does not grant it",
  personal_mailbox_list: "console-only (`privateOnlyTool`); the neutral definition does not grant it",
  personal_mailbox_read: "console-only (`privateOnlyTool`); the neutral definition does not grant it",
  personal_mailbox_send: "console-only (`privateOnlyTool`); the neutral definition does not grant it",
};

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
  // The room column is read from the identity eve itself builds for a signed `app_mention` pushed
  // through the door's real route (`helpers/slack-mention.ts`), not from a hand-made message.
  { key: "slackRoom", title: "Slack · owner · mention in a shared channel", knock: async () =>
    (await frameworkMentionAuth("C0SHAREDROOM", { keepModules: true, user: SLACK_OWNER })) as unknown as SessionAuth },
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
// The note adapter's own target read, kept before the stand-in replaces it for the rest of the file.
let realNoteReadTarget: typeof vaultNoteApprovalAdapter.readTarget;
beforeAll(() => {
  secrets = mkdtempSync(join(tmpdir(), "door-tool-matrix-"));
  writeFileSync(join(secrets, "route-password"), `${ROUTE_PASSWORD}\n`, "utf8");
  vi.stubEnv("EVE_ROUTE_PASSWORD_FILE", join(secrets, "route-password"));
  // A managed agent whose owner has connected both chat doors.
  vi.stubEnv("LARES_AGENT_NAME", "helper");
  vi.stubEnv("LARES_AGENT_INCARNATION", INCARNATION);
  vi.stubEnv("LARES_SLACK_PRINCIPAL", SLACK_OWNER);
  vi.stubEnv("LARES_SLACK_CLAIM_REVISION", "5c1ac4e0-0000-4000-8000-000000000001");
  vi.stubEnv("LARES_TELEGRAM_PRINCIPAL", TELEGRAM_OWNER);
  vi.stubEnv("LARES_TELEGRAM_CLAIM_REVISION", "5c1ac4e0-0000-4000-8000-000000000002");
  fake.definition = parseDefinition(JSON.parse(readFileSync(new URL("../agent.json", import.meta.url), "utf8")));
  // No permissions-board row: each capability's level is the definition's own.
  setBoardDeps({ explicitLevel: async () => null, record: async () => {}, now: () => Date.now() });
  // The exact-card adapters read the card's target and policy from the database, Keeper or the
  // mailbox binding. Those reads are fixed here; WHICH tools have an adapter is what is under test.
  const hash = (letter: string) => letter.repeat(64);
  vi.spyOn(calendarApprovalAdapter, "readTarget").mockImplementation(async (_db, _input, memberId, tool) =>
    ({ kind: "calendar-event", id: `calendar:example:${tool}`, ownerMemberId: memberId, fingerprint: hash("a") }));
  vi.spyOn(calendarApprovalAdapter, "readPolicyHash").mockResolvedValue(hash("b"));
  realNoteReadTarget = vaultNoteApprovalAdapter.readTarget.bind(vaultNoteApprovalAdapter);
  vi.spyOn(vaultNoteApprovalAdapter, "readTarget").mockImplementation(async (_db, _input, memberId) =>
    ({ kind: "vault-note", id: "notes/example.md", ownerMemberId: memberId, fingerprint: hash("c") }));
  vi.spyOn(vaultNoteApprovalAdapter, "readPolicyHash").mockResolvedValue(hash("d"));
  vi.spyOn(tracksApprovalAdapter, "readTarget").mockImplementation(async (_db, _input, memberId) =>
    ({ kind: "track", id: "tracks/example-track/track.md", ownerMemberId: memberId, fingerprint: hash("e") }));
  vi.spyOn(tracksApprovalAdapter, "readPolicyHash").mockResolvedValue(hash("f"));
  vi.spyOn(deadlineApprovalAdapter, "readTarget").mockImplementation(async (_db, _input, memberId) =>
    ({ kind: "deadline", id: "deadline-example", ownerMemberId: memberId, fingerprint: hash("0") }));
  vi.spyOn(deadlineApprovalAdapter, "readPolicyHash").mockResolvedValue(hash("1"));
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

  // A tool added to the catalogue needs a row, and so a decision for the shared room, before this is green.
  it("has a row for every catalogue tool, or a stated reason no door shows it", () => {
    const tableRows = TABLE.map((row) => row[0]);
    expect(Object.keys(CATALOGUE).filter((tool) => !tableRows.includes(tool) && !(tool in NOT_GRANTED))).toEqual([]);
    expect(Object.keys(NOT_GRANTED).filter((tool) => tableRows.includes(tool) || !(tool in CATALOGUE))).toEqual([]);
  });

  it("the shared room column is the room rule: what the rule lists behaves as in a direct message, everything else is hidden", () => {
    for (const row of TABLE) expect(row[column("slackRoom")], row[0]).toBe(sharedRoomAllows(row[0]) ? row[column("slackDm")] : H);
    for (const row of OWN_RESOLVER) {
      const name = row[0].replace(/^skill /, "");
      expect(row[column("slackRoom")], row[0]).toBe(sharedRoomAllows(name) ? row[column("slackDm")] : H);
    }
  });

  it("no tool shown in a shared room can raise an approval card", () => {
    expect(TABLE.filter((row) => row[column("slackRoom")] === C || row[column("slackRoom")] === X).map((row) => row[0])).toEqual([]);
    const shownInRoom = [...TABLE.filter((row) => row[column("slackRoom")] !== H).map((row) => row[0]),
      ...Object.keys(NOT_GRANTED).filter((tool) => sharedRoomAllows(tool))];
    for (const tool of shownInRoom) expect((CATALOGUE[tool]!.tool as { approval?: unknown }).approval, tool).toBeUndefined();
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

  // The hand-made room message above is still used by the test before this one; `roomOwner`
  // further down is a separate hand-written identity this test does not cover. This holds it to what eve builds: in every field the room rule, the
  // approvals and the model-authority check read, the two identities are the same.
  it("Slack · owner · mention in a shared channel: the hand-made identity matches the one eve builds", async () => {
    const handMade = (await knockOnSlack(slackMessage({ user: SLACK_OWNER, room: true })))!;
    const built = await frameworkMentionAuth("C0SHAREDROOM", { keepModules: true, user: SLACK_OWNER });
    expect(built.authenticator).toBe(handMade.authenticator);
    expect((handMade as { principalType?: unknown }).principalType).toBe(built.principalType);
    for (const field of ["user_id", "channel_id", "author_type"]) expect(built.attributes[field], field).toBe(handMade.attributes[field]);
    expect(startedIn({ session: { auth: { initiator: built, current: built } } })).toBe("shared-room");
    expect(startedIn({ session: { auth: { initiator: handMade, current: handMade } } })).toBe("shared-room");
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
      const rule = (row: Row) => key !== "slackRoom" ? (key !== "webOwner" && key !== "webMember" && DOOR_HIDDEN_NOTE_TOOLS.includes(row[0]) ? DOOR_NOTE_TOOL_UNAVAILABLE : CONSOLE_AUTHORITY_REFUSED)
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

  // Read from disk: a tool, skill or connection file added under agent/ is asked here without any
  // edit to this test, and fails it if it offers a shared room anything the room rule does not list.
  it("Slack · owner · mention in a shared channel: every own-resolver tool, skill and connection file offers only what the room rule lists", async () => {
    const room = (await observe("slackRoom")).session;
    const direct = (await observe("slackDm")).session;
    const files = ownResolverFiles(new URL("../agent/", import.meta.url));
    expect(files.map((file) => `${file.kind}/${file.name}`)).toEqual(expect.arrayContaining(
      ["tools/commercial_who_to_contact", "tools/public_doc", "tools/outside-tools", "skills/lares-docs", "skills/sales-outreach", "skills/signals", "connections/outside-tools"]));
    const inDirect = new Set<string>();
    for (const file of files) {
      expect((await offeredBy(file, room)).filter((name) => !sharedRoomAllows(name)), `${file.kind}/${file.name}`).toEqual([]);
      for (const name of await offeredBy(file, direct)) inDirect.add(name);
    }
    // Not an empty check: the same files offer a direct message names the room rule does not list.
    expect([...inDirect].filter((name) => !sharedRoomAllows(name))).toEqual(expect.arrayContaining(["commercial_who_to_contact", "sales-outreach", "signals"]));
  });
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

  it("Slack · owner · mention in a shared channel: a call of commercial_who_to_contact is refused before the CRM is read", async () => {
    const native = (await started(commercialResolver, (await observe("slackDm")).session)) as { execute(input: unknown, ctx: unknown): Promise<unknown> };
    await expect(native.execute({}, (await observe("slackRoom")).session)).rejects.toThrow(SHARED_ROOM_REFUSED);
  });

  it("Slack · owner · mention in a shared channel: offers the public help skill only; the others are absent", async () => {
    const { session } = await observe("slackRoom");
    expect(JSON.stringify(await started(laresDocsSkill, session))).toContain("Public Lares documentation");
    expect(await started(signalsSkill, session)).toBeNull();
    expect(await started(salesOutreachSkill, session)).toBeNull();
  });

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
  for (const key of ["slackDm", "telegram"] as const) {
    it(`${door(key).title}: offers the agent's own skills and their text`, async () => {
      const { session } = await observe(key);
      expect(JSON.stringify(await started(signalsSkill, session))).toContain("# Signals");
      expect(await started(salesOutreachSkill, session)).not.toBeNull();
      expect(await started(laresDocsSkill, session)).not.toBeNull();
    });
  }
});

// ─── People the doors do not admit ────────────────────────────────────────────────────────────

describe("web chat notes go to keeper", () => {
  afterEach(() => { keeper.on = false; keeper.calls = []; });
  it("Web chat · owner: a search and a listing page are keeper requests with the turn's own coordinates and only the inputs the tool takes", async () => {
    const { session } = await observe("webOwner");
    const tools = await resolveCatalogue(session) as unknown as Record<string, { execute(input: unknown, ctx: unknown): Promise<unknown> }>;
    keeper.on = true;
    expect(await tools["agent-kit__vault_search"]!.execute({ area: "private", q: "vera" }, session)).toEqual({ ok: true, hits: ["people/vera.md"], files: 2000 });
    expect(await tools["agent-kit__vault_list"]!.execute({ area: "shared", folder: "people", cursor: 200 }, session)).toMatchObject({ notes: ["people/vera.md"], nextCursor: 200 });
    await tools["agent-kit__vault_list"]!.execute({ area: "private" }, session);
    const turn = { turnCapability: "turn-capability", turnId: "turn-1", sequence: 0, sessionId: session.session.id, memberId: WEB_OWNER, admissionNonce: NONCE };
    expect(keeper.calls).toEqual([
      { op: "vault.read", input: { ...turn, area: "private", operation: "search", q: "vera" } },
      { op: "vault.read", input: { ...turn, area: "shared", operation: "list", folder: "people", cursor: 200 } },
      { op: "vault.read", input: { ...turn, area: "private", operation: "list" } },
    ]);
    await expect(tools["agent-kit__vault_search"]!.execute({ area: "taste", q: "vera" }, session)).rejects.toThrow("Vault access refused");
    expect(keeper.calls).toHaveLength(3);
  });
});

describe("door notes go to keeper through the door pass", () => {
  beforeEach(() => { keeper.realPass = true; });
  afterEach(() => { keeper.writeError = undefined; keeper.realPass = false; keeper.on = false; keeper.refuseDoorPass = false; keeper.passUnreachable = false; keeper.inbox = []; keeper.calls = []; fake.asks.clear(); });
  for (const key of ["slackDm", "telegram"] as const) {
    it(`${door(key).title}: a list, a read and a search are keeper requests with the pass and the claim, and no member`, async () => {
      const { session } = await observe(key);
      const tools = await resolveCatalogue(session) as unknown as Record<string, { execute(input: unknown, ctx: unknown): Promise<unknown> }>;
      keeper.on = true;
      expect(await tools["agent-kit__vault_search"]!.execute({ area: "private", q: "vera" }, session)).toEqual({ ok: true, hits: ["people/vera.md"], files: 2000 });
      await tools["agent-kit__vault_list"]!.execute({ area: "private", folder: "people" }, session);
      await tools["agent-kit__vault_read"]!.execute({ area: "private", path: "people/vera.md" }, session);
      const opens = keeper.calls.filter((call) => call.op === "door.turn.open");
      expect(opens).toHaveLength(1);
      expect(opens[0]!.input).toMatchObject({ chat: "private", sessionId: session.session.id, turnId: "turn-1", sequence: 0 });
      expect(Object.keys(opens[0]!.input)).not.toContain("memberId");
      const reads = keeper.calls.filter((call) => call.op === "vault.read");
      expect(reads.map((call) => call.input.operation)).toEqual(["search", "list", "read"]);
      for (const call of reads) {
        expect(call.input).toMatchObject({ turnCapability: "d".repeat(43), door: key === "slackDm" ? "slack" : "telegram", area: "private" });
        expect(Object.keys(call.input)).not.toContain("memberId");
        expect(Object.keys(call.input)).not.toContain("admissionNonce");
      }
    });

    it(`${door(key).title}: when keeper refuses the pass, a read says so in the one sentence and the local folder is never tried`, async () => {
      const { session } = await observe(key);
      const tools = await resolveCatalogue(session) as unknown as Record<string, { execute(input: unknown, ctx: unknown): Promise<unknown> }>;
      clearSessionVaultTurnCapabilities(session.session.id, INCARNATION);
      keeper.on = true; keeper.refuseDoorPass = true;
      for (const name of ["agent-kit__vault_list", "agent-kit__vault_read", "agent-kit__vault_search"]) {
        await expect(tools[name]!.execute({ area: "private", path: "a.md", q: "x" }, session)).rejects.toThrow(DOOR_NOTE_READ_FAILED);
      }
    });

    // The note-save steps, with Keeper stood in for and the card table a fake: the full lifecycle against a database
    // is tests/door-exact-approval.test.ts (kit) and tests/vault-console-broker.test.ts (Keeper).
    const withRealTarget = async <T>(run: () => Promise<T>): Promise<T> => {
      const spy = vi.mocked(vaultNoteApprovalAdapter.readTarget), saved = spy.getMockImplementation();
      spy.mockImplementation(realNoteReadTarget);
      try { return await run(); } finally { spy.mockImplementation(saved!); }
    };
    const SAVE = { area: "private", title: "Oslo trip", body: "Flights on Friday" };
    const saveAttempt = async (session: Session) => {
      const emitted = (await resolveCatalogue(session))["agent-kit__vault_write"];
      const ctx = { ...session, toolName: "agent-kit__vault_write", toolInput: SAVE, callId: `save-${++callNumber}` };
      return { ctx, decision: await emitted!.approval!.request(ctx) };
    };

    it(`${door(key).title}: a save asks Keeper's pass first, checks the title is free, reserves the card for the member Keeper named and then raises it`, async () => {
      const { session } = await observe(key);
      keeper.on = true; keeper.inbox = ["_inbox/other-note.md"];
      const { ctx, decision } = await withRealTarget(() => saveAttempt(session));
      expect(decision).toBe("user-approval");
      expect(keeper.calls.map((call) => call.op)).toEqual(["door.turn.open", "vault.read"]);
      expect(keeper.calls[1]!.input).toMatchObject({ operation: "list", folder: "_inbox", area: "private", door: key === "slackDm" ? "slack" : "telegram" });
      for (const call of keeper.calls) { expect(Object.keys(call.input)).not.toContain("memberId"); expect(Object.keys(call.input)).not.toContain("admissionNonce"); }
      const reserved = fake.asks.get(ctx.callId) as { acting_member_id: string; original_authority: Record<string, any>; request_id: null } | undefined;
      expect(reserved?.acting_member_id).toBe("member-owner");
      expect(reserved?.request_id).toBeNull();
      expect(reserved?.original_authority).toMatchObject({ version: 2, kind: "door", door: { door: key === "slackDm" ? "slack" : "telegram" },
        target: { kind: "vault-note", id: "_inbox/oslo-trip.md", ownerMemberId: "member-owner" }, original: { origin: "human", actingMemberId: "member-owner" } });
      // The guard before the tool runs finds no answer yet.
      const { guardCatalogueExecution } = await import("../lib/approvals.js");
      await expect(guardCatalogueExecution(ctx, "agent-kit__vault_write", SAVE)).rejects.toThrow(DOOR_NOTE_TOOL_UNAVAILABLE);
    });

    it(`${door(key).title}: a save is refused before any card, in one closed sentence, when Keeper refuses the pass, cannot be reached, or the title is taken`, async () => {
      const { session } = await observe(key);
      keeper.on = true;
      clearSessionVaultTurnCapabilities(session.session.id, INCARNATION);
      keeper.refuseDoorPass = true;
      let { decision } = await withRealTarget(() => saveAttempt(session));
      expect(decision).toEqual({ type: "denied", reason: DOOR_NOTE_SAVE_NOT_POSSIBLE });
      keeper.refuseDoorPass = false; keeper.passUnreachable = true; clearSessionVaultTurnCapabilities(session.session.id, INCARNATION);
      ({ decision } = await withRealTarget(() => saveAttempt(session)));
      expect(decision).toEqual({ type: "denied", reason: DOOR_NOTE_UNREACHABLE });
      keeper.passUnreachable = false; keeper.inbox = ["_inbox/oslo-trip.md"]; clearSessionVaultTurnCapabilities(session.session.id, INCARNATION);
      ({ decision } = await withRealTarget(() => saveAttempt(session)));
      expect(decision).toEqual({ type: "denied", reason: DOOR_NOTE_TITLE_TAKEN });
      for (const sentence of [DOOR_NOTE_SAVE_NOT_POSSIBLE, DOOR_NOTE_UNREACHABLE, DOOR_NOTE_TITLE_TAKEN]) expect(DOOR_VAULT_SENTENCES.has(sentence)).toBe(true);
      expect([...fake.asks.keys()]).toEqual([]);
    });

    it(`${door(key).title}: the whole way: reserve, card, an answer only from the owner, the re-check, and a write through Keeper that names the door claim and no member`, async () => {
      const { session } = await observe(key);
      keeper.on = true;
      const { catalogueApprovalRequest, catalogueApprovalResponse } = await import("../lib/approvals.js");
      const { attachDoorExactApproval } = await import("@lares/agent-kit/door-exact-approval");
      const { ctx, decision } = await withRealTarget(() => saveAttempt(session));
      expect(decision).toBe("user-approval");
      const row = fake.asks.get(ctx.callId)!;
      expect(await attachDoorExactApproval({ requestId: "req-1", callId: ctx.callId, tool: "agent-kit__vault_write", input: SAVE }, fake.pool as never)).toBe(true);
      const owner = session.session.auth.current as { attributes: Record<string, unknown> };
      const tap = (principal: unknown, decisionName = "approve") => ({ request: { interactionId: "req-1", callId: ctx.callId, toolName: "agent-kit__vault_write", toolInput: SAVE },
        response: { decision: decisionName, principal }, session: { id: session.session.id, initiator: session.session.auth.initiator, turn: { id: "turn-1" } } });
      // Someone else, and the owner on the other door, cannot answer; the card stays unanswered.
      const stranger = { ...owner, attributes: { ...owner.attributes, user_id: key === "slackDm" ? SLACK_STRANGER : TELEGRAM_STRANGER } };
      expect(await catalogueApprovalResponse("agent-kit__vault_write", tap(stranger))).toMatchObject({ status: "rejected" });
      const otherDoor = (await observe(key === "slackDm" ? "telegram" : "slackDm")).session.session.auth.current;
      expect(await catalogueApprovalResponse("agent-kit__vault_write", tap(otherDoor))).toMatchObject({ status: "rejected" });
      expect(row.outcome).toBeNull();
      expect(await catalogueApprovalResponse("agent-kit__vault_write", tap(owner))).toEqual({ status: "allowed" });
      expect(row).toMatchObject({ outcome: "approved", answered_via: key === "slackDm" ? "slack" : "telegram", resolved_by_member_id: "member-owner" });
      // The card's record cannot say it was shown in full: the approval is not acted on, and the sentence does not say it was cut.
      const authored = (CATALOGUE["agent-kit__vault_write"]!.tool as { approval: unknown }).approval;
      const recheck = { ...ctx, [Symbol.for("eve.approval-evaluation")]: { recheck: true } };
      expect(await catalogueApprovalRequest("agent-kit__vault_write", recheck, authored)).toEqual({ type: "denied", reason: DOOR_NOTE_CARD_UNCONFIRMED });
      row.shown_whole = false;
      expect(await catalogueApprovalRequest("agent-kit__vault_write", recheck, authored)).toEqual({ type: "denied", reason: DOOR_NOTE_CARD_SHORTENED });
      row.shown_whole = true;
      expect(await catalogueApprovalRequest("agent-kit__vault_write", recheck, authored)).toBe("user-approval");
      const tools = await resolveCatalogue(session) as unknown as Record<string, { execute(input: unknown, ctx: unknown): Promise<unknown> }>;
      const running = { ...ctx, approval: { responder: owner } };
      keeper.calls = [];
      expect(await tools["agent-kit__vault_write"]!.execute(SAVE, running)).toMatchObject({ path: "_inbox/oslo-trip.md" });
      const write = keeper.calls.find((call) => call.op === "vault.write")!;
      expect(Object.keys(write.input).sort()).toEqual(["approval", "claimRevision", "door", "input", "principal", "sessionId"]);
      expect(write.input).toMatchObject({ door: key === "slackDm" ? "slack" : "telegram", sessionId: session.session.id });
      expect(write.input.input).toEqual(SAVE);
      // After the person approved, a refusal from Keeper reaches the model as one sentence from the list: the card ran out or was used, or it could not be completed.
      keeper.writeError = new VaultBrokerError("Vault reader unavailable (the keeper refused: replay)", "refused", "replay");
      await expect(tools["agent-kit__vault_write"]!.execute(SAVE, running)).rejects.toThrow(DOOR_NOTE_APPROVAL_EXPIRED);
      keeper.writeError = new Error("/srv/secret/path: EACCES");
      await expect(tools["agent-kit__vault_write"]!.execute(SAVE, running)).rejects.toThrow(DOOR_NOTE_SAVE_FAILED);
      keeper.writeError = new VaultBrokerError("Vault reader unavailable (the connection to the keeper failed)", "connection");
      await expect(tools["agent-kit__vault_write"]!.execute(SAVE, running)).rejects.toThrow(DOOR_NOTE_SAVE_FAILED);
      // A call the card was not raised for, or one with no answerer, never reaches Keeper.
      keeper.calls = [];
      await expect(tools["agent-kit__vault_write"]!.execute({ ...SAVE, body: "Changed" }, running)).rejects.toThrow(DOOR_NOTE_TOOL_UNAVAILABLE);
      await expect(tools["agent-kit__vault_write"]!.execute(SAVE, ctx)).rejects.toThrow(DOOR_NOTE_TOOL_UNAVAILABLE);
      expect(keeper.calls).toEqual([]);
    });

    it(`${door(key).title}: a save that reached execution with no approved card is refused with the one sentence and never touches the local folder`, async () => {
      const { session } = await observe(key);
      const tools = await resolveCatalogue(session) as unknown as Record<string, { execute(input: unknown, ctx: unknown): Promise<unknown> }>;
      await expect(tools["agent-kit__vault_write"]!.execute({ area: "private", title: "Oslo", body: "Trip" }, session)).rejects.toThrow(DOOR_NOTE_TOOL_UNAVAILABLE);
    });
  }

  it("Slack · owner · mention in a shared channel: no note tool is shown, none is called, and no pass is asked for", async () => {
    const { session, shown } = await observe("slackRoom");
    keeper.on = true;
    expect(shown.filter((tool) => tool.startsWith("agent-kit__vault_"))).toEqual([]);
    for (const tool of ["agent-kit__vault_list", "agent-kit__vault_read", "agent-kit__vault_search", "agent-kit__vault_write", "agent-kit__vault_backlinks"]) {
      expect((await attempt(session, tool, undefined)).call, tool).toBe("refused");
    }
    expect(keeper.calls).toEqual([]);
  });

  it("Slack · unknown person · direct message: no note read is shown or allowed", async () => {
    const stranger = sessionWith("matrix-stranger-notes", { authenticator: "slack-webhook", principalType: "user", attributes: { user_id: SLACK_STRANGER, channel_id: "D0OTHER", author_type: "user" } });
    expect(Object.keys(await resolveCatalogue(stranger))).not.toContain("agent-kit__vault_list");
    expect((await attempt(stranger, "agent-kit__vault_list", undefined)).call).toBe("refused");
  });
});

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
    // Not the claimed person: the owner's list, less the two note reads that need Keeper's pass for the claimed person.
    expect(Object.keys(await resolveCatalogue(stranger)).sort()).toEqual((await observe("slackDm")).shown.filter((tool) => !["agent-kit__vault_read", "agent-kit__vault_list"].includes(tool)));
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
    // Not a door and not the claimed person: no Keeper pass for notes; the three note tools with no door road are still offered here.
    expect(Object.keys(tools).sort()).toEqual([...(await observe("slackDm")).shown.filter((tool) => !["agent-kit__vault_read", "agent-kit__vault_list"].includes(tool)), ...DOOR_HIDDEN_NOTE_TOOLS].sort());
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

  // The rule, as the difference it makes: the room sees the direct-message list less everything the room
  // rule does not list, and a call of one of those is refused; every other call goes as it does in a DM.
  it("Slack · owner · mention in a shared channel: sees and may call what a direct message does, less everything the room rule does not list", async () => {
    const room = await observe("slackRoom");
    const direct = await observe("slackDm");
    expect(direct.shown).toEqual(expect.arrayContaining([...SHARED_ROOM_HIDDEN]));
    expect(room.shown).toEqual(direct.shown.filter((tool) => !SHARED_ROOM_HIDDEN.includes(tool)));
    for (const tool of SHARED_ROOM_HIDDEN) expect(room.reasons[tool], tool).toBe(SHARED_ROOM_REFUSED);
    const others = (calls: Record<string, Call>) => Object.fromEntries(Object.entries(calls).filter(([tool]) => !SHARED_ROOM_HIDDEN.includes(tool)));
    expect(others(room.calls)).toEqual(others(direct.calls));
  });

  it("the shared room hides exactly the DM tools the room rule does not list", () => {
    const dm = TABLE.filter((row) => row[column("slackDm")] !== H).map((row) => row[0]);
    expect(dm.filter((tool) => !sharedRoomAllows(tool)).sort()).toEqual([...SHARED_ROOM_HIDDEN].sort());
    // What the owner chose to keep in a room: public material, the language, and read-only looks.
    expect(dm.filter((tool) => sharedRoomAllows(tool)).sort()).toEqual(["deadline_list", "remind_list", "set_language",
      "twenty_company_for_person", "twenty_get_person", "twenty_lookup"]);
  });

  // The writes that ran with no card in a room, and every card tool: hidden and refused before any card.
  it("Slack · owner · mention in a shared channel: remembering, notes, deadlines and every card tool are hidden and refused", async () => {
    const room = await observe("slackRoom");
    for (const tool of ["remember", "save_note", "deadline_add", "deadline_reset", "facts_list", "memory_used", "gmail_send",
      "gmail_signature", "identity_my_addresses", "voice_guide", "digest_run", "agent-kit__signals_recent", "remind_set", "forget"]) {
      expect(room.shown, tool).not.toContain(tool);
      expect(room.reasons[tool], tool).toBe(SHARED_ROOM_REFUSED);
    }
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

  // Fixed: the claimed person in a private chat on a door Keeper manages is shown the note read and list tools, and they go through Keeper's pass.
  for (const key of ["slackDm", "telegram"] as const) {
    it(`${door(key).title}: sees the note read and list tools that the baseline and its own instructions name`, async () => {
      const { shown } = await observe(key);
      expect(shown).toEqual(expect.arrayContaining(["agent-kit__vault_read", "agent-kit__vault_list"]));
    });
  }

  it("Slack · owner · direct message: its instructions name the note read and list tools it is shown", async () => {
    const persona = readFileSync(new URL("../agent/persona.md", import.meta.url), "utf8");
    const { shown } = await observe("slackDm");
    for (const tool of ["agent-kit__vault_read", "agent-kit__vault_list"]) {
      expect(persona).toContain(`\`${tool}\``);
      expect(baseline()).toContain(tool);
      expect(shown).toContain(tool);
    }
  });
});
