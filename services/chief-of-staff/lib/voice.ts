/**
 * Pure helpers for the shared email voice: detect the language of a message, assemble the
 * prompt "voice block" (Core + the matching language section), and pick the per-language
 * model. No I/O — DB access lives in lib/voice-store.ts.
 *
 * Lang + detectLanguage moved to @lares/compose-contract (ORB-94) — this file forked them
 * byte-for-byte from services/agent-runtime/lib/voice/profile.ts; re-exported here so
 * existing importers are unaffected.
 */
import { detectLanguage, type Lang } from "@lares/compose-contract";

export { detectLanguage, type Lang };

export interface VoiceProfile {
  core: string;
  english: string;
  norsk: string;
  modelEn: string | null;
  modelNo: string | null;
}

export interface VoiceCardRow { id: string; core: string; english: string; norsk: string }

/**
 * ORB-176 — one card per mailbox. The singleton card was learned mostly from project.example sales
 * mail and applied to owner.example mail to a journalist. The mailbox's own row wins when it says
 * anything at all; an empty row (a mailbox that has not learned yet) falls back to `default`;
 * no card anywhere → null, so callers degrade to drafting without a voice guide. Another
 * mailbox's card is never a fallback — that is the mixing this exists to end.
 */
export function pickCard(rows: readonly VoiceCardRow[], mailbox: string): Pick<VoiceCardRow, "core" | "english" | "norsk"> | null {
  const hasText = (r: VoiceCardRow) => [r.core, r.english, r.norsk].some((v) => (v ?? "").trim() !== "");
  const own = rows.find((r) => r.id === mailbox);
  const chosen = own && hasText(own) ? own : rows.find((r) => r.id === "default" && hasText(r));
  return chosen ? { core: chosen.core ?? "", english: chosen.english ?? "", norsk: chosen.norsk ?? "" } : null;
}

/** The voice instruction injected into a draft prompt. "" when there is nothing to say
 *  (no profile, or an all-empty card) so callers degrade to today's behaviour. */
export function buildVoiceBlock(profile: VoiceProfile | null, lang: Lang): string {
  if (!profile) return "";
  const section = lang === "no" ? profile.norsk : profile.english;
  const parts = [profile.core?.trim(), section?.trim()].filter((s): s is string => !!s);
  if (parts.length === 0) return "";
  return (
    `Write in Bendik's own email voice — this email is from Bendik personally. ` +
    `Follow this voice guide:\n${parts.join("\n\n")}`
  );
}

/** The per-language model id, or the fallback (the agent's default) when unset/blank. */
export function pickModel(profile: VoiceProfile | null, lang: Lang, fallback?: string): string | undefined {
  const m = lang === "no" ? profile?.modelNo : profile?.modelEn;
  return m && m.trim() ? m : fallback;
}
