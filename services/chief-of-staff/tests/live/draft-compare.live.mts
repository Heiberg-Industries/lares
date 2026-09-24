/**
 * tests/live/draft-compare.live.mts — the SAME-THREAD comparison ORB-176 asks for.
 *
 * "A before/after comparison on the SAME real threads, so 'better' is demonstrated rather than
 * asserted." For each of the last N inbound messages the triage drafted a reply to, this renders
 * TWO drafts through the live `writer` purpose and writes both to one markdown file for Bendik
 * to judge:
 *
 *   A — the pre-2026-09-08 prompt, copied verbatim below as `legacyPrompt()` so A stays A, with
 *       the shared `default` voice card (what every draft used until today).
 *   B — `buildReplyPrompt` (lib/reply-prompt.ts) with the MAILBOX's own card (sql/033) and the
 *       mailbox's own examples.
 *
 * Both sides get the same message, the same examples and NO CRM/thread/dossier context: those
 * blocks are identical between A and B, so leaving them out of both keeps the comparison about
 * the two things that changed — the prompt and the card — at a lower absolute quality than the
 * real drafter. Nothing is drafted into Gmail; nothing is sent.
 *
 * NOT part of `pnpm test` — it needs the box's Gmail OAuth session, the gateway key and the
 * database, so it runs INSIDE the eve-saga container. Two container facts shape the recipe
 * (measured 2026-09-08): the rootfs is read-only, so `docker cp` INTO it is refused and the script
 * cannot be dropped next to the source tree; and `/tmp` is a tmpfs, which `docker cp` OUT cannot
 * see either. So: transpile the entry on the Mac, feed it over stdin with the source tree as the
 * working directory (bare imports resolve up to /app/node_modules; the tsx loader handles the
 * `.ts` files it imports), and read the result back with `docker exec cat`:
 *
 *   pnpm exec esbuild services/chief-of-staff/tests/live/draft-compare.live.mts --format=esm --platform=node \
 *     --target=node24 > /tmp/draft-compare.entry.mjs && scp /tmp/draft-compare.entry.mjs root@<box>:/tmp/
 *   # on the box, in /opt/agent-box:
 *   docker compose exec -T -w /app/services/chief-of-staff/tests/live eve-saga sh -c \
 *     'export PGPASSWORD=$(cat /run/secrets/db_password) DATABASE_URL=postgres://lares@db:5432/lares_state; \
 *      node --import /app/node_modules/tsx/dist/esm/index.mjs --input-type=module - --last 6 --out /tmp/draft-compare.md' \
 *     < /tmp/draft-compare.entry.mjs
 *   docker exec agent-box-eve-saga-1 cat /tmp/draft-compare.md > /srv/agent/draft-compare-$(date +%F).md
 *
 * Cost: 2 × N writer calls (Fable 5.1 via the gateway), about $0.10 each on these inputs.
 */
import { writeFileSync } from "node:fs";
import { contractClauses } from "@lares/compose-contract";
import { getPool } from "@lares/agent-kit/db";

import { googleClients } from "../../lib/google.js";
import { gatewayComplete } from "../../lib/llm-complete.js";
import { buildReplyPrompt } from "../../lib/reply-prompt.js";
import { detectLanguage, buildVoiceBlock } from "../../lib/voice.js";
import { loadVoiceProfile, makeDbVoiceAccess } from "../../lib/voice-store.js";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

/** The prompt every draft used before 2026-09-08 (lib/email-triage.ts, verbatim). */
function legacyPrompt(i: {
  account: string; lang: "en" | "no"; voiceBlock: string; examples: string[];
  from: string; subject: string; body: string;
}): string {
  const voiceClause =
    (i.voiceBlock ? `\n\n${i.voiceBlock}` : "") +
    (i.examples.length > 0 ? `\n\nMatch the voice and style of these past emails:\n${i.examples.join("\n---\n")}` : "");
  const closing = `\n\nDo NOT write any closing line or sign-off (no "Mvh", no name) — the mailbox signature is appended automatically after your text. End with your final sentence.\n`;
  return (
    `Write a brief, warm, specific reply from ${i.account} to this email. Use the labeled context below if useful.\n` +
    `\n${contractClauses({ lang: i.lang, noCommitments: true })}\n` +
    voiceClause +
    closing +
    `\nOriginal — From: ${i.from}\nSubject: ${i.subject}\n\n${i.body}\n\n` +
    `Return ONLY the reply in exactly: "Subject: <subject>\\n\\n<body>" — no commentary, no placeholders like "[Name]".`
  );
}

const CLOSING_B = `Do NOT write any closing line or sign-off (no "Mvh", no name) — the mailbox signature is appended automatically after your text. End with your final sentence.`;

async function main(): Promise<void> {
  const last = Number(arg("last", "6"));
  const out = arg("out", `/tmp/draft-compare-${new Date().toISOString().slice(0, 10)}.md`);
  const pool = getPool();

  const { rows } = await pool.query<{ mailbox: string; gmail_message_id: string; processed_at: string }>(
    `SELECT mailbox, gmail_message_id, processed_at FROM email_triage_processed
      WHERE outcome = 'drafted' ORDER BY processed_at DESC LIMIT $1`,
    [last],
  );
  console.log(`draft-compare: ${rows.length} drafted message(s) to compare`);

  const sections: string[] = [
    `# Draft comparison — ${new Date().toISOString()}`,
    "",
    "A = pre-2026-09-08 prompt + shared `default` card. B = `buildReplyPrompt` + the mailbox's own card.",
    "Same message, same examples, no CRM/thread context on either side. Nothing was drafted into Gmail.",
    "",
  ];

  const defaultCard = await loadVoiceProfile(pool, "default");

  for (const r of rows) {
    const gmail = await googleClients(process.env["GOOGLE_PRINCIPAL_ID"]).gmail(r.mailbox);
    const msg = await gmail.read(r.gmail_message_id);
    if (!msg) { console.warn(`draft-compare: ${r.gmail_message_id} not readable — skipped`); continue; }
    const lang = detectLanguage(msg.bodyText || msg.subject);
    const voice = makeDbVoiceAccess({ db: pool, mailbox: r.mailbox });
    const examples = await voice.retrieve(`reply to: ${msg.bodyText}`, 3, lang).catch(() => [] as string[]);
    const mailboxCard = await voice.getProfile();
    const body = msg.bodyText.slice(0, 4000);

    const promptA = legacyPrompt({
      account: r.mailbox, lang, voiceBlock: buildVoiceBlock(defaultCard, lang), examples,
      from: msg.from, subject: msg.subject, body,
    });
    const promptB = buildReplyPrompt({
      account: r.mailbox, lang, voiceBlock: buildVoiceBlock(mailboxCard, lang), examples, contextBlocks: "",
      closing: CLOSING_B, original: { from: msg.from, subject: msg.subject, body },
    });

    const [a, b] = await Promise.all([
      gatewayComplete(promptA, { purpose: "writer" }),
      gatewayComplete(promptB, { purpose: "writer" }),
    ]);
    console.log(`draft-compare: ${r.mailbox} ${msg.subject.slice(0, 60)} — A ${a.length} chars, B ${b.length} chars`);

    sections.push(
      `## ${msg.subject}`,
      `From: ${msg.from} · mailbox: ${r.mailbox} · lang: ${lang} · examples: ${examples.length} · mailbox card: ${mailboxCard && defaultCard && mailboxCard.core === defaultCard.core && mailboxCard.norsk === defaultCard.norsk && mailboxCard.english === defaultCard.english ? "default (mailbox card empty)" : mailboxCard ? "own" : "none"}`,
      "",
      "### Original (trimmed)",
      "```",
      body.slice(0, 1200),
      "```",
      "### A — before",
      "```",
      a,
      "```",
      "### B — after",
      "```",
      b,
      "```",
      "",
    );
  }

  writeFileSync(out, sections.join("\n"), "utf8");
  console.log(`draft-compare: wrote ${out}`);
  await pool.end();
}

main().catch((err) => {
  console.error("draft-compare: failed", err);
  process.exit(1);
});
