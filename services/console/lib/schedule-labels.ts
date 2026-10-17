/** Display names for schedule keys; the saved keys remain unchanged. */
export function scheduleLabel(key: string): string {
  return key
    .split("-")
    .map((part) => part === "crm" ? "CRM" : part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/**
 * One plain sentence per schedule: what it does and when. Edit the words here and every place
 * that shows a schedule (agent page, agent editor, "when do the agents speak") follows. Each one
 * is taken from the schedule's own code in services/chief-of-staff/agent/schedules/; "by default"
 * marks a time the owner can move on the Proactivity page.
 */
export const SCHEDULE_EXPLANATIONS: Readonly<Record<string, string>> = Object.freeze({
  "morning-brief": "Every morning (8:00 by default, on your clock), a short list of what is on your plate today and what has changed since last night. Nothing is sent on a quiet morning.",
  "evening-brief": "Every evening (20:00 by default), a heads-up about tomorrow's meetings with other people and what you owe them. Nothing is sent when there is nothing to prepare.",
  digest: "Twice a day (9:00 and 17:00 by default), files your newly saved links into your notes and sends you one short summary.",
  "weekly-summary": "Every Sunday (9:00 by default), a short summary of what the agent has learned about how you like things done. Skipped when it has learned nothing yet.",
  "crm-routing": "Three times a day (9:00, 13:00 and 17:00 by default), looks for contacts with new meetings or emails and suggests which sales pipeline and stage they belong in. You approve each change.",
  deadlines: "Raises the deadlines you have recorded: a nudge at 15:00 the day before, another at 09:00 on the day (official deadlines only), and a last note the day after, then it stops.",
  "email-triage": "About every minute, checks your connected inboxes for new mail from the last two days, sorts it and prepares draft replies where useful.",
  "meeting-followup": "Every five minutes, looks for meetings that now have a summary and attendees, and prepares a recap email with the action items. Nothing is sent until you approve it.",
  "outreach-reply-watch": "Every 15 minutes, watches the outreach threads you are tracking for a reply, and tells you what came back and what to do next. A thread nobody answers is dropped after a while.",
  "proposals-watch": "About every minute, checks for suggestions that are waiting for your yes or no, and tells you about the new ones in one message.",
  reminders: "About every minute, delivers reminders that have come due, at the time you set. During do-not-disturb they wait and arrive when it ends.",
  reping: "Every 30 minutes, nudges you when someone writes again about a message you have not answered. There is a daily limit, so it cannot flood you.",
  "telegram-handover": "Every night at midnight, writes a short summary of the day's Telegram conversation, so tomorrow's first message starts with the context.",
  "clipping-requests": "About every minute, answers what you asked on the Clipping page, such as reading a Notion list, testing its columns or importing now.",
  "conversation-prune": "Off unless you turn it on. Every night at 04:00, deletes conversation history older than your retention period. Sends you nothing.",
  dream: "Every night (3:00 by default), reads the day's conversations, decides what is worth remembering and saves it as notes. Anything it is unsure about waits as a suggestion for you. Sends you nothing.",
  "voice-learn": "Every Sunday at 4:00 by default, learns how you write from your sent mail, so drafts sound like you. Runs once a week for each connected mailbox.",
  "owner-clock": "Every 30 minutes, reads the time zone on your Slack profile, so schedules follow you when you travel. Sends you nothing.",
});

/** The sentence for a schedule, or an empty string for one the console has no words for. */
export function scheduleExplanation(key: string): string {
  return SCHEDULE_EXPLANATIONS[key] ?? "";
}
