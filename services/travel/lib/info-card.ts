// lib/info-card.ts — pure house-info card text.
//
// Extracted from agent/tools/info.ts (Fix Wave B, Finding 2) so agent/channels/telegram.ts can
// render the same card for a group's direct `/info` command (old Marcel bin/marcel.ts:571-575
// — routed AHEAD of the gatekeeper/budget check, never through a tool call) without creating a
// tool<->channel import cycle: agent/tools/info.ts already imports `telegramCredentials` FROM
// agent/channels/telegram.ts, so the reverse import would be circular.
//
// Ported verbatim from old Marcel's `infoCard` (`services/marcel/bin/marcel.ts:44-50`).
export const EMERGENCY_FOOTER = "Nød: 112 (politi 112, ambulanse 113 i Norge — i Frankrike: 112)";

export function infoCard(tripMd: string): string {
  const body = tripMd.trim();
  const parts = ["🏠 Husets info"];
  if (body) parts.push("", body);
  parts.push("", EMERGENCY_FOOTER);
  return parts.join("\n");
}
