// An INSTRUCTION skill: text the model pulls into a conversation with the framework's own loader
// (`eve__skill`, eve 1.0). That loader loads any skill the conversation has and nothing authored
// can stand in front of it, so this file decides whether the skill EXISTS here. Returning `null`
// means it is absent: not listed, not searchable, not loadable.
//
// The function runs before every model call. Two things are decided, in this order:
//
//  1. Is this a private console conversation? Verified again on every run, never kept. A
//     conversation that claims to be private and cannot prove it makes the call below throw,
//     which fails the turn before any model call: nothing is offered to an unverified caller.
//  2. Does the agent's definition allow this skill? Read once per conversation (`ctx.memo`) from
//     the same loaded definition the tool list comes from, and checked by the kit
//     (`instructionSkillOffered`, @lares/agent-kit/manifest), which answers "no" on every path
//     that is not a plain "yes", including a definition that cannot be read or does not validate.
//
// THIS SKILL composes mail, the CRM, the voice guide, the address registry, page reads and
// outreach tracking. It exists only where the definition grants every one of them at the scope
// its tools need (the list is INSTRUCTION_SKILLS in @lares/agent-kit/skill-grants, held against
// this text by tests/skills.test.ts), and never in a private console conversation.
import { defineDynamic, defineSkill } from "eve/skills";
import { manifestViewOf } from "@lares/agent-kit/definition";
import { instructionSkillOffered } from "@lares/agent-kit/manifest";
import { verifyPrivateConsoleSession } from "@lares/agent-kit/private-console-surface";

import { thisAgent } from "../../lib/definition.js";

const description = "Use when the owner asks you to research a company and draft outreach, follow up with a prospect, or otherwise do sales-outreach work.";

const content = "# Sales outreach\n\nThe whole loop is yours: research \u2192 draft \u2192 approval card \u2192 send \u2192 track for a reply. There\nis no separate agent to hand off to; do this yourself.\n\n## 1. Which mailbox\n\nAsk which mailbox to send from if it isn't obvious from context \u2014 don't assume. The owner's\nconnected mailboxes, and which audience each is for, are in my own voice section; when it has\nto be right rather than remembered, `identity_my_addresses` is the registry of what is actually\nenrolled. Pass whichever one I picked as `account` on every Gmail tool call below.\n\n## 2. Do-not-contact check\n\nBefore drafting anything, look up the person (`twenty_lookup` / `twenty_get_person`). If\n`doNotContact` is true, stop and tell the owner why \u2014 never draft or send to a flagged person.\n\n## 3. Research\n\nResearch the target company with `read_url` on their site. If you have an outside tool for\ncompany data, use it too. This is best-effort \u2014 a miss on research never blocks drafting; note\nwhat you couldn't find and proceed with what you have.\n\n## 4. Draft\n\nCall `voice_guide` with a one-line description of what the email is about, the `account`\nyou picked in \u00a71, and the recipient's language if known. The `account` matters: examples\ncome from that mailbox's own sent mail, because tone shifts by audience and each mailbox has\nits own. Follow its `voiceGuide` instructions and use\nits `exampleEmails` for tone if any came back \u2014 both may be empty if no voice profile is set\nup yet, in which case draft normally, briefly and personally, referencing something real\nfrom the research.\n\n## 5. Send \u2014 the tool call IS the approval card\n\nCall `gmail_send` with the drafted subject/body and the chosen `account`. This is gated\n(`approval: always()`) \u2014 calling it renders the owner's \ud83d\udc4d/\ud83d\udc4e card directly. Do not ask \"should I\nsend this?\" first; the tool call itself is the ask. Do not fabricate a threadId or pretend it\nsent before the approval resolves.\n\n## 6. After a successful send\n\nOnce `gmail_send` returns (meaning it was approved and actually sent), do both of these:\n\n- Call `outreach_track` with the returned `threadId` AND `sentAt`, the `account` you sent\n  from, and the Twenty `personId` if you have one. `sentAt` anchors reply-detection to the\n  actual send time \u2014 omitting it can make a very fast reply invisible. This starts automatic\n  reply-watching \u2014 you do not need to wait around in this conversation for a reply; a\n  separate schedule checks for one and will start a fresh conversation with the owner when it\n  finds one.\n- Call `twenty_comm_state` with `state: \"email_sent\"` on the person record (only if you have\n  a `recordId` \u2014 skip silently if you don't, don't block on it).\n\n## What happens next\n\nWhen a reply arrives, the reply-watch schedule starts a new conversation instructing you to\ntriage it (positive / negative / meeting_request / unsubscribe / not_now / bounce) and, for\npositive or meeting_request, draft a reply \u2014 same voice-guide-then-gated-send shape as above.\nYou do not need to do anything proactively here; just handle that conversation normally when\nit starts.\n";

export default defineDynamic(async (ctx) => {
  const privateConsole = await verifyPrivateConsoleSession(ctx);
  const offered = await instructionSkillOffered("sales-outreach", {
    privateConsole,
    memo: (key, fn) => ctx.memo(key, fn),
    definition: async () => manifestViewOf((await thisAgent(ctx.session?.id)).loaded.definition),
  });
  return offered ? defineSkill({ description, content }) : null;
});
