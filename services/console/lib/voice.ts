// Read layer for the email voice. Reads the same voice_profile / voice_exemplar tables the
// runtime uses. No secrets reach the DTO (learn_key is a NAME, not a value).
//
// ORB-176 (sql/033): one card per MAILBOX. `default` is the shared fallback card and carries the
// learn settings; every enrolled mailbox has its own row, proposal and learn status.
import { pool } from "./db";
import type { VoiceCardDTO, VoiceExampleDTO, VoiceProposed } from "./contracts";

export interface VoiceCardRow {
  id: string;
  core: string; english: string; norsk: string;
  model_en: string | null; model_no: string | null;
  learn_key: string; learn_lookback_days: number; learn_cap: number;
  learn_status: string; learn_message: string;
  proposed: VoiceProposed | null;
}

const EMPTY_DEFAULT: VoiceCardRow = {
  id: "default", core: "", english: "", norsk: "", model_en: null, model_no: null,
  learn_key: "saga", learn_lookback_days: 365, learn_cap: 300, learn_status: "idle", learn_message: "", proposed: null,
};

function toDTO(r: VoiceCardRow): VoiceCardDTO {
  return {
    id: r.id,
    core: r.core ?? "", english: r.english ?? "", norsk: r.norsk ?? "",
    modelEn: r.model_en ?? "", modelNo: r.model_no ?? "",
    learnKey: r.learn_key ?? "saga", lookbackDays: r.learn_lookback_days ?? 365, cap: r.learn_cap ?? 300,
    learnStatus: r.learn_status ?? "idle", learnMessage: r.learn_message ?? "",
    proposed: r.proposed ?? null,
  };
}

/** Pure: `default` first (synthesised empty when the table has none, so the page always has a
 *  shared card to edit), then every mailbox alphabetically. The only place ordering is decided. */
export function orderVoiceCards(rows: readonly VoiceCardRow[]): VoiceCardDTO[] {
  const def = rows.find((r) => r.id === "default") ?? EMPTY_DEFAULT;
  const mailboxes = rows.filter((r) => r.id !== "default").sort((a, b) => a.id.localeCompare(b.id));
  return [def, ...mailboxes].map(toDTO);
}

export async function getVoiceCards(): Promise<VoiceCardDTO[]> {
  const { rows } = await pool
    .query<VoiceCardRow>(
      `SELECT id, core, english, norsk, model_en, model_no, learn_key, learn_lookback_days, learn_cap,
              learn_status, learn_message, proposed FROM voice_profile`,
    )
    .catch(() => ({ rows: [] as VoiceCardRow[] }));
  return orderVoiceCards(rows);
}

export async function listVoiceExamples(limit = 200): Promise<VoiceExampleDTO[]> {
  const { rows } = await pool
    .query<{ id: string; lang: "en" | "no"; text: string; included: boolean }>(
      `SELECT id, lang, text, included FROM voice_exemplar ORDER BY created_at DESC LIMIT $1`,
      [limit],
    )
    .catch(() => ({ rows: [] }));
  return rows.map((r) => ({ id: r.id, lang: r.lang, included: r.included, snippet: r.text.replace(/\s+/g, " ").slice(0, 140) }));
}
