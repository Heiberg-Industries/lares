// Every tool that can raise an approval card must show the exact change under the card, or be named
// (with a reason) in CARD_NEEDS_NO_DETAILS. The tool list is read from the catalogue folders, so a
// write tool added tomorrow fails here until someone decides what its card shows.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CARD_NEEDS_NO_DETAILS, approvalCardShape, hasCardDetails } from "@lares/agent-kit/approval-summary";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const folders = [join(here, "../catalogue"), join(here, "../../creative/catalogue")];

// Same reading of "gated" as gated-writes-ask.test.ts: has an approval check, and is not a read.
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

const gated = [...new Set(folders.flatMap((dir) =>
  readdirSync(dir)
    .filter((f) => f.endsWith(".ts") && f !== "index.ts")
    .map((f) => f.slice(0, -3))
    .filter((t) => {
      const src = readFileSync(join(dir, `${t}.ts`), "utf8");
      return /approval:\s*\S/.test(src) && !/approval:\s*\/\//.test(src) && !UNGATED.has(t);
    }),
))].sort();

describe("every gated card shows the exact change", () => {
  it("finds the gated tools", () => {
    expect(gated).toContain("agent-kit__vault_write");
    expect(gated).toContain("vault_write");
    expect(gated.length).toBeGreaterThan(25);
  });

  for (const t of gated) {
    it(`${t} has details under its card, or a reviewed reason not to`, () => {
      expect(hasCardDetails(t) || t in CARD_NEEDS_NO_DETAILS, `${t} shows only a title`).toBe(true);
    });
  }

  it("the reviewed list holds only real gated tools that have no details", () => {
    for (const t of Object.keys(CARD_NEEDS_NO_DETAILS)) {
      expect(gated, `${t} is not a gated tool any more`).toContain(t);
      expect(hasCardDetails(t), `${t} has details, so it should not be on the list`).toBe(false);
    }
  });

  it("a private note card carries the note text, whole", () => {
    const body = `${"line of the note. ".repeat(40)}END-OF-NOTE`;
    const shape = approvalCardShape("agent-kit__vault_write", { area: "private", title: "Plan", body, tags: ["a", "b"] });
    const text = shape.body.map((p) => p.text).join("\n");
    expect(text).toContain("END-OF-NOTE");
    expect(text).toContain("Plan");
    expect(text).toContain("a, b");
  });
});
