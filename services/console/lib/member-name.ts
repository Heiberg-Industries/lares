import { pool } from "./db";

/** The signed-in person's name, for the foot of the menu. Display only: it is never used to find,
 * admit or authorise anyone. Null when it is blank or cannot be read, and the menu then shows no name. */
export async function memberDisplayName(memberId: string): Promise<string | null> {
  try {
    const { rows } = await pool.query<{ display_name: string | null }>(
      "SELECT display_name FROM users WHERE id=$1 AND status='active'", [memberId]);
    return rows[0]?.display_name?.trim() || null;
  } catch {
    return null;
  }
}
