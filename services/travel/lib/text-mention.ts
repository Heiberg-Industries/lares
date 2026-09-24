// lib/text-mention.ts — @mention detection/stripping, ported verbatim from old Marcel's
// lib/text.ts (`services/marcel/lib/text.ts:37-42`).
//
// `tests/text.test.ts`'s own top-of-file comment previously stated these had "NO port anywhere
// in eve-marcel... a deliberate architecture difference from old Marcel's bin/marcel.ts, not an
// oversight." That was true at the time it was written, but the whole-branch review (Fix Wave
// B, Finding 2) found the underlying gap it described — tagged/replied-to group messages could
// still be silenced by the gatekeeper's quiet-hours/rate-cap gate, and `/info`/`husk:` were
// unreachable in groups — WAS a real regression against old Marcel, not an intentional
// simplification. `agent/channels/telegram.ts`'s group dispatch now uses these to detect a
// tagged message ahead of the gate, exactly like old Marcel's `bin/marcel.ts:578`.
export function mentionsBot(text: string, botUsername: string): boolean {
  return new RegExp(`@${botUsername}\\b`, "i").test(text);
}

export function stripMention(text: string, botUsername: string): string {
  return text.replace(new RegExp(`@${botUsername}\\b[,:]?\\s*`, "gi"), "").trim();
}
