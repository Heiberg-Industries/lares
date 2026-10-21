// The tool pool. Each entry names the capability whose grant decides whether a session gets the tool.
//
// It is a real module and not a glob on purpose: `eve build` bundles what it can see statically,
// and a directory read at runtime would resolve against .output/server/, not this folder.
// `tests/catalogue-index.test.ts` is what keeps it honest: it holds this map against the files
// on disk in both directions, and every capability against `capabilityOfTool`.
//
// ONE THING IS DELIBERATELY NOT HERE, and one thing IS here for a reason worth stating.
//
// `commercial_who_to_contact` stays in `agent/tools/`. It is gated by the "commercial" SKILL
// declaration (`resolveSkillTool`), not by a capability grant. `grantedToolNames` below only ever asks a capability's
// grant whether a tool is present; it has no notion of a skill declaration. Moving this tool into
// the pool would silently swap what gates it (present whenever `twenty` is granted,
// even with the "commercial" skill undeclared) rather than genuinely widening what a catalogue
// entry can express. `tests/catalogue-index.test.ts` does not expect to find it here, and
// `tests/tool-harness.test.ts`'s AUTHORED map still imports it from `agent/tools/`.
//
// The `agent-kit__*` contributions are real catalogue entries, following the "supersede the mount,
// don't duplicate it" pattern: each `agent/extensions/agent-kit/tools/*.ts` override file for one of
// them is an unconditional `disableTool` sentinel, because a resolver-emitted tool under the SAME
// prefixed key replaces an authored/mounted tool of that name completely. THREE of them
// (`agent-kit__vault_write`, `agent-kit__vault_file`, `agent-kit__vault_drop`) carry an approval
// and write to the owner's vault; the resolver in `agent/tools/catalogue.ts` copies a catalogue
// entry's `.approval` across unconditionally, so the card survives, and
// `packages/agent-kit/src/write-shape-lint.ts`'s `sourcesForTool` inspects these three in the
// catalogue so they stay covered by the ungated-write lint rather than going blind on the
// disabled mount files.
import type { Catalogue } from "@lares/agent-kit/catalogue";
import { ALWAYS_PRESENT_CAPABILITY } from "@lares/agent-kit/catalogue";

import agent_kit__vault_drop from "./agent-kit__vault_drop.js";
import agent_kit__vault_file from "./agent-kit__vault_file.js";
import agent_kit__vault_write from "./agent-kit__vault_write.js";
import agent_kit__signals_recent from "./agent-kit__signals_recent.js";
import agent_kit__transit_plan from "./agent-kit__transit_plan.js";
import agent_kit__vault_backlinks from "./agent-kit__vault_backlinks.js";
import agent_kit__vault_list from "./agent-kit__vault_list.js";
import agent_kit__vault_read from "./agent-kit__vault_read.js";
import agent_kit__vault_search from "./agent-kit__vault_search.js";
import atlas_proposals from "./atlas_proposals.js";
import atlas_resolve_proposal from "./atlas_resolve_proposal.js";
import calendar_conflicts from "./calendar_conflicts.js";
import calendar_create_event from "./calendar_create_event.js";
import calendar_delete_event from "./calendar_delete_event.js";
import calendar_free_busy from "./calendar_free_busy.js";
import calendar_list_calendars from "./calendar_list_calendars.js";
import calendar_list_events from "./calendar_list_events.js";
import calendar_update_event from "./calendar_update_event.js";
import deadline_add from "./deadline_add.js";
import deadline_dismiss from "./deadline_dismiss.js";
import deadline_done from "./deadline_done.js";
import deadline_list from "./deadline_list.js";
import deadline_mint_statutory from "./deadline_mint_statutory.js";
import deadline_reset from "./deadline_reset.js";
import digest_run from "./digest_run.js";
import echo_note from "./echo_note.js";
import facts_list from "./facts_list.js";
import forget from "./forget.js";
import gmail_accounts from "./gmail_accounts.js";
import gmail_draft from "./gmail_draft.js";
import gmail_draft_recipients from "./gmail_draft_recipients.js";
import gmail_read from "./gmail_read.js";
import gmail_search from "./gmail_search.js";
import gmail_send from "./gmail_send.js";
import gmail_signature from "./gmail_signature.js";
import identity_my_addresses from "./identity_my_addresses.js";
import meeting_followup_auto from "./meeting_followup_auto.js";
import meeting_followup_record_denial from "./meeting_followup_record_denial.js";
import meeting_followup_redraft from "./meeting_followup_redraft.js";
import meeting_followup_send from "./meeting_followup_send.js";
import memory_proposals from "./memory_proposals.js";
import memory_resolve_proposal from "./memory_resolve_proposal.js";
import memory_used from "./memory_used.js";
import notion_proposals from "./notion_proposals.js";
import notion_resolve_proposal from "./notion_resolve_proposal.js";
import obligation_dismiss from "./obligation_dismiss.js";
import outreach_track from "./outreach_track.js";
import person_lookup from "./person_lookup.js";
import read_url from "./read_url.js";
import remember from "./remember.js";
import remind_cancel from "./remind_cancel.js";
import remind_list from "./remind_list.js";
import remind_set from "./remind_set.js";
import save_note from "./save_note.js";
import set_language from "./set_language.js";
import twenty_comm_state from "./twenty_comm_state.js";
import twenty_company_for_person from "./twenty_company_for_person.js";
import twenty_create_opportunity from "./twenty_create_opportunity.js";
import twenty_do_not_contact from "./twenty_do_not_contact.js";
import twenty_get_person from "./twenty_get_person.js";
import twenty_lookup from "./twenty_lookup.js";
import twenty_note from "./twenty_note.js";
import twenty_set_stage from "./twenty_set_stage.js";
import voice_guide from "./voice_guide.js";

export const CATALOGUE: Catalogue = {
  // THE THREE WRITE TOOLS. Each takes the required `area` and an injected authority, and is
  // narrowed to the private area alone, because that is the only store they write (see
  // `agent-kit__vault_write.ts`). Their capability is `vault`; the area
  // each of them is offered under is `private`, from the engine's own table (`areaOfTool`), so
  // a declaration that grants `vault` without the private area is offered none of them.
  "agent-kit__vault_drop": { capability: "vault", tool: agent_kit__vault_drop },
  "agent-kit__vault_file": { capability: "vault", tool: agent_kit__vault_file },
  "agent-kit__vault_write": { capability: "vault", tool: agent_kit__vault_write },
  "agent-kit__signals_recent": { capability: "signals", tool: agent_kit__signals_recent },
  "agent-kit__transit_plan": { capability: "transit", tool: agent_kit__transit_plan },
  // ONE SET OF NOTE TOOLS FOR EVERY AREA. The area is an input, and each tool refuses an area
  // this agent's definition does not grant. The capability is `vault`, which is also what the
  // grant that decides them names: the two must change together, because either half alone
  // empties every session's note tools.
  "agent-kit__vault_backlinks": { capability: "vault", tool: agent_kit__vault_backlinks },
  "agent-kit__vault_list": { capability: "vault", tool: agent_kit__vault_list },
  "agent-kit__vault_read": { capability: "vault", tool: agent_kit__vault_read },
  "agent-kit__vault_search": { capability: "vault", tool: agent_kit__vault_search },
  atlas_proposals: { capability: "vault", tool: atlas_proposals },
  atlas_resolve_proposal: { capability: "vault", tool: atlas_resolve_proposal },
  calendar_conflicts: { capability: "calendar", tool: calendar_conflicts },
  calendar_create_event: { capability: "calendar", tool: calendar_create_event },
  calendar_delete_event: { capability: "calendar", tool: calendar_delete_event },
  calendar_free_busy: { capability: "calendar", tool: calendar_free_busy },
  calendar_list_calendars: { capability: "calendar", tool: calendar_list_calendars },
  calendar_list_events: { capability: "calendar", tool: calendar_list_events },
  calendar_update_event: { capability: "calendar", tool: calendar_update_event },
  deadline_add: { capability: "deadline", tool: deadline_add },
  deadline_dismiss: { capability: "deadline", tool: deadline_dismiss },
  deadline_done: { capability: "deadline", tool: deadline_done },
  deadline_list: { capability: "deadline", tool: deadline_list },
  deadline_mint_statutory: { capability: "deadline", tool: deadline_mint_statutory },
  deadline_reset: { capability: "deadline", tool: deadline_reset },
  digest_run: { capability: "digest", tool: digest_run },
  echo_note: { capability: "echo", tool: echo_note },
  facts_list: { capability: "vault", tool: facts_list },
  forget: { capability: "vault", tool: forget },
  gmail_accounts: { capability: "gmail", tool: gmail_accounts },
  gmail_draft: { capability: "gmail", tool: gmail_draft },
  gmail_draft_recipients: { capability: "gmail", tool: gmail_draft_recipients },
  gmail_read: { capability: "gmail", tool: gmail_read },
  gmail_search: { capability: "gmail", tool: gmail_search },
  gmail_send: { capability: "gmail", tool: gmail_send },
  gmail_signature: { capability: "gmail", tool: gmail_signature },
  identity_my_addresses: { capability: "identity", tool: identity_my_addresses },
  meeting_followup_auto: { capability: "autonomy", tool: meeting_followup_auto },
  meeting_followup_record_denial: { capability: "gmail", tool: meeting_followup_record_denial },
  meeting_followup_redraft: { capability: "gmail", tool: meeting_followup_redraft },
  meeting_followup_send: { capability: "gmail", tool: meeting_followup_send },
  memory_proposals: { capability: "vault", tool: memory_proposals },
  memory_resolve_proposal: { capability: "vault", tool: memory_resolve_proposal },
  memory_used: { capability: "vault", tool: memory_used },
  notion_proposals: { capability: "notion", tool: notion_proposals },
  notion_resolve_proposal: { capability: "notion", tool: notion_resolve_proposal },
  obligation_dismiss: { capability: "obligation", tool: obligation_dismiss },
  outreach_track: { capability: "outreach", tool: outreach_track },
  person_lookup: { capability: "person", tool: person_lookup },
  // `asksWithoutWriting`: this tool has an approval gate (it asks before opening a link
  // in a turn that has already read somebody else's words) but it still only fetches and returns
  // text. Without the marker the catalogue would read the gate as "write class" and drop the tool
  // from this `read`-scoped grant entirely (the tool-list snapshot catches that).
  read_url: { capability: "read_url", tool: read_url, asksWithoutWriting: true },
  remember: { capability: "vault", tool: remember },
  remind_cancel: { capability: "remind", tool: remind_cancel },
  remind_list: { capability: "remind", tool: remind_list },
  remind_set: { capability: "remind", tool: remind_set },
  save_note: { capability: "vault", tool: save_note },
  set_language: { capability: ALWAYS_PRESENT_CAPABILITY, tool: set_language },
  twenty_comm_state: { capability: "twenty", tool: twenty_comm_state },
  twenty_company_for_person: { capability: "twenty", tool: twenty_company_for_person },
  twenty_create_opportunity: { capability: "twenty", tool: twenty_create_opportunity },
  twenty_do_not_contact: { capability: "twenty", tool: twenty_do_not_contact },
  twenty_get_person: { capability: "twenty", tool: twenty_get_person },
  twenty_lookup: { capability: "twenty", tool: twenty_lookup },
  twenty_note: { capability: "twenty", tool: twenty_note },
  twenty_set_stage: { capability: "twenty", tool: twenty_set_stage },
  voice_guide: { capability: "voice", tool: voice_guide },
};
