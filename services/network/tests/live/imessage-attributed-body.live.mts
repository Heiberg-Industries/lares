/**
 * tests/live/imessage-attributed-body.live.mts — the LIVE sweep for iMessage attributedBody decoding (ORB-162).
 *
 * NOT part of `pnpm test`, and deliberately so: it reads the real macOS Messages database.
 * Run it by hand whenever you modify the decodeAttributedBody function:
 *
 *     npx tsx services/network/tests/live/imessage-attributed-body.live.mts
 *
 * WHY THIS FILE EXISTS AT ALL. In 2025, macOS Messages moved the message body from the `text`
 * column to a binary NSAttributedString stored in `attributedBody`. The format is undocumented.
 * A test fixture suite can only re-confirm the same assumption — they cannot discover a NEW case
 * the format produces. This sweep runs against production data (your actual messages) and is the
 * ONLY instrument capable of finding the truth.
 *
 * Every deployment must verify BOTH DIRECTIONS: (a) when both text and attributedBody exist,
 * they must be byte-identical (no data loss), and (b) when text is NULL, attributedBody must
 * decode successfully. A decoder that leaks silently is worse than one that returns null.
 *
 * Exit code is 0 only when every dual-field row matches AND at least 95% of messages decode.
 * Exit code 1 means one of those acceptance criteria failed; exit code 2 means the database
 * could not be opened (Full Disk Access may be required on your Mac).
 */
import Database from "better-sqlite3";
import { decodeAttributedBody } from "../../lib/importers/attributed-body.js";
import { APPLE_EPOCH_OFFSET_S } from "../../lib/importers/imessage.js";

let db: Database.Database;
try {
  const chatDbPath = `${process.env.HOME}/Library/Messages/chat.db`;
  db = new Database(chatDbPath, { readonly: true });
} catch (e) {
  console.error(`Cannot open ~/Library/Messages/chat.db: ${(e as Error).message}`);
  console.error("(Does this session have macOS Full Disk Access?)");
  process.exit(2);
}

try {
  // Selection 1: Rows carrying BOTH fields (rare in 2025+; these go back in time).
  // If both exist, text and decoded attributedBody must be byte-identical.
  const dual = db
    .prepare(
      `SELECT text, attributedBody FROM message
       WHERE text IS NOT NULL AND attributedBody IS NOT NULL
       ORDER BY date DESC LIMIT 200`
    )
    .all() as { text: string | null; attributedBody: Buffer }[];

  let dualOk = 0;
  let dualFail = 0;
  for (const r of dual) {
    const decoded = decodeAttributedBody(r.attributedBody);
    if (decoded !== null && decoded === r.text) {
      dualOk++;
    } else {
      dualFail++;
    }
  }

  // Selection 2: Top 500 rows overall (representative of recent usage).
  // Every row with attributedBody should decode (even if text is NULL).
  const recent = db
    .prepare(
      `SELECT attributedBody FROM message
       WHERE attributedBody IS NOT NULL
       ORDER BY date DESC LIMIT 500`
    )
    .all() as { attributedBody: Buffer }[];

  let decodedCount = 0;
  for (const r of recent) {
    if (decodeAttributedBody(r.attributedBody) !== null) {
      decodedCount++;
    }
  }

  // Percentage of last 30 days that have text IS NULL (context: how common is attributedBody?).
  // message.date is nanoseconds since Apple epoch (2001-01-01), so convert Unix timestamp properly.
  const thirtyDaysAgo = (Date.now() / 1000 - 30 * 86400 - APPLE_EPOCH_OFFSET_S) * 1e9;
  const lastMonth = db
    .prepare(`SELECT COUNT(*) as total, SUM(CASE WHEN text IS NULL THEN 1 ELSE 0 END) as nullText FROM message WHERE date > ?`)
    .get(thirtyDaysAgo) as { total: number; nullText: number };

  const nullTextPercent = lastMonth.total > 0 ? Math.round((lastMonth.nullText / lastMonth.total) * 100) : 0;

  console.log("--- DUAL-FIELD ROWS (top 200 where text IS NOT NULL AND attributedBody IS NOT NULL) ---");
  console.log(`  rows=${dual.length}  matching=${dualOk}  mismatched=${dualFail}`);

  console.log("\n--- RECENT MESSAGES (top 500 overall with attributedBody) ---");
  console.log(`  rows=${recent.length}  decoded=${decodedCount}  failed=${recent.length - decodedCount}`);

  console.log("\n--- CONTEXT (last 30 days) ---");
  console.log(`  total_messages=${lastMonth.total}  with_text_IS_NULL=${lastMonth.nullText} (${nullTextPercent}%)`);

  // Acceptance criteria.
  const allDualMatch = dualFail === 0;
  const decodeRate = recent.length > 0 ? decodedCount / recent.length : 0;
  const passDecoding = decodeRate >= 0.95;

  console.log(`\n=== allDualMatch=${allDualMatch}  decodeRate=${(decodeRate * 100).toFixed(1)}% ===`);
  if (!allDualMatch) {
    console.log(`FAIL — dual-field mismatch count: ${dualFail}`);
    process.exit(1);
  }
  if (!passDecoding) {
    console.log(`FAIL — decode rate ${(decodeRate * 100).toFixed(1)}% < 95% threshold`);
    process.exit(1);
  }
  console.log("PASS — all dual-field rows match and decode rate ≥ 95%");
  process.exit(0);
} finally {
  db.close();
}
