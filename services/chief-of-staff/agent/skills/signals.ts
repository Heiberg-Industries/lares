import { defineDynamic, defineSkill } from "eve/skills";
import { verifyPrivateConsoleSession } from "@lares/agent-kit/private-console-surface";

export default defineDynamic({ events: { "session.started": async (_event, ctx) =>
  await verifyPrivateConsoleSession(ctx) ? null : defineSkill({ description: "Read the operational signal spine when asked what is alerting, what broke, or what the spine saw about something.", markdown: "# Signals\n\nCall `agent-kit__signals_recent` first whenever the owner asks whether anything is alerting,\nwhat broke, or what the spine saw about a project or event. Never answer all-clear from memory.\n\nAnswer from the returned cards in their compact shape: `severity \u00b7 [project] title \u00b7 when \u00b7\nissue reference`, adding the count when it is greater than one and saying when a signal recovered.\nAn empty `cards` list is a real empty answer. If the result has `unavailable`, say plainly that\nthe spine could not be read; never turn unavailable into \u201cnothing is alerting\u201d.\n" })
} });
