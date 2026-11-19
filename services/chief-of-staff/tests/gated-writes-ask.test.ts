// A write the agent is set to ask about must raise an approval card, for EVERY such tool.
//
// The tool list is read from the catalogue folder, not typed here, so a tool added tomorrow is
// covered the day it lands. A tool that carries an approval check must ask when the agent's
// definition says "gated" and the permissions board has no row of its own. A tool with no
// approval check at all must be named in UNGATED below, which makes adding a write tool without
// a gate a conscious, reviewed decision instead of an accident.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setBoardDeps } from "@lares/agent-kit/board-approval";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../lib/definition.js", async (original) => ({
  ...(await original<typeof import("../lib/definition.js")>()),
  // Every capability is gated, whatever its name.
  thisAgent: async () => ({ loaded: { definition: { autonomy: new Proxy({}, { get: () => "gated" }) } } }),
}));

const dir = join(dirname(fileURLToPath(import.meta.url)), "../catalogue");
const tools = readdirSync(dir).filter((f) => f.endsWith(".ts") && f !== "index.ts").map((f) => f.slice(0, -3)).sort();
const source = (t: string) => readFileSync(join(dir, `${t}.ts`), "utf8");

// Tools that ask by a rule of their own (an exact-action card, the turn's taint, a series check).
// Each has its own tests; they do not read the definition's level.
const OWN_POLICY = new Set(["meeting_followup_send", "meeting_followup_redraft", "read_url", "personal_mailbox_send"]);

// Tools with no approval check at all: reads, and writes to the agent's own private data.
// A new tool that is not here and has no approval check fails this test.
const UNGATED = new Set([
  "agent-kit__signals_recent", "agent-kit__transit_plan", "agent-kit__vault_backlinks", "agent-kit__vault_list",
  "agent-kit__vault_read", "agent-kit__vault_search", "atlas_proposals", "calendar_free_busy", "calendar_list_calendars",
  "calendar_list_events", "deadline_add", "deadline_list", "deadline_reset", "digest_run", "facts_list", "gmail_accounts",
  "gmail_read", "gmail_search", "gmail_signature", "identity_my_addresses", "meeting_followup_record_denial",
  "memory_proposals", "memory_used", "notion_proposals", "obligation_dismiss", "outreach_track", "person_lookup",
  "personal_calendar_accounts", "personal_calendar_events", "personal_mailbox_accounts", "personal_mailbox_list",
  "personal_mailbox_read", "remember", "remind_list", "save_note", "track_items", "tracks_list",
  "twenty_company_for_person", "twenty_get_person", "twenty_lookup", "voice_guide", "calendar_conflicts", "set_language",
]);

beforeAll(() => setBoardDeps({ explicitLevel: async () => null, record: async () => {}, now: () => Date.now() }));
afterAll(() => setBoardDeps(null));

describe("every gated write asks first", () => {
  const gated = tools.filter((t) => /approval:\s*\S/.test(source(t)) && !/approval:\s*\/\//.test(source(t)) && !UNGATED.has(t));

  it("finds the gated tools from the catalogue folder", () => {
    expect(gated).toContain("gmail_draft");
    expect(gated).toContain("gmail_draft_recipients");
    expect(gated).toContain("calendar_create_event");
    expect(gated.length).toBeGreaterThan(20);
  });

  it("every tool is either gated or named as ungated", () => {
    const unknown = tools.filter((t) => !gated.includes(t) && !UNGATED.has(t));
    expect(unknown).toEqual([]);
  });

  for (const t of tools.filter((n) => !UNGATED.has(n) && !OWN_POLICY.has(n) && /approval:\s*\S/.test(source(n)))) {
    it(`${t} asks when the definition says gated`, async () => {
      const { default: tool } = await import(`../catalogue/${t}.ts`);
      expect(tool.approval, t).toBeTypeOf("function");
      const answer = await tool.approval({ toolInput: { home: "vault:example" }, session: { id: "s1" }, callId: "c1" });
      expect(answer === "user-approval" || (typeof answer === "object" && answer?.type === "denied"), `${t} answered ${JSON.stringify(answer)}`).toBe(true);
    });
  }
});
