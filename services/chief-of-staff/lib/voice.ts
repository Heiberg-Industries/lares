/**
 * Pure helpers for the shared email voice: detect the language of a message, assemble the
 * prompt "voice block" (Core + the matching language section), and pick the per-language
 * model. No I/O — DB access lives in lib/voice-store.ts.
 *
 * Lang + detectLanguage moved to @lares/compose-contract — this file forked them
 * byte-for-byte from services/agent-runtime/lib/voice/profile.ts; re-exported here so
 * existing importers are unaffected.
 */
import { detectLanguage, type Lang } from "@lares/compose-contract";

export { detectLanguage, type Lang };

export interface VoiceProfile {
  core: string;
  notesEn: string;
  notesNo: string;
  modelEn: string | null;
  modelNo: string | null;
}

export interface VoiceCardRow { id: string; core: string; notes_en: string; notes_no: string }

/**
 * one card per mailbox. The singleton card was learned mostly from one mailbox's sales
 * mail and applied to another mailbox's mail to a journalist. The mailbox's own row wins when it says
 * anything at all; an empty row (a mailbox that has not learned yet) falls back to `default`;
 * no card anywhere → null, so callers degrade to drafting without a voice guide. Another
 * mailbox's card is never a fallback — that is the mixing this exists to end.
 */
export function pickCard(rows: readonly VoiceCardRow[], mailbox: string): Pick<VoiceProfile, "core" | "notesEn" | "notesNo"> | null {
  const hasText = (r: VoiceCardRow) => [r.core, r.notes_en, r.notes_no].some((v) => (v ?? "").trim() !== "");
  const own = rows.find((r) => r.id === mailbox);
  const chosen = own && hasText(own) ? own : rows.find((r) => r.id === "default" && hasText(r));
  return chosen ? { core: chosen.core ?? "", notesEn: chosen.notes_en ?? "", notesNo: chosen.notes_no ?? "" } : null;
}

/** The voice instruction injected into a draft prompt. "" when there is nothing to say
 *  (no profile, or an all-empty card) so callers degrade to today's behaviour. */
export function buildVoiceBlock(profile: VoiceProfile | null, lang: Lang, ownerName?: string | null): string {
  if (!profile) return "";
  const section = lang === "no" ? profile.notesNo : profile.notesEn;
  const parts = [profile.core?.trim(), section?.trim()].filter((s): s is string => !!s);
  if (parts.length === 0) return "";
  const who = ownerName?.trim() || "the owner";
  return (
    `Write in ${who}'s own email voice — this email is from ${who} personally. ` +
    `Follow this voice guide:\n${parts.join("\n\n")}`
  );
}

/** The per-language model id, or the fallback (the agent's default) when unset/blank. */
export function pickModel(profile: VoiceProfile | null, lang: Lang, fallback?: string): string | undefined {
  const m = lang === "no" ? profile?.modelNo : profile?.modelEn;
  return m && m.trim() ? m : fallback;
}
