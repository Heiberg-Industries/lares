"use server";
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { pool } from "../../lib/db";
import { verify } from "../../lib/auth";

async function requireUser(): Promise<string> {
  const email = await verify((await cookies()).get("lares_session")?.value);
  if (!email) throw new Error("unauthenticated");
  return email;
}

/** A card id is `default` or a row that already exists (a mailbox seeded by sql/033 or by its
 *  first voice-learn run). Anything else is refused — a typo must not create a stray card. */
async function requireCardId(id: string): Promise<string> {
  if (id === "default") return id;
  const { rows } = await pool.query(`SELECT 1 FROM voice_profile WHERE id = $1`, [id]);
  if (rows.length === 0) throw new Error(`unknown voice card: ${id}`);
  return id;
}

export async function saveCard(input: { id: string; core: string; english: string; norsk: string }): Promise<void> {
  const email = await requireUser();
  await pool.query(
    `UPDATE voice_profile SET core = $1, english = $2, norsk = $3, updated_by = $4, updated_at = now() WHERE id = $5`,
    [input.core, input.english, input.norsk, email, await requireCardId(input.id)],
  );
  revalidatePath("/voice");
}

export async function saveSettings(input: { lookbackDays: number; cap: number }): Promise<void> {
  const email = await requireUser();
  if (!Number.isInteger(input.lookbackDays) || input.lookbackDays < 1 || input.lookbackDays > 3650 ||
      !Number.isInteger(input.cap) || input.cap < 1 || input.cap > 300)
    throw new Error("Choose 1–3650 lookback days and a message cap of 1–300.");
  await pool.query(
    `UPDATE voice_profile SET learn_lookback_days = $1, learn_cap = $2,
            updated_by = $3, updated_at = now() WHERE id = 'default'`,
    [input.lookbackDays, input.cap, email],
  );
  revalidatePath("/voice");
}

export async function acceptProposed(input: { id: string }): Promise<void> {
  const email = await requireUser();
  await pool.query(
    `UPDATE voice_profile SET core = proposed->>'core', english = proposed->>'english', norsk = proposed->>'norsk',
            proposed = NULL, updated_by = $1, updated_at = now()
     WHERE id = $2 AND proposed IS NOT NULL`,
    [email, await requireCardId(input.id)],
  );
  revalidatePath("/voice");
}

export async function dismissProposed(input: { id: string }): Promise<void> {
  await requireUser();
  await pool.query(`UPDATE voice_profile SET proposed = NULL WHERE id = $1`, [await requireCardId(input.id)]);
  revalidatePath("/voice");
}

export async function setExampleIncluded(input: { id: string; included: boolean }): Promise<void> {
  await requireUser();
  await pool.query(`UPDATE voice_exemplar SET included = $2 WHERE id = $1`, [input.id, input.included]);
  revalidatePath("/voice");
}

export async function requestRelearn(): Promise<void> {
  await requireUser();
  await pool.query(`UPDATE voice_profile SET relearn_requested_at = now() WHERE id = 'default'`);
  revalidatePath("/voice");
}
